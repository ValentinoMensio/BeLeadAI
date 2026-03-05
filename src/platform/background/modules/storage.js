(function initBackgroundStorageModule(globalScope) {
  function createBackgroundStorageModule({
    state,
    processedTaskTtlMs,
    processedTaskMax,
    pendingReportsMax,
  }) {
    const textEncoder = new TextEncoder();
    const AUTH_KEYS = {
      deviceId: "auth.device_id",
      accessToken: "auth.access_token",
      accessExpiresAt: "auth.access_expires_at",
      refreshToken: "auth.refresh_token",
      refreshExpiresAt: "auth.refresh_expires_at",
      clientId: "auth.client_id",
      sessionId: "auth.session_id",
      cryptoSalt: "auth.crypto_salt",
    };
    const AUTH_SESSION_KEYS = {
      accessToken: "auth.session_access_token",
      accessExpiresAt: "auth.session_access_expires_at",
    };
    const AUTH_TOKEN_PREFIX = "enc:v1:";

    function getSession(defaults) {
      return new Promise((resolve) => {
        if (!chrome.storage.session) return resolve(defaults || {});
        chrome.storage.session.get(defaults, (data) => resolve(data || defaults || {}));
      });
    }

    function setSession(values) {
      return new Promise((resolve) => {
        if (!chrome.storage.session || !values || !Object.keys(values).length) return resolve();
        chrome.storage.session.set(values, () => resolve());
      });
    }

    function saveState(patch) {
      return new Promise((resolve) => {
        chrome.storage.local.set(patch, () => resolve());
      });
    }

    function loadState() {
      return new Promise((resolve) => {
        chrome.storage.local.get(
          {
            dm_sender_running: false,
            dm_sender_session_count: 0,
            dm_sender_last_time: 0,
            dm_sender_next_time: 0,
            dm_sender_current_job_id: null,
          },
          (data) => {
            state.isRunning = data.dm_sender_running;
            state.dmsSentThisSession = data.dm_sender_session_count;
            state.lastDMTime = data.dm_sender_last_time;
            state.nextDMTime = data.dm_sender_next_time;
            resolve(state);
          }
        );
      });
    }

    function storageGetLocal(defaults) {
      return new Promise((resolve) => {
        chrome.storage.local.get(defaults, (data) => resolve(data || {}));
      });
    }

    function bytesToBase64(bytes) {
      const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
      let bin = "";
      for (let i = 0; i < view.length; i += 1) {
        bin += String.fromCharCode(view[i]);
      }
      return btoa(bin);
    }

    function base64ToBytes(b64) {
      const bin = atob(String(b64 || ""));
      const out = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i += 1) {
        out[i] = bin.charCodeAt(i);
      }
      return out;
    }

    function randomBytes(size) {
      const n = Number(size || 0);
      const out = new Uint8Array(Math.max(1, n));
      crypto.getRandomValues(out);
      return out;
    }

    async function getOrCreateAuthSalt() {
      const data = await storageGetLocal({ [AUTH_KEYS.cryptoSalt]: "" });
      const existing = String(data[AUTH_KEYS.cryptoSalt] || "").trim();
      if (existing) return existing;
      const salt = bytesToBase64(randomBytes(16));
      await saveState({ [AUTH_KEYS.cryptoSalt]: salt });
      return salt;
    }

    async function deriveAuthKey(deviceId) {
      const did = String(deviceId || "").trim();
      if (!did) return null;
      const saltB64 = await getOrCreateAuthSalt();
      const keyMaterial = await crypto.subtle.importKey(
        "raw",
        textEncoder.encode(did),
        "PBKDF2",
        false,
        ["deriveKey"]
      );
      return crypto.subtle.deriveKey(
        {
          name: "PBKDF2",
          salt: base64ToBytes(saltB64),
          iterations: 120000,
          hash: "SHA-256",
        },
        keyMaterial,
        {
          name: "AES-GCM",
          length: 256,
        },
        false,
        ["encrypt", "decrypt"]
      );
    }

    async function encryptTokenValue(rawValue, deviceId) {
      const value = String(rawValue || "").trim();
      if (!value) return "";
      const key = await deriveAuthKey(deviceId);
      if (!key) return value;
      const iv = randomBytes(12);
      const cipherBuffer = await crypto.subtle.encrypt(
        { name: "AES-GCM", iv },
        key,
        textEncoder.encode(value)
      );
      return `${AUTH_TOKEN_PREFIX}${bytesToBase64(iv)}.${bytesToBase64(new Uint8Array(cipherBuffer))}`;
    }

    async function decryptTokenValue(storedValue, deviceId) {
      const value = String(storedValue || "").trim();
      if (!value) return "";
      if (!value.startsWith(AUTH_TOKEN_PREFIX)) return value;
      const key = await deriveAuthKey(deviceId);
      if (!key) return "";
      const payload = value.slice(AUTH_TOKEN_PREFIX.length);
      const parts = payload.split(".");
      if (parts.length !== 2) return "";
      try {
        const iv = base64ToBytes(parts[0]);
        const cipherBytes = base64ToBytes(parts[1]);
        const plainBuffer = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, cipherBytes);
        return new TextDecoder().decode(plainBuffer);
      } catch {
        return "";
      }
    }

    async function resolveAuthDeviceIdForWrite(patch) {
      const fromPatch = Object.prototype.hasOwnProperty.call(patch || {}, "device_id")
        ? String(patch.device_id || "").trim()
        : "";
      if (fromPatch) return fromPatch;
      const current = await storageGetLocal({ [AUTH_KEYS.deviceId]: "" });
      return String(current[AUTH_KEYS.deviceId] || "").trim();
    }

    async function getProcessedTaskResults() {
      const data = await storageGetLocal({ dm_sender_processed_task_results: {} });
      return data.dm_sender_processed_task_results || {};
    }

    function pruneProcessedTaskResults(results) {
      const now = Date.now();
      const entries = Object.entries(results || {}).filter(([, v]) => {
        const ts = Number(v?.ts || 0);
        return Number.isFinite(ts) && ts > 0 && now - ts <= processedTaskTtlMs;
      });
      entries.sort((a, b) => Number(a[1]?.ts || 0) - Number(b[1]?.ts || 0));
      const trimmed = entries.slice(Math.max(0, entries.length - processedTaskMax));
      return Object.fromEntries(trimmed);
    }

    async function getProcessedTaskResult(taskId) {
      const id = String(taskId || "").trim();
      if (!id) return null;
      const results = await getProcessedTaskResults();
      const pruned = pruneProcessedTaskResults(results);
      if (Object.keys(pruned).length !== Object.keys(results).length) {
        await saveState({ dm_sender_processed_task_results: pruned });
      }
      return pruned[id] || null;
    }

    async function rememberProcessedTaskResult(taskId, reportPayload) {
      const id = String(taskId || "").trim();
      if (!id) return;
      const results = await getProcessedTaskResults();
      const next = pruneProcessedTaskResults({
        ...results,
        [id]: {
          ts: Date.now(),
          report: reportPayload || null,
        },
      });
      await saveState({ dm_sender_processed_task_results: next });
    }

    async function getPendingReports() {
      const data = await storageGetLocal({ dm_sender_pending_reports: [] });
      const rows = Array.isArray(data.dm_sender_pending_reports)
        ? data.dm_sender_pending_reports
        : [];
      return rows.slice(0, pendingReportsMax);
    }

    function reportKey(r) {
      return `${String(r?.job_id || "")}:${String(r?.task_id || "")}`;
    }

    async function enqueuePendingReport(report) {
      const queue = await getPendingReports();
      const key = reportKey(report);
      const filtered = queue.filter((r) => reportKey(r) !== key);
      filtered.push(report);
      const trimmed = filtered.slice(Math.max(0, filtered.length - pendingReportsMax));
      await saveState({ dm_sender_pending_reports: trimmed });
    }

    async function getAuthState() {
      const defaults = {
        [AUTH_KEYS.deviceId]: "",
        [AUTH_KEYS.accessToken]: "",
        [AUTH_KEYS.accessExpiresAt]: 0,
        [AUTH_KEYS.refreshToken]: "",
        [AUTH_KEYS.refreshExpiresAt]: 0,
        [AUTH_KEYS.clientId]: "",
        [AUTH_KEYS.sessionId]: "",
        [AUTH_KEYS.cryptoSalt]: "",
      };
      const sessionDefaults = {
        [AUTH_SESSION_KEYS.accessToken]: "",
        [AUTH_SESSION_KEYS.accessExpiresAt]: 0,
      };
      const data = await storageGetLocal(defaults);
      const sessionData = await getSession(sessionDefaults);
      const deviceId = String(data[AUTH_KEYS.deviceId] || "").trim();
      const rawRefreshStored = String(data[AUTH_KEYS.refreshToken] || "").trim();
      let accessToken = String(sessionData[AUTH_SESSION_KEYS.accessToken] || "").trim();
      let accessExpiresAt = Number(sessionData[AUTH_SESSION_KEYS.accessExpiresAt] || 0) || 0;
      if (!accessToken) {
        accessToken = await decryptTokenValue(data[AUTH_KEYS.accessToken], deviceId);
        if (accessToken) {
          accessExpiresAt = Number(data[AUTH_KEYS.accessExpiresAt] || 0) || 0;
          await setSession({
            [AUTH_SESSION_KEYS.accessToken]: accessToken,
            [AUTH_SESSION_KEYS.accessExpiresAt]: accessExpiresAt,
          });
          await saveState({
            [AUTH_KEYS.accessToken]: "",
            [AUTH_KEYS.accessExpiresAt]: 0,
          });
        }
      }
      const refreshToken = await decryptTokenValue(data[AUTH_KEYS.refreshToken], deviceId);
      if (deviceId) {
        const migratePatch = {};
        if (rawRefreshStored && !rawRefreshStored.startsWith(AUTH_TOKEN_PREFIX)) {
          migratePatch[AUTH_KEYS.refreshToken] = await encryptTokenValue(
            rawRefreshStored,
            deviceId
          );
        }
        if (Object.keys(migratePatch).length) {
          await saveState(migratePatch);
        }
      }
      return {
        device_id: deviceId,
        access_token: accessToken,
        access_expires_at: accessExpiresAt,
        refresh_token: refreshToken,
        refresh_expires_at: Number(data[AUTH_KEYS.refreshExpiresAt] || 0) || 0,
        client_id: String(data[AUTH_KEYS.clientId] || "").trim(),
        session_id: String(data[AUTH_KEYS.sessionId] || "").trim(),
      };
    }

    async function setAuthState(patch) {
      const deviceId = await resolveAuthDeviceIdForWrite(patch);
      const next = {};
      const sessionNext = {};
      if (Object.prototype.hasOwnProperty.call(patch || {}, "device_id"))
        next[AUTH_KEYS.deviceId] = String(patch.device_id || "").trim();
      if (Object.prototype.hasOwnProperty.call(patch || {}, "access_token")) {
        sessionNext[AUTH_SESSION_KEYS.accessToken] = String(patch.access_token || "").trim();
        next[AUTH_KEYS.accessToken] = "";
        next[AUTH_KEYS.accessExpiresAt] = 0;
      }
      if (Object.prototype.hasOwnProperty.call(patch || {}, "access_expires_at")) {
        sessionNext[AUTH_SESSION_KEYS.accessExpiresAt] = Number(patch.access_expires_at || 0) || 0;
      }
      if (Object.prototype.hasOwnProperty.call(patch || {}, "refresh_token")) {
        next[AUTH_KEYS.refreshToken] = await encryptTokenValue(patch.refresh_token, deviceId);
      }
      if (Object.prototype.hasOwnProperty.call(patch || {}, "refresh_expires_at"))
        next[AUTH_KEYS.refreshExpiresAt] = Number(patch.refresh_expires_at || 0) || 0;
      if (Object.prototype.hasOwnProperty.call(patch || {}, "client_id"))
        next[AUTH_KEYS.clientId] = String(patch.client_id || "").trim();
      if (Object.prototype.hasOwnProperty.call(patch || {}, "session_id"))
        next[AUTH_KEYS.sessionId] = String(patch.session_id || "").trim();
      if (Object.keys(next).length) {
        await saveState(next);
      }
      if (Object.keys(sessionNext).length) {
        await setSession(sessionNext);
      }
    }

    async function clearAuthState(options = {}) {
      const rotateSalt = !!options.rotateSalt;
      const keys = [
        AUTH_KEYS.accessToken,
        AUTH_KEYS.accessExpiresAt,
        AUTH_KEYS.refreshToken,
        AUTH_KEYS.refreshExpiresAt,
        AUTH_KEYS.clientId,
        AUTH_KEYS.sessionId,
      ];
      await new Promise((resolve) => chrome.storage.local.remove(keys, () => resolve()));
      await new Promise((resolve) => {
        if (!chrome.storage.session) return resolve();
        chrome.storage.session.remove(
          [AUTH_SESSION_KEYS.accessToken, AUTH_SESSION_KEYS.accessExpiresAt],
          () => resolve()
        );
      });
      if (rotateSalt) {
        await saveState({ [AUTH_KEYS.cryptoSalt]: bytesToBase64(randomBytes(16)) });
      }
    }

    return {
      getSession,
      setSession,
      saveState,
      loadState,
      storageGetLocal,
      getProcessedTaskResults,
      pruneProcessedTaskResults,
      getProcessedTaskResult,
      rememberProcessedTaskResult,
      getPendingReports,
      reportKey,
      enqueuePendingReport,
      AUTH_KEYS,
      getAuthState,
      setAuthState,
      clearAuthState,
    };
  }

  globalScope.createBackgroundStorageModule = createBackgroundStorageModule;
})(self);
