(function initBackgroundWsModule(globalScope) {
  function createBackgroundWsModule({
    state,
    authModule,
    wsReconnectDelayMs,
    sendWsMaxRetries,
    jobsWsReconnectDelayMs,
    jobsWsMaxRetries,
    jobsWsDisableMs,
    wsPullGraceMs,
  }) {
    let sendWs = null;
    let wsConnected = false;
    let pendingTasksFromWs = [];
    let sendWsFailedAttempts = 0;
    let sendWsDisabledByHostLogged = false;

    let jobsWs = null;
    let jobsWsFailedAttempts = 0;
    let jobsWsDisabledUntil = 0;
    let jobsWsDisabledByHostLogged = false;

    let onSendTasksReceived = null;
    let getLoggedInUsernameFn = null;
    const wsTicketRateLimitedUntilByPath = new Map();
    const lastWsTicketRateLimitLogTsByPath = new Map();

    const WS_TASKS_BUFFER_KEY = "ws_pending_tasks_buffer";
    const WS_TASKS_BUFFER_MAX = 10;
    const WS_TICKET_FETCH_TIMEOUT_MS = 12000;
    const SEND_WS_PATH = "/api/send/ws";
    const SEND_WS_TICKET_PATH = "/api/send/ws-ticket";
    const JOBS_WS_PATH = "/ext/v2/jobs/ws";
    const JOBS_WS_TICKET_PATH = "/ext/v2/jobs/ws-ticket";

    async function fetchWithTimeout(url, options = {}, timeoutMs = WS_TICKET_FETCH_TIMEOUT_MS) {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
      try {
        return await fetch(url, { ...options, signal: controller.signal });
      } finally {
        clearTimeout(timeoutId);
      }
    }

    function parseRetryAfterMs(response) {
      const headerVal = Number(response?.headers?.get?.("retry-after") || 0);
      if (!Number.isFinite(headerVal) || headerVal <= 0) return 0;
      return Math.max(1000, Math.round(headerVal * 1000));
    }

    function getTicketRateLimitWaitMs(path) {
      const key = String(path || "").trim() || "ticket";
      const until = Number(wsTicketRateLimitedUntilByPath.get(key) || 0) || 0;
      const now = Date.now();
      if (until <= now) {
        wsTicketRateLimitedUntilByPath.delete(key);
        return 0;
      }
      return until - now;
    }

    function applyTicketRateLimit(path, retryAfterMs = 0) {
      const key = String(path || "").trim() || "ticket";
      const waitMs = Math.max(4000, Number(retryAfterMs || 0));
      const until = Date.now() + waitMs;
      const current = Number(wsTicketRateLimitedUntilByPath.get(key) || 0) || 0;
      wsTicketRateLimitedUntilByPath.set(key, Math.max(current, until));
      return waitMs;
    }

    function buildApiUrl(baseUrl, apiPath) {
      const url = new URL(String(baseUrl || "").trim());
      const prefixRaw = String(url.pathname || "").trim();
      const prefix =
        !prefixRaw || prefixRaw === "/"
          ? ""
          : prefixRaw.endsWith("/")
            ? prefixRaw.slice(0, -1)
            : prefixRaw;
      const cleanPath = `/${String(apiPath || "")
        .trim()
        .replace(/^\/+/, "")}`;
      url.pathname = `${prefix}${cleanPath}`.replace(/\/+/g, "/");
      url.search = "";
      url.hash = "";
      return url.toString();
    }

    function buildSocketUrl(baseUrl, wsPath, searchParams) {
      const apiUrl = new URL(buildApiUrl(baseUrl, wsPath));
      apiUrl.protocol = apiUrl.protocol === "https:" ? "wss:" : "ws:";
      if (searchParams instanceof URLSearchParams) {
        apiUrl.search = searchParams.toString();
      }
      return apiUrl.toString();
    }

    async function persistWsTasksBuffer() {
      try {
        const toStore = pendingTasksFromWs.slice(0, WS_TASKS_BUFFER_MAX);
        await chrome.storage.local.set({ [WS_TASKS_BUFFER_KEY]: toStore });
      } catch (e) {
        console.warn("[BG] Failed to persist WS tasks buffer:", e);
      }
    }

    async function loadWsTasksBuffer() {
      try {
        const data = await chrome.storage.local.get({
          [WS_TASKS_BUFFER_KEY]: [],
          dm_sender_running: false,
        });
        const buffered = Array.isArray(data[WS_TASKS_BUFFER_KEY]) ? data[WS_TASKS_BUFFER_KEY] : [];
        const shouldRestore = !!data.dm_sender_running;
        if (shouldRestore && buffered.length > 0) {
          pendingTasksFromWs = buffered.slice(-WS_TASKS_BUFFER_MAX);
          console.log("[BG] Restored", pendingTasksFromWs.length, "WS tasks from buffer");
        } else if (buffered.length > 0) {
          pendingTasksFromWs = [];
          await chrome.storage.local.set({ [WS_TASKS_BUFFER_KEY]: [] });
          console.log("[BG] Discarded stale WS tasks buffer (sender was not running)");
        }
      } catch (e) {
        console.warn("[BG] Failed to load WS tasks buffer:", e);
      }
    }

    loadWsTasksBuffer();

    function setOnSendTasksReceived(handler) {
      onSendTasksReceived = typeof handler === "function" ? handler : null;
    }

    function setGetLoggedInUsername(handler) {
      getLoggedInUsernameFn = typeof handler === "function" ? handler : null;
    }

    function resetSendWsFailures() {
      sendWsFailedAttempts = 0;
    }

    function shouldDisableWsForHost(apiBase) {
      if (!apiBase) return false;
      try {
        const host = new URL(apiBase).hostname.toLowerCase();
        return host.endsWith("trycloudflare.com");
      } catch {
        return false;
      }
    }

    async function requestWsTicket(cfg, path, payload) {
      const base = (cfg?.api_base || "").trim().replace(/\/$/, "");
      if (!base || !authModule.isSecureApiBase(base)) return null;
      const rateLimitWaitMs = getTicketRateLimitWaitMs(path);
      if (rateLimitWaitMs > 0) {
        return null;
      }
      const headers = await authModule.getAuthHeaders(cfg);
      if (!headers.Authorization) return null;
      try {
        const resp = await fetchWithTimeout(buildApiUrl(base, path), {
          method: "POST",
          headers,
          body: JSON.stringify(payload || {}),
        });
        if (!resp.ok) {
          if (resp.status === 429 || resp.status === 503) {
            const waitMs = applyTicketRateLimit(path, parseRetryAfterMs(resp));
            const key = String(path || "").trim() || "ticket";
            const now = Date.now();
            const lastLogTs = Number(lastWsTicketRateLimitLogTsByPath.get(key) || 0) || 0;
            if (now - lastLogTs >= 15000) {
              console.warn("[BG] ws ticket rate-limited:", key, "retry in", waitMs, "ms");
              lastWsTicketRateLimitLogTsByPath.set(key, now);
            }
          }
          return null;
        }
        const raw = await resp.json();
        const data =
          raw?.data && typeof raw.data === "object" && !Array.isArray(raw.data) ? raw.data : raw;
        const ticket = String(data?.ws_ticket || data?.ticket || "").trim();
        wsTicketRateLimitedUntilByPath.delete(String(path || "").trim() || "ticket");
        return ticket || null;
      } catch {
        return null;
      }
    }

    function buildWsUrl(cfg, fromAccount, wsTicket) {
      const base = (cfg.api_base || "").trim().replace(/\/$/, "");
      if (!base || !authModule.isSecureApiBase(base)) return null;
      const account = (fromAccount || "").trim();
      const ticket = (wsTicket || "").trim();
      if (!account || !ticket) return null;
      const params = new URLSearchParams({ from_account: account, ws_ticket: ticket });
      return buildSocketUrl(base, SEND_WS_PATH, params);
    }

    async function connectSendWs(cfg) {
      if (shouldDisableWsForHost(cfg?.api_base)) {
        if (!sendWsDisabledByHostLogged) {
          console.warn(
            "[BG] send WS desactivado para host trycloudflare.com; se usa fallback por HTTP pull."
          );
          sendWsDisabledByHostLogged = true;
        }
        return;
      }
      const fromAccount = getLoggedInUsernameFn ? await getLoggedInUsernameFn() : null;
      if (!fromAccount) {
        console.log("[BG] WS: no hay pestaña de Instagram con cuenta detectada (from_account)");
        return;
      }
      const wsTicket = await requestWsTicket(cfg, SEND_WS_TICKET_PATH, {
        from_account: fromAccount,
      });
      if (!wsTicket) {
        console.log("[BG] WS: no se obtuvo ticket efímero; se mantiene fallback por HTTP pull");
        return;
      }
      const url = buildWsUrl(cfg, fromAccount, wsTicket);
      if (!url) return;
      if (sendWsFailedAttempts >= sendWsMaxRetries) return;
      if (
        sendWs &&
        (sendWs.readyState === WebSocket.OPEN || sendWs.readyState === WebSocket.CONNECTING)
      ) {
        return;
      }
      try {
        sendWs = new WebSocket(url);
        sendWs.onopen = () => {
          wsConnected = true;
          sendWsFailedAttempts = 0;
          console.log("[BG] WS conectado");
          sendWs.send("pull");
        };
        sendWs.onmessage = (ev) => {
          try {
            const data = JSON.parse(ev.data);
            if (
              data &&
              data.type === "tasks" &&
              Array.isArray(data.items) &&
              data.items.length > 0
            ) {
              console.log("[BG] WS recibió", data.items.length, "tasks via push");
              pendingTasksFromWs.push(...data.items);
              if (pendingTasksFromWs.length > WS_TASKS_BUFFER_MAX) {
                pendingTasksFromWs = pendingTasksFromWs.slice(-WS_TASKS_BUFFER_MAX);
              }
              persistWsTasksBuffer();
              if (onSendTasksReceived) onSendTasksReceived(data.items);
            }
          } catch (e) {
            console.warn("[BG] WS message parse error", e);
          }
        };
        sendWs.onclose = (ev) => {
          wsConnected = false;
          sendWs = null;
          persistWsTasksBuffer();
          if (ev.code !== 1000 && state.isRunning) {
            sendWsFailedAttempts += 1;
            if (sendWsFailedAttempts >= sendWsMaxRetries) {
              console.warn(
                "[BG] WS send deshabilitado temporalmente tras errores de conexión. Se mantiene fallback por HTTP pull."
              );
              return;
            }
            console.log("[BG] WS cerrado, reconectando en", wsReconnectDelayMs, "ms");
            setTimeout(() => {
              authModule.loadSettings().then((c) => {
                if (state.isRunning && c.api_base) connectSendWs(c);
              });
            }, wsReconnectDelayMs);
          }
        };
        sendWs.onerror = () => {
          wsConnected = false;
        };
      } catch (e) {
        console.warn("[BG] WS connect error", e);
        wsConnected = false;
      }
    }

    function disconnectSendWs() {
      if (sendWs) {
        try {
          sendWs.close(1000);
        } catch {}
        sendWs = null;
      }
      wsConnected = false;
    }

    function buildJobsWsUrl(cfg, wsTicket) {
      const base = (cfg.api_base || "").trim().replace(/\/$/, "");
      const ticket = (wsTicket || "").trim();
      if (!base || !ticket || !authModule.isSecureApiBase(base)) return null;
      const params = new URLSearchParams({ ws_ticket: ticket });
      return buildSocketUrl(base, JOBS_WS_PATH, params);
    }

    function normalizeJobsWsEvent(raw) {
      if (!raw || typeof raw !== "object") return null;
      const eventType = String(raw.type || raw.event_type || "")
        .trim()
        .toLowerCase();
      const eventId = String(raw.event_id || raw.id || "").trim() || null;
      const payload = raw.payload && typeof raw.payload === "object" ? raw.payload : raw;
      if (
        eventType === "jobs_updated" ||
        eventType === "jobs.updated" ||
        eventType === "job.updated"
      ) {
        return {
          type: "jobs_updated",
          eventId,
          payload,
        };
      }
      if (eventType === "ping") {
        return {
          type: "ping",
          eventId,
          payload,
        };
      }
      return null;
    }

    function connectJobsWs(cfg) {
      if (!cfg?.api_base || !authModule.isSecureApiBase(cfg.api_base)) return;
      if (shouldDisableWsForHost(cfg.api_base)) {
        if (!jobsWsDisabledByHostLogged) {
          console.warn(
            "[BG] jobs WS desactivado para host trycloudflare.com; se usa fallback por polling."
          );
          jobsWsDisabledByHostLogged = true;
        }
        return;
      }
      if (Date.now() < jobsWsDisabledUntil) return;
      requestWsTicket(cfg, JOBS_WS_TICKET_PATH, {}).then((wsTicket) => {
        if (!wsTicket) return;
        const url = buildJobsWsUrl(cfg, wsTicket);
        if (
          !url ||
          (jobsWs &&
            (jobsWs.readyState === WebSocket.OPEN || jobsWs.readyState === WebSocket.CONNECTING))
        )
          return;
        try {
          console.log("[BG] jobs WS conectando");
          jobsWs = new WebSocket(url);
          jobsWs.onopen = () => {
            jobsWsFailedAttempts = 0;
            console.log("[BG] jobs WS conectado");
          };
          jobsWs.onmessage = (ev) => {
            try {
              const data = JSON.parse(ev.data || "{}");
              const event = normalizeJobsWsEvent(data);
              if (!event) return;
              if (event.type === "ping") {
                if (jobsWs && jobsWs.readyState === WebSocket.OPEN) {
                  jobsWs.send(JSON.stringify({ type: "pong", event_id: event.eventId }));
                }
                return;
              }
              chrome.runtime
                .sendMessage({ type: event.type, payload: event.payload, event_id: event.eventId })
                .catch(() => {});
            } catch {}
          };
          jobsWs.onclose = (ev) => {
            jobsWs = null;
            console.warn(
              "[BG] jobs WS cerrado:",
              "code=",
              ev?.code,
              "reason=",
              ev?.reason || "(sin reason)",
              "wasClean=",
              !!ev?.wasClean,
              "attempt=",
              jobsWsFailedAttempts + 1,
              "/",
              jobsWsMaxRetries
            );
            if (ev.code !== 1000) {
              jobsWsFailedAttempts += 1;
              if (jobsWsFailedAttempts >= jobsWsMaxRetries) {
                jobsWsDisabledUntil = Date.now() + jobsWsDisableMs;
                console.warn(
                  "[BG] jobs WS deshabilitado temporalmente por errores de handshake/conexión. Se seguirá con fallback por polling. Reintento automático después de",
                  Math.round(jobsWsDisableMs / 1000),
                  "s."
                );
                return;
              }
              console.warn(
                "[BG] jobs WS reintentando en",
                Math.round(jobsWsReconnectDelayMs / 1000),
                "s..."
              );
              setTimeout(() => {
                authModule.loadSettings().then((c) => {
                  if (c.api_base) connectJobsWs(c);
                });
              }, jobsWsReconnectDelayMs);
            }
          };
          jobsWs.onerror = (e) => {
            console.warn(
              "[BG] jobs WS onerror (detalle del navegador puede ser limitado):",
              e?.message || e
            );
            jobsWs = null;
          };
        } catch (e) {
          console.warn("[BG] jobs WS connect error", e);
          jobsWs = null;
        }
      });
    }

    function disconnectJobsWs() {
      if (jobsWs) {
        try {
          jobsWs.close(1000);
        } catch {}
        jobsWs = null;
      }
    }

    async function waitForWsTask(timeoutMs = wsPullGraceMs) {
      const start = Date.now();
      while (Date.now() - start < timeoutMs) {
        if (pendingTasksFromWs.length > 0) {
          const task = pendingTasksFromWs.shift();
          if (task) {
            await persistWsTasksBuffer();
            return task;
          }
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      return null;
    }

    function hasPendingWsTasks() {
      return pendingTasksFromWs.length > 0;
    }

    function shiftPendingWsTask() {
      const task = pendingTasksFromWs.shift() || null;
      if (task) {
        persistWsTasksBuffer();
      }
      return task;
    }

    function isSendWsConnected() {
      return wsConnected;
    }

    function requestSendWsPull() {
      if (sendWs && sendWs.readyState === WebSocket.OPEN) {
        sendWs.send("pull");
        return true;
      }
      return false;
    }

    return {
      setOnSendTasksReceived,
      setGetLoggedInUsername,
      resetSendWsFailures,
      shouldDisableWsForHost,
      requestWsTicket,
      buildWsUrl,
      connectSendWs,
      disconnectSendWs,
      buildJobsWsUrl,
      connectJobsWs,
      disconnectJobsWs,
      waitForWsTask,
      hasPendingWsTasks,
      shiftPendingWsTask,
      isSendWsConnected,
      requestSendWsPull,
    };
  }

  globalScope.createBackgroundWsModule = createBackgroundWsModule;
})(self);
