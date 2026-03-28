import { createOptionsViewModel } from "./options-view-model.js";
import { createOptionsAuthController } from "./options-auth-controller.js";
import { createOptionsHealthController } from "./options-health-controller.js";
import { createOptionsQuotasController } from "./options-quotas-controller.js";
import {
  ensureApiHostPermission,
  isSecureApiBase,
  normalizeBaseUrl,
  toVersionBlockDetails,
} from "./options-shared.js";
import { apiFetch, fetchPing as fetchPingService } from "../../services/api-client.js";
import { loadSettings as loadStoredSettings } from "../../services/settings-service.js";

// options.js (estilo popup + settings alineados)
const $ = (sel) => document.querySelector(sel);

function renderCfgStatus(kind, text) {
  const dot = $("#cfgDot");
  const label = $("#cfgText");
  if (!dot || !label) return;

  dot.classList.remove("ok", "err", "warn");
  if (kind === "ok") dot.classList.add("ok");
  else if (kind === "err") dot.classList.add("err");
  else if (kind === "warn") dot.classList.add("warn");

  label.textContent = text || "—";
}

function renderSaveStatus(msg, isErr = false) {
  const el = $("#save_status");
  if (!el) return;
  el.textContent = msg;
  el.className = isErr ? "status-line err" : "status-line ok";
}

const viewModel = createOptionsViewModel({
  setConfigStatus: renderCfgStatus,
  setSaveStatus: renderSaveStatus,
});

const setCfgStatus = viewModel.updateConfigStatus;
const setSaveStatus = viewModel.updateSaveStatus;
const OPTIONS_QUOTAS_REFRESH_MS = 30000;
let quotasController = null;

function storageLocalSet(values) {
  return new Promise((resolve) => {
    chrome.storage.local.set(values, () => resolve());
  });
}

function storageLocalRemove(keys) {
  return new Promise((resolve) => {
    if (!Array.isArray(keys) || keys.length === 0) return resolve();
    chrome.storage.local.remove(keys, () => resolve());
  });
}

const PROMPT_MAX_CHARS = 700;
const PLAN_BLOCK_STATE_KEY = "plan_block_state";
const VERSION_BLOCK_STATE_KEY = "version_block_state";

async function persistPlanBlockState(loginResult) {
  const details =
    loginResult?.error?.details && typeof loginResult.error.details === "object"
      ? loginResult.error.details
      : null;
  const planName =
    String(details?.plan_name || "").trim() || String(details?.plan_id || "").trim() || "Free";
  await storageLocalSet({
    [PLAN_BLOCK_STATE_KEY]: {
      code: String(loginResult?.error?.code || "PLAN_EXPIRED")
        .trim()
        .toUpperCase(),
      status: Number(loginResult?.status || 0) || 403,
      message: String(
        loginResult?.errorMessage || "Tu plan venció. Renovalo para seguir usando el servicio."
      ),
      details,
      plan_name: planName,
      ts: Date.now(),
    },
  });
}

async function clearPlanBlockState() {
  await storageLocalRemove([PLAN_BLOCK_STATE_KEY]);
}

async function persistVersionBlockState(result) {
  const details = toVersionBlockDetails(result?.error?.details);
  await storageLocalSet({
    [VERSION_BLOCK_STATE_KEY]: {
      code: "CLIENT_UPDATE_REQUIRED",
      status: Number(result?.status || 0) || 426,
      message: String(
        result?.errorMessage || "A newer version of the extension is required."
      ).trim(),
      details,
      update_url: details.updateUrl || "",
      ts: Date.now(),
    },
  });
}

async function clearVersionBlockState() {
  await storageLocalRemove([VERSION_BLOCK_STATE_KEY]);
}

function loadVersionBlockState() {
  return new Promise((resolve) => {
    chrome.storage.local.get({ [VERSION_BLOCK_STATE_KEY]: null }, (data) => {
      const value = data?.[VERSION_BLOCK_STATE_KEY];
      if (!value || typeof value !== "object") return resolve(null);
      resolve(value);
    });
  });
}

function showVersionBlockScreen(state) {
  const screen = $("#update-required-screen");
  const msgEl = $("#update-required-message");
  const verEl = $("#update-required-versions");
  const actionEl = $("#update-required-action");
  if (!screen) return;

  const details = toVersionBlockDetails(state?.details);
  const message = String(state?.message || "A newer version of the extension is required.").trim();
  const updateUrl =
    details.updateUrl || String(state?.update_url || "").trim() || "https://github.com";
  const minRequired = details.minRequiredVersion;
  const latest = details.latestVersion;

  if (msgEl) msgEl.textContent = message;
  if (verEl) {
    const parts = [];
    if (minRequired) parts.push(`Minima requerida: ${minRequired}`);
    if (latest) parts.push(`Ultima disponible: ${latest}`);
    verEl.textContent = parts.join(" | ");
  }
  if (actionEl) actionEl.href = updateUrl;

  screen.classList.remove("is-hidden");
  screen.classList.add("is-visible");
  setCfgStatus("err", "Actualizar extension");
}

function hideVersionBlockScreen() {
  const screen = $("#update-required-screen");
  if (!screen) return;
  screen.classList.remove("is-visible");
  screen.classList.add("is-hidden");
}

let sessionAccessExpiresAt = 0;

/** Headers de auth desde background (centralizado). */
function getAuthHeadersFromBackground() {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ action: "getAuthHeaders" }, (r) => resolve(r?.headers || {}));
  });
}

function getAuthStateFromBackground() {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ action: "auth_get_state" }, (r) => {
      resolve({
        isAuthenticated: !!r?.isAuthenticated,
        accessExpiresAt: Number(r?.accessExpiresAt || 0) || 0,
        clientId: String(r?.clientId || "").trim(),
        sessionId: String(r?.sessionId || "").trim(),
      });
    });
  });
}

function ensureAuthFromBackground(force = true) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ action: "auth_ensure_fresh_access", force: !!force }, (r) => {
      resolve(!!r?.ok);
    });
  });
}

function refreshCfgStatus() {
  const base = normalizeBaseUrl($("#api_base")?.value);
  const token = ($("#api_token")?.value || "").trim();
  const hasSessionAccess = Number(sessionAccessExpiresAt || 0) > Date.now();
  const hasAuth = !!token || hasSessionAccess;

  if (!base) return setCfgStatus("err", "Falta API Base");
  if (!isSecureApiBase(base)) return setCfgStatus("err", "La API debe usar HTTPS");
  if (!hasAuth) return setCfgStatus("warn", "Falta autenticación");
  return setCfgStatus("ok", "Listo");
}

function applyPromptLimits(limits) {
  const ta = $("#chatgpt_prompt");
  const hint = $("#chatgpt_prompt_hint");
  const apiMax = Number(limits?.max_client_prompt_length || 0) || PROMPT_MAX_CHARS;
  const maxPrompt = Math.min(PROMPT_MAX_CHARS, apiMax);
  if (ta) {
    ta.maxLength = maxPrompt;
    const currentLen = (ta.value || "").length;
    if (currentLen > maxPrompt) {
      ta.value = ta.value.slice(0, maxPrompt);
    }
  }
  if (hint) {
    const current = ta ? (ta.value || "").length : 0;
    hint.textContent = `Caracteres: ${current}/${maxPrompt}`;
  }
}

const authController = createOptionsAuthController({
  dom: { $ },
  services: {
    storageLocalSet,
    storageLocalRemove,
  },
  auth: {
    getAuthStateFromBackground,
    ensureAuthFromBackground,
    ensureApiHostPermission,
    performAuthLoginRemote: (base, apiKey) =>
      chrome.runtime.sendMessage({
        action: "auth_login",
        api_base: base,
        api_token: apiKey,
      }),
    logoutRemote: (allDevices = false) =>
      chrome.runtime.sendMessage({
        action: allDevices ? "auth_logout_all" : "auth_logout",
        revoke_remote: true,
      }),
  },
  ui: {
    setCfgStatus,
    setSaveStatus,
    refreshCfgStatus,
    applyPromptLimits,
  },
  versioning: {
    persistPlanBlockState,
    clearPlanBlockState,
    persistVersionBlockState,
    clearVersionBlockState,
    showVersionBlockScreen,
    hideVersionBlockScreen,
  },
  quotas: {
    fetchQuotas: (...args) => quotasController?.fetchQuotas(...args),
  },
  config: {
    promptMaxChars: PROMPT_MAX_CHARS,
  },
  state: {
    get sessionAccessExpiresAt() {
      return sessionAccessExpiresAt;
    },
    set sessionAccessExpiresAt(value) {
      sessionAccessExpiresAt = Number(value || 0) || 0;
    },
  },
});

const healthController = createOptionsHealthController({
  dom: { $ },
  auth: {
    getAuthHeadersFromBackground,
    ensureApiHostPermission,
  },
  ui: {
    setCfgStatus,
  },
  services: {
    fetchPingService,
  },
  versioning: {
    persistVersionBlockState,
    clearVersionBlockState,
    showVersionBlockScreen,
    hideVersionBlockScreen,
  },
  helpers: {
    refreshCfgStatus,
  },
  config: {
    apiConfigTimeoutMs: 10000,
  },
});

quotasController = createOptionsQuotasController({
  dom: { $ },
  auth: {
    getAuthHeadersFromBackground,
    getLoggedInUsername: () => chrome.runtime.sendMessage({ action: "get_logged_in_username" }),
  },
  services: {
    apiFetch,
    fetchPingWithHeaders: (...args) => healthController.fetchPingWithHeaders(...args),
  },
  helpers: {
    ensureApiHostPermission,
    unwrapApiDataEnvelope: (...args) => healthController.unwrapApiDataEnvelope(...args),
    toUserApiError: (...args) => healthController.toUserApiError(...args),
  },
  config: {
    refreshMs: OPTIONS_QUOTAS_REFRESH_MS,
  },
});

async function load() {
  const cfg = await loadStoredSettings();
  if (cfg.x_client_id) {
    cfg.client_id_manual = cfg.client_id_manual || cfg.x_client_id;
    cfg.client_id_source = "manual";
  }
  const authState = await getAuthStateFromBackground();
  $("#api_base").value = cfg.api_base || "";
  $("#api_token").value = cfg.api_token || "";
  $("#default_limit").value = cfg.default_limit || 50;
  $("#chatgpt_prompt").value = cfg.chatgpt_prompt || "";
  if ($("#health_ping_result")) $("#health_ping_result").value = "—";

  sessionAccessExpiresAt = Number(authState.accessExpiresAt || cfg.access_expires_at || 0) || 0;

  ["api_base", "api_token", "default_limit", "chatgpt_prompt"].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.addEventListener("input", refreshCfgStatus);
    if (el) el.addEventListener("change", refreshCfgStatus);
  });

  authController.applyPromptCounter();

  const base = normalizeBaseUrl(cfg.api_base);
  applyPromptLimits({ max_client_prompt_length: PROMPT_MAX_CHARS });
  if (base) {
    healthController.fetchApiConfig(base).then((limits) => {
      if (limits) applyPromptLimits(limits);
    });
  }
  refreshCfgStatus();
  const versionBlock = await loadVersionBlockState();
  if (
    String(versionBlock?.code || "")
      .trim()
      .toUpperCase() === "CLIENT_UPDATE_REQUIRED"
  ) {
    showVersionBlockScreen(versionBlock);
  } else {
    hideVersionBlockScreen();
  }
}

const { fetchQuotas } = quotasController;

document.addEventListener("DOMContentLoaded", () => {
  load();
  setTimeout(() => healthController.verifyWithPing(), 300);
  setTimeout(fetchQuotas, 500);
  quotasController.startAutoRefresh();
});

$("#save").addEventListener("click", () => authController.save());
$("#test").addEventListener("click", async () => {
  await healthController.test();
  const base = normalizeBaseUrl($("#api_base")?.value);
  if (base) {
    const limits = await healthController.fetchApiConfig(base, { cacheMode: "network-only" });
    if (limits) applyPromptLimits(limits);
  }
});
$("#test_health").addEventListener("click", async () => {
  await authController.testHealth();
});
if ($("#logout_device")) {
  $("#logout_device").addEventListener("click", async () => {
    await authController.logoutSession({ allDevices: false });
  });
}
if ($("#logout_all_devices")) {
  $("#logout_all_devices").addEventListener("click", async () => {
    await authController.logoutSession({ allDevices: true });
  });
}

// Variables del prompt: al hacer clic en una variable se inserta en el textarea
(function () {
  const varsHint = $("#chatgpt_variables_hint");
  const ta = $("#chatgpt_prompt");
  if (!varsHint || !ta) return;
  varsHint.addEventListener("click", (e) => {
    const code = e.target.closest(".var-insert");
    if (!code) return;
    const v = code.dataset.var || code.textContent || "";
    if (!v) return;
    const start = ta.selectionStart;
    const end = ta.selectionEnd;
    const before = ta.value.slice(0, start);
    const after = ta.value.slice(end);
    ta.value = before + v + after;
    if (ta.maxLength > 0 && ta.value.length > ta.maxLength) {
      ta.value = ta.value.slice(0, ta.maxLength);
    }
    ta.selectionStart = ta.selectionEnd = start + v.length;
    ta.focus();
    applyPromptLimits({ max_client_prompt_length: PROMPT_MAX_CHARS });
  });
})();
