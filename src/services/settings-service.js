/**
 * Configuración: carga/guardado en chrome.storage (sync + local).
 * No loguea tokens ni credenciales.
 */

const AUTH_LOCAL_KEYS = ["client_id"];
const AUTH_STORAGE_LOCAL_KEYS = {
  clientId: "auth.client_id",
  deviceId: "auth.device_id",
  refreshExpiresAt: "auth.refresh_expires_at",
  sessionId: "auth.session_id",
};
const AUTH_STORAGE_SESSION_KEYS = {
  accessToken: "auth.session_access_token",
  accessExpiresAt: "auth.session_access_expires_at",
};
const LEGACY_AUTH_STORAGE_KEYS = ["api" + "_token", "jwt" + "_token", "jwt" + "_expires_at"];

const DEFAULT_SYNC = {
  api_base: "",
  client_id_manual: "",
  client_id_source: "jwt",
  x_client_id: "",
  default_limit: 50,
  chatgpt_prompt: "",
};
const DEFAULT_LOCAL = {
  client_id: "",
  [AUTH_STORAGE_LOCAL_KEYS.clientId]: "",
  [AUTH_STORAGE_LOCAL_KEYS.deviceId]: "",
  [AUTH_STORAGE_LOCAL_KEYS.refreshExpiresAt]: 0,
  [AUTH_STORAGE_LOCAL_KEYS.sessionId]: "",
};
const DEFAULT_SESSION = {
  [AUTH_STORAGE_SESSION_KEYS.accessToken]: "",
  [AUTH_STORAGE_SESSION_KEYS.accessExpiresAt]: 0,
};

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

function removeSession(keys) {
  return new Promise((resolve) => {
    if (!chrome.storage.session || !Array.isArray(keys) || keys.length === 0) return resolve();
    chrome.storage.session.remove(keys, () => resolve());
  });
}

export function loadSettings() {
  return new Promise((resolve) => {
    chrome.storage.sync.get(DEFAULT_SYNC, (syncCfg) => {
      chrome.storage.local.get(DEFAULT_LOCAL, async (localCfg) => {
        const sessionCfg = await getSession(DEFAULT_SESSION);
        const accessToken = String(sessionCfg[AUTH_STORAGE_SESSION_KEYS.accessToken] || "").trim();
        const accessExpiresAt =
          Number(sessionCfg[AUTH_STORAGE_SESSION_KEYS.accessExpiresAt] || 0) || 0;
        const cfg = {
          ...syncCfg,
          ...localCfg,
          api_token: "",
          access_token: accessToken,
          access_expires_at: accessExpiresAt,
          client_id:
            String(localCfg[AUTH_STORAGE_LOCAL_KEYS.clientId] || "").trim() ||
            String(localCfg.client_id || "").trim(),
          device_id: String(localCfg[AUTH_STORAGE_LOCAL_KEYS.deviceId] || "").trim(),
          refresh_expires_at: Number(localCfg[AUTH_STORAGE_LOCAL_KEYS.refreshExpiresAt] || 0) || 0,
          session_id: String(localCfg[AUTH_STORAGE_LOCAL_KEYS.sessionId] || "").trim(),
        };
        chrome.storage.local.remove(LEGACY_AUTH_STORAGE_KEYS, () => {});
        if ((cfg.x_client_id || "").trim() && !(cfg.client_id_manual || "").trim()) {
          cfg.client_id_manual = (cfg.client_id_manual || cfg.x_client_id || "").trim();
          cfg.client_id_source = "manual";
        }
        resolve(cfg);
      });
    });
  });
}

export function saveSettings(patch) {
  const localPatch = {};
  const sessionPatch = {};
  const syncPatch = {};
  for (const [k, v] of Object.entries(patch)) {
    if (AUTH_LOCAL_KEYS.includes(k)) localPatch[k] = v;
    else if (k === "access_token") sessionPatch[AUTH_STORAGE_SESSION_KEYS.accessToken] = v;
    else if (k === "access_expires_at") sessionPatch[AUTH_STORAGE_SESSION_KEYS.accessExpiresAt] = v;
    else syncPatch[k] = v;
  }
  return new Promise((resolve) => {
    const hasLocal = Object.keys(localPatch).length > 0;
    const hasSession = Object.keys(sessionPatch).length > 0;
    const hasSync = Object.keys(syncPatch).length > 0;

    const done = async () => {
      if (hasSession) {
        await setSession(sessionPatch);
        chrome.storage.local.remove(LEGACY_AUTH_STORAGE_KEYS, () => resolve());
        return;
      }
      resolve();
    };

    if (hasLocal && hasSync) {
      chrome.storage.local.set(localPatch, () => chrome.storage.sync.set(syncPatch, done));
    } else if (hasLocal) {
      chrome.storage.local.set(localPatch, done);
    } else if (hasSync) {
      chrome.storage.sync.set(syncPatch, done);
    } else {
      done();
    }
  });
}

export function clearSessionAuth() {
  return removeSession([
    AUTH_STORAGE_SESSION_KEYS.accessToken,
    AUTH_STORAGE_SESSION_KEYS.accessExpiresAt,
  ]);
}
