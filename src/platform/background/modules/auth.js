(function initBackgroundAuthModule(globalScope) {
  function createBackgroundAuthModule({ storageModule, refreshBackoffMs }) {
    let refreshInFlightPromise = null;
    let refreshBackoffUntil = 0;
    const AUTH_FETCH_TIMEOUT_MS = 15000;
    const ACCESS_SKEW_MS = 90 * 1000;
    const REFRESH_RETRY_ATTEMPTS = 3;

    function parseRetryAfterMs(resp) {
      const raw = String(resp?.headers?.get?.("Retry-After") || "").trim();
      const sec = Number(raw);
      if (Number.isFinite(sec) && sec > 0) return Math.round(sec * 1000);
      return 0;
    }

    function getClientMetadataHeaders() {
      let version = "0.0.0";
      let build = "dev-local";
      try {
        const manifest = chrome?.runtime?.getManifest?.() || {};
        const rawVersion = String(manifest.version || "").trim();
        if (rawVersion) version = rawVersion;
        const rawVersionName = String(manifest.version_name || "").trim();
        if (rawVersionName) {
          const plusIdx = rawVersionName.indexOf("+");
          if (plusIdx >= 0 && plusIdx < rawVersionName.length - 1) {
            const parsedBuild = String(rawVersionName.slice(plusIdx + 1)).trim();
            if (parsedBuild) build = parsedBuild;
          }
        }
      } catch {}
      return {
        "X-Client-Version": version,
        "X-Client-Platform": "chrome-mv3",
        "X-Client-Build": build,
      };
    }

    function backoffWithJitter(baseMs, attempt) {
      const exp = baseMs * Math.pow(2, Math.max(0, attempt - 1));
      const jitter = Math.round(Math.random() * 250);
      return Math.max(250, exp + jitter);
    }

    function sleep(ms) {
      return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms || 0))));
    }

    async function fetchWithTimeout(url, options = {}, timeoutMs = AUTH_FETCH_TIMEOUT_MS) {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
      try {
        return await fetch(url, { ...options, signal: controller.signal });
      } finally {
        clearTimeout(timeoutId);
      }
    }

    function readJwtExpMs(token) {
      const raw = String(token || "").trim();
      if (!raw) return 0;
      const parts = raw.split(".");
      if (parts.length < 2) return 0;
      try {
        const payloadB64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
        const padded = payloadB64 + "=".repeat((4 - (payloadB64.length % 4)) % 4);
        const json = atob(padded);
        const payload = JSON.parse(json);
        const expS = Number(payload?.exp || 0);
        if (!Number.isFinite(expS) || expS <= 0) return 0;
        return expS * 1000;
      } catch {
        return 0;
      }
    }

    function resolveExpiresAtMs(token, expiresInSeconds, fallbackMs = 0) {
      const expFromToken = readJwtExpMs(token);
      const expFromApi =
        Number(expiresInSeconds || 0) > 0 ? Date.now() + Number(expiresInSeconds) * 1000 : 0;
      if (expFromToken && expFromApi) return Math.min(expFromToken, expFromApi);
      if (expFromToken) return expFromToken;
      if (expFromApi) return expFromApi;
      return Number(fallbackMs || 0) || 0;
    }

    function isSecureApiBase(baseUrl) {
      try {
        return new URL((baseUrl || "").trim()).protocol === "https:";
      } catch {
        return false;
      }
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

    function unwrapApiDataEnvelope(payload) {
      if (!payload || typeof payload !== "object") return {};
      const nested = payload.data;
      if (nested && typeof nested === "object" && !Array.isArray(nested)) return nested;
      return payload;
    }

    function parseJsonSafe(text, fallback = {}) {
      try {
        return text ? JSON.parse(text) : fallback;
      } catch {
        return fallback;
      }
    }

    function normalizeApiError(status, payload, fallbackMessage = "Error de autenticación.") {
      const envelope = payload && typeof payload === "object" ? payload : {};
      const code = String(envelope?.error?.code || "").trim() || "AUTH_ERROR";
      const message = String(envelope?.error?.message || "").trim() || fallbackMessage;
      const details =
        envelope?.error?.details && typeof envelope.error.details === "object"
          ? envelope.error.details
          : null;
      return {
        code,
        message,
        details,
        status: Number(status || 0) || 0,
      };
    }

    function loadSettings() {
      return new Promise((resolve) => {
        chrome.storage.sync.get(
          { api_base: "", x_client_id: "", client_id_manual: "", client_id_source: "jwt" },
          async (syncCfg) => {
            const localLegacy = await storageModule.storageGetLocal({ client_id: "" });
            const authState = await storageModule.getAuthState();
            resolve({
              ...syncCfg,
              device_id: authState.device_id,
              access_token: authState.access_token,
              access_expires_at: Number(authState.access_expires_at || 0) || 0,
              refresh_token: authState.refresh_token,
              refresh_expires_at: Number(authState.refresh_expires_at || 0) || 0,
              client_id: authState.client_id || String(localLegacy.client_id || "").trim(),
              session_id: authState.session_id,
            });
          }
        );
      });
    }

    function getClientIdEffective(cfg) {
      const src = (cfg.client_id_source || "jwt").trim().toLowerCase();
      if (src === "manual") return (cfg.client_id_manual || "").trim();
      return (cfg.client_id || "").trim();
    }

    function isJwtValid(cfg) {
      const token = String(cfg?.access_token || "").trim();
      if (!token) return false;
      const expMs = readJwtExpMs(token) || Number(cfg?.access_expires_at || 0) || 0;
      return expMs > Date.now() + ACCESS_SKEW_MS;
    }

    async function getOrCreateDeviceId() {
      const auth = await storageModule.getAuthState();
      if (auth.device_id) return auth.device_id;
      const newDeviceId = crypto.randomUUID();
      await storageModule.setAuthState({ device_id: newDeviceId });
      return newDeviceId;
    }

    async function persistTokenPair(data, fallbackDeviceId = "") {
      const accessToken = String(data?.access_token || "").trim();
      const refreshToken = String(data?.refresh_token || "").trim();
      const now = Date.now();
      const accessExpiresAt = resolveExpiresAtMs(accessToken, data?.expires_in, now + 600 * 1000);
      const refreshExpiresAt =
        Number(data?.refresh_expires_in || 0) > 0
          ? now + Number(data.refresh_expires_in) * 1000
          : 0;
      const clientId = data?.client_id != null ? String(data.client_id).trim() : "";
      const sessionId = data?.session_id != null ? String(data.session_id).trim() : "";
      const patch = {
        access_token: accessToken,
        access_expires_at: accessExpiresAt,
        refresh_token: refreshToken,
        refresh_expires_at: refreshExpiresAt,
        client_id: clientId,
        session_id: sessionId,
      };
      if (fallbackDeviceId) {
        patch.device_id = fallbackDeviceId;
      }
      await storageModule.setAuthState(patch);
      await chrome.storage.local.remove(["jwt_token", "jwt_expires_at"]);
      return accessToken;
    }

    async function clearTokensKeepDevice({ rotateSalt = false } = {}) {
      const current = await storageModule.getAuthState();
      await storageModule.clearAuthState({ rotateSalt: !!rotateSalt });
      await chrome.storage.local.remove(["jwt_token", "jwt_expires_at"]);
      if (current.device_id) {
        await storageModule.setAuthState({ device_id: current.device_id });
      }
    }

    async function loginWithResult(apiBase, apiKey) {
      const base = String(apiBase || "").trim();
      const key = String(apiKey || "").trim();
      if (!base || !key || !isSecureApiBase(base)) {
        return {
          ok: false,
          status: 0,
          error: normalizeApiError(0, {}, "Configuración de autenticación inválida."),
        };
      }
      const deviceId = await getOrCreateDeviceId();
      const url = buildApiUrl(base, "/api/auth/login");
      try {
        const r = await fetchWithTimeout(url, {
          method: "POST",
          headers: { "Content-Type": "application/json", ...getClientMetadataHeaders() },
          body: JSON.stringify({ api_key: key, device_id: deviceId }),
        });
        const text = await r.text();
        const raw = parseJsonSafe(text, {});
        if (!r.ok) {
          return {
            ok: false,
            status: Number(r.status || 0) || 0,
            error: normalizeApiError(r.status, raw, "No se pudo iniciar sesión."),
          };
        }
        const data = unwrapApiDataEnvelope(raw);
        if (!data?.access_token || !data?.refresh_token) {
          return {
            ok: false,
            status: 500,
            error: normalizeApiError(500, {}, "La respuesta de login no cumple el contrato."),
          };
        }
        const accessToken = await persistTokenPair(data, deviceId);
        return {
          ok: true,
          status: 200,
          accessToken,
        };
      } catch {
        return {
          ok: false,
          status: 0,
          error: normalizeApiError(0, {}, "Error de red al iniciar sesión."),
        };
      }
    }

    async function login(apiBase, apiKey) {
      const result = await loginWithResult(apiBase, apiKey);
      return result?.ok ? String(result.accessToken || "").trim() : null;
    }

    async function refresh(apiBase, refreshToken, deviceId) {
      const base = String(apiBase || "").trim();
      const rt = String(refreshToken || "").trim();
      const did = String(deviceId || "").trim();
      if (!base || !rt || !did || !isSecureApiBase(base)) {
        return { ok: false, status: 0 };
      }
      const url = buildApiUrl(base, "/api/auth/token/refresh");
      let lastStatus = 0;

      for (let attempt = 1; attempt <= REFRESH_RETRY_ATTEMPTS; attempt += 1) {
        let resp;
        try {
          resp = await fetchWithTimeout(url, {
            method: "POST",
            headers: { "Content-Type": "application/json", ...getClientMetadataHeaders() },
            body: JSON.stringify({ refresh_token: rt, device_id: did }),
          });
        } catch {
          const waitMs = backoffWithJitter(refreshBackoffMs, attempt);
          if (attempt < REFRESH_RETRY_ATTEMPTS) {
            await sleep(waitMs);
            continue;
          }
          return { ok: false, status: 0 };
        }

        lastStatus = Number(resp.status || 0) || 0;
        if (resp.ok) {
          const raw = await resp.json();
          const data = unwrapApiDataEnvelope(raw);
          if (!data?.access_token || !data?.refresh_token) return { ok: false, status: 500 };
          await persistTokenPair(data, did);
          return { ok: true, status: 200 };
        }

        if (resp.status === 401) {
          await clearTokensKeepDevice({ rotateSalt: true });
          return { ok: false, status: 401 };
        }

        if (resp.status === 429 || resp.status === 503) {
          const retryAfterMs = parseRetryAfterMs(resp);
          const waitMs = retryAfterMs || backoffWithJitter(refreshBackoffMs, attempt);
          if (attempt < REFRESH_RETRY_ATTEMPTS) {
            await sleep(waitMs);
            continue;
          }
          return { ok: false, status: resp.status };
        }

        return { ok: false, status: resp.status };
      }
      return { ok: false, status: lastStatus || 0 };
    }

    async function ensureFreshAccessToken(cfgInput = null, opts = {}) {
      const force = !!opts.force;
      const cfg = cfgInput || (await loadSettings());
      if (!force && isJwtValid(cfg)) {
        return String(cfg.access_token || "").trim() || null;
      }
      const now = Date.now();
      if (!force && now < refreshBackoffUntil) {
        return null;
      }

      if (!refreshInFlightPromise) {
        refreshInFlightPromise = (async () => {
          try {
            const freshCfg = await loadSettings();
            const refreshToken = String(freshCfg.refresh_token || "").trim();
            const deviceId =
              String(freshCfg.device_id || "").trim() || (await getOrCreateDeviceId());
            if (refreshToken) {
              const result = await refresh(freshCfg.api_base, refreshToken, deviceId);
              if (result.ok) {
                refreshBackoffUntil = 0;
                const finalCfg = await loadSettings();
                return String(finalCfg.access_token || "").trim() || null;
              }
              if (result.status === 401) {
                refreshBackoffUntil = 0;
                return null;
              }
              refreshBackoffUntil = Date.now() + backoffWithJitter(refreshBackoffMs, 1);
            }
            refreshBackoffUntil = Date.now() + backoffWithJitter(refreshBackoffMs, 1);
            return null;
          } finally {
            refreshInFlightPromise = null;
          }
        })();
      }

      return refreshInFlightPromise;
    }

    async function getAuthHeaders(cfgInput) {
      const cfg = cfgInput || (await loadSettings());
      const headers = { "Content-Type": "application/json", ...getClientMetadataHeaders() };
      let accessToken = "";

      if (isJwtValid(cfg)) {
        accessToken = String(cfg.access_token || "").trim();
      } else {
        const token = await ensureFreshAccessToken(cfg);
        accessToken = String(token || "").trim();
      }

      if (accessToken) {
        headers.Authorization = `Bearer ${accessToken}`;
      }

      const freshCfg = await loadSettings();
      const clientId = getClientIdEffective(freshCfg);
      if (clientId) headers["X-Client-Id"] = clientId;
      return headers;
    }

    async function getAuthState() {
      const cfg = await loadSettings();
      return {
        isAuthenticated: !!cfg.access_token && isJwtValid(cfg),
        accessExpiresAt: Number(cfg.access_expires_at || 0) || 0,
        clientId: String(cfg.client_id || "").trim(),
        sessionId: String(cfg.session_id || "").trim(),
      };
    }

    async function logoutDevice({ revokeRemote = true } = {}) {
      const cfg = await loadSettings();
      const base = String(cfg.api_base || "").trim();
      const refreshToken = String(cfg.refresh_token || "").trim();
      const deviceId = String(cfg.device_id || "").trim();
      let remoteOk = false;

      if (revokeRemote && base && isSecureApiBase(base) && refreshToken && deviceId) {
        try {
          const url = buildApiUrl(base, "/api/auth/logout");
          const resp = await fetchWithTimeout(url, {
            method: "POST",
            headers: { "Content-Type": "application/json", ...getClientMetadataHeaders() },
            body: JSON.stringify({ refresh_token: refreshToken, device_id: deviceId }),
          });
          remoteOk = !!resp.ok;
        } catch {
          remoteOk = false;
        }
      }

      await clearTokensKeepDevice({ rotateSalt: true });
      return { ok: remoteOk || !revokeRemote, remoteOk };
    }

    async function logoutAllDevices({ revokeRemote = true } = {}) {
      const cfg = await loadSettings();
      const base = String(cfg.api_base || "").trim();
      const refreshToken = String(cfg.refresh_token || "").trim();
      const deviceId = String(cfg.device_id || "").trim();
      const accessToken = String(cfg.access_token || "").trim();
      let remoteOk = false;

      if (revokeRemote && base && isSecureApiBase(base)) {
        const headers = { "Content-Type": "application/json", ...getClientMetadataHeaders() };
        let body = null;
        if (refreshToken && deviceId) {
          body = { refresh_token: refreshToken, device_id: deviceId };
        } else if (accessToken) {
          headers.Authorization = `Bearer ${accessToken}`;
        }
        try {
          const url = buildApiUrl(base, "/api/auth/logout-all");
          const requestInit = {
            method: "POST",
            headers,
          };
          if (body) {
            requestInit.body = JSON.stringify(body);
          }
          const resp = await fetchWithTimeout(url, requestInit);
          remoteOk = !!resp.ok;
        } catch {
          remoteOk = false;
        }
      }

      await clearTokensKeepDevice({ rotateSalt: true });
      return { ok: remoteOk || !revokeRemote, remoteOk };
    }

    return {
      isSecureApiBase,
      loadSettings,
      getClientIdEffective,
      isJwtValid,
      getOrCreateDeviceId,
      login,
      loginWithResult,
      refresh,
      ensureFreshAccessToken,
      getAuthState,
      getAuthHeaders,
      logoutDevice,
      logoutAllDevices,
      getJwtToken: login,
      refreshJwtToken: refresh,
      refreshJwtSingleFlight: ensureFreshAccessToken,
    };
  }

  globalScope.createBackgroundAuthModule = createBackgroundAuthModule;
})(self);
