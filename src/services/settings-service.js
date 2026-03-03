/**
 * Configuración: carga/guardado en chrome.storage (sync + local).
 * No loguea tokens ni credenciales.
 */

const AUTH_LOCAL_KEYS = ["client_id"];
const AUTH_SESSION_KEYS = ["jwt_token", "jwt_expires_at"];

const DEFAULT_SYNC = {
  api_base: "",
  client_id_manual: "",
  client_id_source: "jwt",
  x_client_id: "",
  default_limit: 50,
  chatgpt_prompt: "",
};
const DEFAULT_LOCAL = { jwt_token: "", jwt_expires_at: 0, client_id: "" };
const DEFAULT_SESSION = { jwt_token: "", jwt_expires_at: 0 };

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
        const jwtToken = (sessionCfg.jwt_token || localCfg.jwt_token || "").trim();
        const jwtExpiresAt = Number(sessionCfg.jwt_expires_at || localCfg.jwt_expires_at || 0) || 0;
        if ((jwtToken && !sessionCfg.jwt_token) || (jwtExpiresAt && !sessionCfg.jwt_expires_at)) {
          await setSession({ jwt_token: jwtToken, jwt_expires_at: jwtExpiresAt });
          chrome.storage.local.remove(["api_token", "jwt_token", "jwt_expires_at"]);
        }
        const cfg = {
          ...syncCfg,
          ...localCfg,
          api_token: "",
          jwt_token: jwtToken,
          jwt_expires_at: jwtExpiresAt,
        };
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
    else if (AUTH_SESSION_KEYS.includes(k)) sessionPatch[k] = v;
    else syncPatch[k] = v;
  }
  return new Promise((resolve) => {
    const hasLocal = Object.keys(localPatch).length > 0;
    const hasSession = Object.keys(sessionPatch).length > 0;
    const hasSync = Object.keys(syncPatch).length > 0;

    const done = async () => {
      if (hasSession) {
        await setSession(sessionPatch);
        chrome.storage.local.remove(
          ["api_token", "jwt_token", "jwt_expires_at", "refresh_token"],
          () => resolve()
        );
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
  return removeSession(["jwt_token", "jwt_expires_at"]);
}
