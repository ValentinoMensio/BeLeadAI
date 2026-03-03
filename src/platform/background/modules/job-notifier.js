(function initBackgroundJobNotifierModule(globalScope) {
  function createBackgroundJobNotifierModule({
    authModule,
    storageModule,
    minSyncGapMs = 7000,
    jobsLimit = 100,
    requestTimeoutMs = 15000,
  }) {
    const NOTIFY_STATE_KEY = "job_notify_state_v1";
    const TERMINAL_STATUSES = new Set(["completed", "failed", "canceled"]);
    const CANCELED_STATUSES = new Set(["canceled"]);
    const ACTIVE_STATUSES = new Set(["pending", "running"]);

    let notifyStateCache = null;
    let syncInFlight = null;
    let lastSyncTs = 0;
    let bootstrapDone = false;

    function normalizeStatus(status) {
      const raw = String(status || "").trim().toLowerCase();
      if (!raw) return "";
      if (raw === "queued" || raw === "open") return "pending";
      if (raw === "in_progress" || raw === "processing") return "running";
      if (raw === "done" || raw === "success") return "completed";
      if (raw === "error") return "failed";
      if (raw === "cancelled" || raw === "stopped") return "canceled";
      return raw;
    }

    function isActiveStatus(status) {
      return ACTIVE_STATUSES.has(normalizeStatus(status));
    }

    function isTerminalStatus(status) {
      return TERMINAL_STATUSES.has(normalizeStatus(status));
    }

    function bodyForKind(kind, source) {
      const kindLower = String(kind || "").trim().toLowerCase();
      if (source === "flow" || kindLower.includes("flow")) return "Flujo completado";
      if (kindLower.includes("send")) return "Envio completado";
      if (kindLower.includes("analyze")) return "Analisis completado";
      if (kindLower.includes("fetch")) return "Extraccion completada";
      return "Tarea completada";
    }

    function parseExtraJson(rawExtra) {
      if (!rawExtra) return {};
      if (typeof rawExtra === "object") return rawExtra;
      if (typeof rawExtra !== "string") return {};
      try {
        const parsed = JSON.parse(rawExtra);
        return parsed && typeof parsed === "object" ? parsed : {};
      } catch {
        return {};
      }
    }

    function extractCancelInfo(entryValue) {
      const extra = parseExtraJson(entryValue?.extra_json);
      const cancel = extra && typeof extra.cancel === "object" ? extra.cancel : null;
      const reason = String(cancel?.reason || "").trim().toLowerCase();
      return {
        canceled: !!cancel,
        cancelReason: reason,
      };
    }

    function buildOwnerKey(baseUrl, cfg, headers) {
      let host = "";
      try {
        host = new URL(baseUrl).host;
      } catch {
        host = String(baseUrl || "").trim();
      }
      const clientHeader = String(headers?.["X-Client-Id"] || "").trim();
      const fallbackClient = String(cfg?.client_id || cfg?.client_id_manual || "").trim();
      const clientKey = clientHeader || fallbackClient || "anonymous";
      return `${host}|${clientKey}`;
    }

    function buildApiUrl(baseUrl, apiPath, query = null) {
      const url = new URL(String(baseUrl || "").trim());
      const prefixRaw = String(url.pathname || "").trim();
      const prefix = !prefixRaw || prefixRaw === "/"
        ? ""
        : (prefixRaw.endsWith("/") ? prefixRaw.slice(0, -1) : prefixRaw);
      const [pathPart, queryPart = ""] = String(apiPath || "").trim().split("?");
      const cleanPath = `/${String(pathPart || "").trim().replace(/^\/+/, "")}`;
      url.pathname = `${prefix}${cleanPath}`.replace(/\/+/g, "/");
      const search = new URLSearchParams(queryPart);
      if (query && typeof query === "object") {
        Object.entries(query).forEach(([key, value]) => {
          if (value == null) return;
          search.set(key, String(value));
        });
      }
      url.search = search.toString();
      url.hash = "";
      return url.toString();
    }

    async function loadNotifyState() {
      if (notifyStateCache) return notifyStateCache;
      const data = await storageModule.storageGetLocal({ [NOTIFY_STATE_KEY]: null });
      const raw = data?.[NOTIFY_STATE_KEY];
      if (!raw || typeof raw !== "object") {
        notifyStateCache = { ownerKey: "", entries: {} };
        return notifyStateCache;
      }
      notifyStateCache = {
        ownerKey: String(raw.ownerKey || ""),
        entries: raw.entries && typeof raw.entries === "object" ? raw.entries : {},
      };
      return notifyStateCache;
    }

    async function saveNotifyState(nextState) {
      notifyStateCache = {
        ownerKey: String(nextState?.ownerKey || ""),
        entries: nextState?.entries && typeof nextState.entries === "object" ? nextState.entries : {},
      };
      await storageModule.saveState({ [NOTIFY_STATE_KEY]: notifyStateCache });
    }

    async function fetchJson(url, headers) {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), requestTimeoutMs);
      try {
        const resp = await fetch(url, {
          method: "GET",
          headers,
          signal: controller.signal,
        });
        if (!resp.ok) return null;
        const raw = await resp.json();
        if (raw?.data && typeof raw.data === "object" && !Array.isArray(raw.data)) return raw.data;
        return raw;
      } catch {
        return null;
      } finally {
        clearTimeout(timeoutId);
      }
    }

    function appendEntry(snapshotEntries, entryKey, entryValue) {
      if (!entryKey) return;
      const cancelInfo = extractCancelInfo(entryValue);
      const normalizedStatus = cancelInfo.canceled
        ? "canceled"
        : normalizeStatus(entryValue?.status);
      snapshotEntries[entryKey] = {
        id: String(entryValue?.id || ""),
        kind: String(entryValue?.kind || ""),
        source: String(entryValue?.source || "job"),
        status: normalizedStatus,
        canceled: cancelInfo.canceled,
        cancelReason: cancelInfo.cancelReason,
      };
    }

    async function fetchCurrentSnapshot() {
      const cfg = await authModule.loadSettings();
      const base = String(cfg?.api_base || "").trim().replace(/\/+$/, "");
      if (!base || !authModule.isSecureApiBase(base)) return null;

      const headers = await authModule.getAuthHeaders(cfg);
      if (!headers?.Authorization) return null;

      const ownerKey = buildOwnerKey(base, cfg, headers);
      const jobsUrl = buildApiUrl(base, "/ext/v2/jobs", { limit: jobsLimit });
      const flowsUrl = buildApiUrl(base, "/ext/v2/flows", { limit: jobsLimit });

      const [jobsPayload, flowsPayload] = await Promise.all([
        fetchJson(jobsUrl, headers),
        fetchJson(flowsUrl, headers),
      ]);

      const entries = {};
      const jobs = Array.isArray(jobsPayload?.jobs) ? jobsPayload.jobs : [];
      for (const item of jobs) {
        const id = String(item?.id || "").trim();
        if (!id) continue;
        appendEntry(entries, `job:${id}`, {
          id,
          kind: String(item?.kind || ""),
          source: "job",
          status: item?.status,
        });
      }

      const flows = Array.isArray(flowsPayload?.flows) ? flowsPayload.flows : [];
      for (const item of flows) {
        const id = String(item?.id || "").trim();
        if (!id) continue;
        appendEntry(entries, `flow:${id}`, {
          id,
          kind: "followings_flow",
          source: "flow",
          status: item?.status,
        });
      }

      return { ownerKey, entries };
    }

    function shouldNotify(prevEntry, currEntry) {
      if (!prevEntry || !currEntry) return false;
      if (!isActiveStatus(prevEntry.status)) return false;
      if (!isTerminalStatus(currEntry.status)) return false;

      const currStatus = normalizeStatus(currEntry.status);
      if (CANCELED_STATUSES.has(currStatus)) return false;
      if (currEntry.canceled) return false;
      if (String(currEntry.cancelReason || "") === "user_request") return false;

      return true;
    }

    async function createNotificationForEntry(entry) {
      if (!chrome.notifications?.create) return;
      const notificationId = `task-finished:${entry.source}:${entry.id}:${Date.now()}`;
      const body = bodyForKind(entry.kind, entry.source);
      const iconUrl = chrome.runtime?.getURL ? chrome.runtime.getURL("icons/logo.png") : "icons/logo.png";
      await new Promise((resolve) => {
        chrome.notifications.create(
          notificationId,
          {
            type: "basic",
            title: "BeLeadAI · Tarea finalizada",
            message: body,
            iconUrl,
            priority: 0,
          },
          () => resolve()
        );
      });
    }

    async function runSync({ silent = false, force = false } = {}) {
      const now = Date.now();
      if (!force && now - lastSyncTs < minSyncGapMs) {
        return { ok: true, skipped: "throttled" };
      }

      const current = await fetchCurrentSnapshot();
      if (!current) return { ok: false, skipped: "not_ready" };

      const previous = await loadNotifyState();
      const ownerChanged = !!previous.ownerKey && previous.ownerKey !== current.ownerKey;
      const prevEntries = ownerChanged ? {} : (previous.entries || {});
      const silentMode = !!silent || ownerChanged || !bootstrapDone;

      if (!silentMode) {
        const keys = Object.keys(current.entries || {});
        for (const key of keys) {
          const prevEntry = prevEntries[key];
          const currEntry = current.entries[key];
          if (shouldNotify(prevEntry, currEntry)) {
            await createNotificationForEntry(currEntry);
          }
        }
      }

      await saveNotifyState(current);
      lastSyncTs = now;
      bootstrapDone = true;
      return { ok: true };
    }

    async function triggerSync(reason = "unknown", options = {}) {
      if (syncInFlight) return syncInFlight;
      syncInFlight = (async () => {
        try {
          return await runSync({
            silent: !!options.silent,
            force: !!options.force,
            reason,
          });
        } finally {
          syncInFlight = null;
        }
      })();
      return syncInFlight;
    }

    async function bootstrapSilent() {
      return triggerSync("bootstrap", { silent: true, force: true });
    }

    return {
      bootstrapSilent,
      triggerSync,
    };
  }

  globalScope.createBackgroundJobNotifierModule = createBackgroundJobNotifierModule;
})(self);
