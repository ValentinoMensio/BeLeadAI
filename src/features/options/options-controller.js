import { createOptionsViewModel } from "./options-view-model.js";
import {
  renderPendingLinkAccountCard,
  renderNoLinkedAccountsCard,
  renderQuotaAccountCard,
} from "./options-templates.js";
import { API_PATHS } from "../../config/endpoints.js";
import { buildApiUrl } from "../../shared/utils/url.js";
import { buildClientHeaders } from "../../shared/utils/client-metadata.js";
import { escapeHtml } from "../../shared/utils/dom.js";
import { logApiErrorDiagnostic } from "../../shared/errors/error-diagnostics.js";
import { apiFetch, fetchPing as fetchPingService } from "../../services/api-client.js";

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

function normalizeBaseUrl(v) {
  const s = (v || "").trim();
  return s.replace(/\/+$/, ""); // sin slash final
}

function toNumOrNull(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function resolveUsedMonth(messages, planMonth) {
  const direct =
    toNumOrNull(messages?.used_this_month) ??
    toNumOrNull(messages?.used_month) ??
    toNumOrNull(messages?.sent_this_month) ??
    toNumOrNull(messages?.consumed_this_month) ??
    toNumOrNull(messages?.total_this_month);
  if (direct != null) return Math.max(0, direct);
  const remaining = toNumOrNull(messages?.remaining_this_month);
  const limit = toNumOrNull(planMonth);
  if (remaining != null && limit != null && limit > 0) return Math.max(0, limit - remaining);
  return 0;
}

function isSecureApiBase(base) {
  try {
    return new URL(base).protocol === "https:";
  } catch {
    return false;
  }
}

function toApiOriginPermission(base) {
  const u = new URL(base);
  const host = u.port ? `${u.hostname}:${u.port}` : u.hostname;
  return `${u.protocol}//${host}/*`;
}

function permissionsContains(origins) {
  return new Promise((resolve) => {
    chrome.permissions.contains({ origins }, (granted) => resolve(!!granted));
  });
}

function permissionsRequest(origins) {
  return new Promise((resolve) => {
    chrome.permissions.request({ origins }, (granted) => resolve(!!granted));
  });
}

async function ensureApiHostPermission(base, requestIfMissing = false) {
  if (!base || !isSecureApiBase(base)) return false;
  const origin = toApiOriginPermission(base);
  const alreadyGranted = await permissionsContains([origin]);
  if (alreadyGranted) return true;
  if (!requestIfMissing) return false;
  return permissionsRequest([origin]);
}

function storageSessionGet(defaults) {
  return new Promise((resolve) => {
    if (!chrome.storage.session) return resolve(defaults || {});
    chrome.storage.session.get(defaults, (data) => resolve(data || defaults || {}));
  });
}

function storageSessionRemove(keys) {
  return new Promise((resolve) => {
    if (!chrome.storage.session || !Array.isArray(keys) || keys.length === 0) return resolve();
    chrome.storage.session.remove(keys, () => resolve());
  });
}

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

/**
 * Clasifica un error de fetch en tipo y mensaje para el usuario.
 * Best-effort: en el navegador no siempre se puede distinguir DNS vs CORS.
 * @param {Error} e
 * @returns {{ kind: string, message: string }}
 */
function classifyFetchError(e) {
  if (!e || typeof e !== "object") return { kind: "unknown", message: "Error de red." };
  const msg = (e.message || String(e)).toLowerCase();
  const name = (e.name || "").toLowerCase();
  if (name === "aborterror" || msg.includes("timeout") || msg.includes("timed out")) {
    return {
      kind: "timeout",
      message: "La API tardó demasiado. Revisá conectividad o servidor caído.",
    };
  }
  if (msg.includes("cors") || msg.includes("cross-origin") || msg.includes("cross origin")) {
    return { kind: "cors", message: "La API no permite CORS desde la extensión." };
  }
  if (
    msg.includes("certificate") ||
    msg.includes("ssl") ||
    msg.includes("tls") ||
    msg.includes("https") ||
    msg.includes("secure")
  ) {
    return {
      kind: "tls",
      message:
        "Error de certificado/HTTPS. Probá con https:// y revisá que el certificado sea válido.",
    };
  }
  if (
    msg.includes("failed to fetch") ||
    msg.includes("networkerror") ||
    msg.includes("network error") ||
    msg.includes("load failed")
  ) {
    return { kind: "dns", message: "" };
  }
  return { kind: "unknown", message: "Error de red. Revisá URL, certificado HTTPS o CORS." };
}

function isLikelyHtmlResponse(text) {
  const t = String(text || "")
    .trim()
    .toLowerCase();
  return (
    t.startsWith("<!doctype html") ||
    t.startsWith("<html") ||
    t.includes("<head") ||
    t.includes("<body")
  );
}

function summarizeHtmlResponse(status) {
  return `No se pudo conectar con la API (HTTP ${status || 0}). Revisá la URL base y probá de nuevo.`;
}

function fallbackApiErrorMessage(status) {
  const s = Number(status || 0) || 0;
  if (s === 401) return "API key inválida o expirada. Revisá la key en Opciones.";
  if (s === 403) return "No tenés permiso para esta acción.";
  if (s === 429) return "Demasiadas solicitudes. Esperá un momento antes de reintentar.";
  if (s === 426) return "Necesitás actualizar la extensión para continuar.";
  if (s >= 500) return "Error del servidor. Probá más tarde.";
  if (s > 0) return `Error de la API (HTTP ${s}).`;
  return "Error de conexión.";
}

function toUserApiError(status, data, text, retrySec = null) {
  if (isLikelyHtmlResponse(text)) return summarizeHtmlResponse(status);
  if (typeof window.formatApiErrorForUser === "function") {
    const formatted = window.formatApiErrorForUser(status, data, text, retrySec);
    if (typeof formatted === "string" && !isLikelyHtmlResponse(formatted)) return formatted;
  }
  const fallback = fallbackApiErrorMessage(status);
  return isLikelyHtmlResponse(fallback) ? summarizeHtmlResponse(status) : String(fallback);
}

function unwrapApiDataEnvelope(payload) {
  if (!payload || typeof payload !== "object") return {};
  const nested = payload.data;
  if (nested && typeof nested === "object" && !Array.isArray(nested)) return nested;
  return payload;
}

function classifyLoginFailure(result) {
  const status = Number(result?.status || 0) || 0;
  const code = String(result?.error?.code || "")
    .trim()
    .toUpperCase();
  if (status === 426 || code === "CLIENT_UPDATE_REQUIRED") return "update_required";
  const blockingQuota = String(result?.error?.details?.blocking_quota || "")
    .trim()
    .toLowerCase();
  if (
    status === 403 ||
    code === "PLAN_EXPIRED" ||
    code === "FREE_PLAN_EXPIRED" ||
    blockingQuota === "plan_duration" ||
    blockingQuota === "free_plan_duration"
  ) {
    return "plan_expired";
  }
  if (status === 429 || code === "RATE_LIMIT_EXCEEDED") return "rate_limit";
  if (status === 401 || status === 403 || code === "UNAUTHORIZED" || code === "INVALID_API_KEY")
    return "auth";
  if (status === 0 || code === "NETWORK_ERROR" || code === "REQUEST_TIMEOUT") return "network";
  return "unknown";
}

const API_CONFIG_TIMEOUT_MS = 10000;
const PROMPT_MAX_CHARS = 700;
const SESSION_AUTH_KEYS = [];
const PLAN_BLOCK_STATE_KEY = "plan_block_state";
const VERSION_BLOCK_STATE_KEY = "version_block_state";

function toVersionBlockDetails(errorDetails) {
  if (!errorDetails || typeof errorDetails !== "object") return {};
  return {
    minRequiredVersion: String(
      errorDetails.minRequiredVersion || errorDetails.min_required_version || ""
    ).trim(),
    latestVersion: String(errorDetails.latestVersion || errorDetails.latest_version || "").trim(),
    updateUrl: String(errorDetails.updateUrl || errorDetails.update_url || "").trim(),
  };
}

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

let sessionJwtExpiresAt = 0;

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

/**
 * Verifica conexión con GET /ext/v2/ping y actualiza estado (pill). Solo JWT.
 */
async function verifyWithPing() {
  const base = normalizeBaseUrl($("#api_base")?.value);
  if (!base) {
    refreshCfgStatus();
    return;
  }
  if (!isSecureApiBase(base)) {
    setCfgStatus("err", "La API debe usar HTTPS");
    return;
  }
  if (!(await ensureApiHostPermission(base, false))) {
    setCfgStatus("warn", "Falta permiso del dominio API");
    return;
  }
  const headers = await getAuthHeadersFromBackground();
  if (!headers.Authorization) {
    refreshCfgStatus();
    return;
  }
  const result = await fetchPingWithHeaders(base, headers);
  const failureType = classifyLoginFailure(result);
  if (failureType === "update_required") {
    await persistVersionBlockState(result);
    showVersionBlockScreen({
      message: result?.errorMessage,
      details: result?.error?.details,
      update_url: result?.error?.details?.updateUrl || result?.error?.details?.update_url,
    });
    return;
  }
  await clearVersionBlockState();
  hideVersionBlockScreen();
  if (result.errorMessage) {
    setCfgStatus("err", result.errorMessage);
    return;
  }
  if (!result.tokenOk) {
    const hint = result.status === 401 ? " Hacé «Probar API Key» de nuevo." : "";
    setCfgStatus("err", "Auth falló (HTTP " + result.status + ")" + hint);
    return;
  }
  refreshCfgStatus();
}

async function fetchPingWithHeaders(baseUrl, headers, options = {}) {
  const networkOnly =
    String(options?.cacheMode || "default")
      .trim()
      .toLowerCase() === "network-only";
  const empty = {
    urlOk: false,
    tokenOk: false,
    status: 0,
    accountUsername: null,
    defaultFromAccount: null,
    accounts: [],
    error: null,
    errorMessage: null,
  };
  if (!baseUrl || !headers.Authorization) return empty;
  try {
    const ping = await fetchPingService(
      { api_base: baseUrl },
      { cacheMode: networkOnly ? "network-only" : "default" }
    );
    const accounts = Array.isArray(ping?.accounts) ? ping.accounts : [];
    const defaultFromAccount =
      ping?.defaultFromAccount != null && String(ping.defaultFromAccount).trim()
        ? String(ping.defaultFromAccount).trim().toLowerCase()
        : null;
    const accountUsername = ping?.accountUsername ? String(ping.accountUsername).trim() : null;
    return {
      urlOk: !!ping?.urlOk,
      tokenOk: !!ping?.tokenOk,
      status: Number(ping?.status || 0) || 0,
      accountUsername,
      defaultFromAccount,
      accounts,
      errorMessage: ping?.errorMessage || null,
      error: ping?.error || null,
    };
  } catch (e) {
    const { kind, message } = classifyFetchError(e);
    return {
      ...empty,
      errorKind: kind,
      errorMessage: message,
      error: {
        code: kind === "timeout" ? "REQUEST_TIMEOUT" : "NETWORK_ERROR",
        message,
        status: 0,
      },
    };
  }
}

function refreshCfgStatus() {
  const base = normalizeBaseUrl($("#api_base")?.value);
  const token = ($("#api_token")?.value || "").trim();
  const hasSessionJwt = Number(sessionJwtExpiresAt || 0) > Date.now();
  const hasAuth = !!token || hasSessionJwt;

  if (!base) return setCfgStatus("err", "Falta API Base");
  if (!isSecureApiBase(base)) return setCfgStatus("err", "La API debe usar HTTPS");
  if (!hasAuth) return setCfgStatus("warn", "Falta autenticación");
  return setCfgStatus("ok", "Listo");
}

async function fetchApiConfig(apiBase, options = {}) {
  const networkOnly =
    String(options?.cacheMode || "default")
      .trim()
      .toLowerCase() === "network-only";
  if (!apiBase) return null;
  if (!isSecureApiBase(apiBase)) return null;
  if (!(await ensureApiHostPermission(apiBase, false))) return null;
  const controller = new AbortController();
  const to = setTimeout(() => controller.abort(), API_CONFIG_TIMEOUT_MS);
  try {
    const authHeaders = await getAuthHeadersFromBackground();
    const headers = authHeaders?.Authorization
      ? { Authorization: authHeaders.Authorization }
      : undefined;
    const url = buildApiUrl(apiBase, API_PATHS.config);
    const r = await fetch(url, {
      headers: buildClientHeaders(headers),
      signal: controller.signal,
      cache: networkOnly ? "no-store" : "default",
    });
    clearTimeout(to);
    if (!r.ok) return null;
    const raw = await r.json();
    const data = unwrapApiDataEnvelope(raw);
    return {
      max_message_length: data.max_message_length ?? 1000,
      min_message_length: data.min_message_length ?? 10,
      max_client_prompt_length: data.max_client_prompt_length ?? 2000,
    };
  } catch {
    clearTimeout(to);
    return null;
  }
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

function load() {
  chrome.storage.sync.get(
    {
      api_base: "",
      client_id_manual: "",
      client_id_source: "jwt",
      default_limit: 50,
      chatgpt_prompt: "",
      x_client_id: "",
    },
    (syncCfg) => {
      chrome.storage.local.get(
        { jwt_token: "", jwt_expires_at: 0, client_id: "" },
        async (localCfg) => {
          const sessionCfg = await storageSessionGet({ jwt_token: "", jwt_expires_at: 0 });
          const apiToken = "";
          const jwtToken = (localCfg.jwt_token || sessionCfg.jwt_token || "").trim();
          const jwtExpiresAt =
            Number(localCfg.jwt_expires_at || sessionCfg.jwt_expires_at || 0) || 0;
          const cfg = {
            ...syncCfg,
            ...localCfg,
            api_token: apiToken,
            jwt_token: jwtToken,
            jwt_expires_at: jwtExpiresAt,
          };
          if (cfg.x_client_id) {
            cfg.client_id_manual = cfg.client_id_manual || cfg.x_client_id;
            cfg.client_id_source = "manual";
          }
          const authState = await getAuthStateFromBackground();
          $("#api_base").value = cfg.api_base || "";
          $("#api_token").value = cfg.api_token || "";
          $("#default_limit").value = cfg.default_limit || 50;
          if ($("#health_ping_result")) $("#health_ping_result").value = "—";

          sessionJwtExpiresAt = Number(authState.accessExpiresAt || cfg.jwt_expires_at || 0) || 0;

          ["api_base", "api_token", "default_limit", "chatgpt_prompt"].forEach((id) => {
            const el = document.getElementById(id);
            if (el) el.addEventListener("input", refreshCfgStatus);
            if (el) el.addEventListener("change", refreshCfgStatus);
          });

          const promptTa = $("#chatgpt_prompt");
          if (promptTa) {
            promptTa.addEventListener("input", () =>
              applyPromptLimits({ max_client_prompt_length: PROMPT_MAX_CHARS })
            );
          }

          const base = normalizeBaseUrl(cfg.api_base);
          if (base) {
            fetchApiConfig(base).then((limits) => {
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
      );
    }
  );
}

async function performJwtLogin(requestPermission = false) {
  const base = normalizeBaseUrl($("#api_base").value);
  const apiKey = ($("#api_token").value || "").trim();

  if (!base)
    return {
      ok: false,
      status: 0,
      errorMessage: "Configura la API primero.",
      error: { code: "CONFIG_REQUIRED", message: "Configura la API primero." },
    };
  if (!isSecureApiBase(base))
    return {
      ok: false,
      status: 0,
      errorMessage: "La API debe usar HTTPS.",
      error: { code: "HTTPS_REQUIRED", message: "La API debe usar HTTPS." },
    };
  const hasPermission = await ensureApiHostPermission(base, requestPermission);
  if (!hasPermission) {
    return {
      ok: false,
      status: 0,
      errorMessage: "Falta permiso para conectar con el dominio de la API.",
      error: {
        code: "HOST_PERMISSION_REQUIRED",
        message: "Falta permiso para conectar con el dominio de la API.",
      },
    };
  }
  if (!apiKey)
    return {
      ok: false,
      status: 0,
      errorMessage: "Configura la API Key primero.",
      error: { code: "API_KEY_REQUIRED", message: "Configura la API Key primero." },
    };

  try {
    const loginResp = await chrome.runtime.sendMessage({
      action: "auth_login",
      api_base: base,
      api_token: apiKey,
    });
    if (!loginResp?.ok) {
      return {
        ok: false,
        status: Number(loginResp?.status || 0) || 0,
        errorMessage:
          String(loginResp?.errorMessage || "").trim() ||
          "No se pudo iniciar sesión. Revisá la API Key.",
        error: loginResp?.error || {
          code: "AUTH_ERROR",
          message: "No se pudo iniciar sesión. Revisá la API Key.",
        },
      };
    }
    const authState = await getAuthStateFromBackground();
    return {
      ok: true,
      jwt_expires_at: authState.accessExpiresAt,
      client_id: authState.clientId,
    };
  } catch {
    return {
      ok: false,
      status: 0,
      errorMessage: "Error de red o permisos.",
      error: { code: "NETWORK_ERROR", message: "Error de red o permisos." },
    };
  }
}

async function persistAuthState({ loginResult = null }) {
  const jwtExpiresAt = Number(loginResult?.jwt_expires_at || 0) || 0;
  const clientId = loginResult?.client_id != null ? String(loginResult.client_id) : "";
  await storageLocalSet({ jwt_expires_at: jwtExpiresAt });
  await storageLocalSet({ client_id: clientId });
  await clearPlanBlockState();
  await clearVersionBlockState();
  sessionJwtExpiresAt = jwtExpiresAt;
  hideVersionBlockScreen();
}

async function clearAuthState() {
  if (SESSION_AUTH_KEYS.length > 0) {
    await storageSessionRemove(SESSION_AUTH_KEYS);
  }
  sessionJwtExpiresAt = 0;
  await storageLocalRemove(["jwt_token", "jwt_expires_at"]);
  try {
    await chrome.runtime.sendMessage({ action: "auth_logout" });
  } catch {}
}

async function logoutSession({ allDevices = false } = {}) {
  let remoteResult = { ok: false, errorMessage: "No se pudo cerrar sesión en el servidor." };
  try {
    remoteResult = await chrome.runtime.sendMessage({
      action: allDevices ? "auth_logout_all" : "auth_logout",
      revoke_remote: true,
    });
  } catch {
    remoteResult = { ok: false, errorMessage: "No se pudo cerrar sesión en el servidor." };
  }

  await clearAuthState();
  if ($("#api_token")) $("#api_token").value = "";
  if ($("#health_ping_result")) $("#health_ping_result").value = "—";
  if ($("#health_result")) $("#health_result").value = "—";

  if (remoteResult.ok) {
    setSaveStatus(
      allDevices
        ? "Sesión cerrada en todos los dispositivos."
        : "Sesión cerrada en este dispositivo."
    );
  } else if (allDevices) {
    setSaveStatus("Sesión local cerrada. La revocación global no está disponible en tu API.", true);
  } else {
    setSaveStatus("Sesión local cerrada.");
  }
  refreshCfgStatus();
}

async function save() {
  const base = normalizeBaseUrl($("#api_base").value);
  const apiToken = ($("#api_token").value || "").trim();
  if (!isSecureApiBase(base)) {
    setSaveStatus("La API debe usar HTTPS.", true);
    return;
  }

  const syncCfg = {
    api_base: base,
    default_limit: parseInt($("#default_limit").value, 10) || 50,
    chatgpt_prompt: ($("#chatgpt_prompt").value || "").trim(),
  };

  const hasInputApiKey = !!apiToken;
  if (!hasInputApiKey) {
    await ensureAuthFromBackground(true);
    const authState = await getAuthStateFromBackground();
    if (authState.isAuthenticated) {
      chrome.storage.sync.set(syncCfg, async () => {
        await storageLocalSet({
          jwt_expires_at: Number(authState.accessExpiresAt || 0) || 0,
          client_id: String(authState.clientId || "").trim(),
        });
        sessionJwtExpiresAt = Number(authState.accessExpiresAt || 0) || 0;
        setSaveStatus("Guardado");
        refreshCfgStatus();
        fetchQuotas({ cacheMode: "network-only" });
      });
      return;
    }
  }

  setSaveStatus("Validando login…");
  const loginResult = await performJwtLogin(true);
  if (!loginResult.ok) {
    const failureType = classifyLoginFailure(loginResult);
    if (failureType === "update_required") {
      await persistVersionBlockState(loginResult);
      showVersionBlockScreen({
        message: loginResult?.errorMessage,
        details: loginResult?.error?.details,
        update_url:
          loginResult?.error?.details?.updateUrl || loginResult?.error?.details?.update_url,
      });
      setSaveStatus("Guardado, pero tu extension debe actualizarse para continuar.", true);
    } else if (failureType === "plan_expired") {
      await persistPlanBlockState(loginResult);
      await clearVersionBlockState();
      hideVersionBlockScreen();
      setSaveStatus(
        "Guardado, pero tu plan venció. Renovalo para seguir usando el servicio.",
        true
      );
    } else if (failureType === "rate_limit") {
      await clearPlanBlockState();
      await clearVersionBlockState();
      hideVersionBlockScreen();
      setSaveStatus(
        "Guardado, pero el login fue limitado temporalmente (429). Esperá unos segundos y reintentá.",
        true
      );
    } else if (failureType === "auth") {
      await clearPlanBlockState();
      await clearVersionBlockState();
      hideVersionBlockScreen();
      setSaveStatus("Guardado, pero no se pudo iniciar sesión. Revisá la API Key.", true);
    } else {
      await clearPlanBlockState();
      await clearVersionBlockState();
      hideVersionBlockScreen();
      setSaveStatus(
        "Guardado, pero no se pudo conectar con la API. Revisá URL base e intentá de nuevo.",
        true
      );
    }
    chrome.storage.sync.set(syncCfg, async () => {
      if (apiToken) await clearAuthState();
      refreshCfgStatus();
    });
    return;
  }

  chrome.storage.sync.set(syncCfg, async () => {
    await persistAuthState({ loginResult });
    setSaveStatus("Guardado");
    refreshCfgStatus();
    fetchQuotas({ cacheMode: "network-only" });
  });
}

async function testHealth() {
  const resultEl = $("#health_ping_result");
  if (resultEl) resultEl.value = "Probando…";

  const base = normalizeBaseUrl($("#api_base").value);
  const apiKey = ($("#api_token").value || "").trim();

  if (!base) {
    if (resultEl) resultEl.value = "Configura la API primero.";
    return;
  }
  if (!apiKey) {
    if (resultEl) resultEl.value = "Configura la API Key primero.";
    return;
  }

  const result = await performJwtLogin(true);
  if (!result.ok) {
    const failureType = classifyLoginFailure(result);
    if (failureType === "update_required") {
      await persistVersionBlockState(result);
      showVersionBlockScreen({
        message: result?.errorMessage,
        details: result?.error?.details,
        update_url: result?.error?.details?.updateUrl || result?.error?.details?.update_url,
      });
      await clearPlanBlockState();
    } else if (failureType === "plan_expired") {
      await persistPlanBlockState(result);
      await clearVersionBlockState();
      hideVersionBlockScreen();
    } else {
      await clearPlanBlockState();
      await clearVersionBlockState();
      hideVersionBlockScreen();
    }
    if (resultEl) {
      resultEl.value =
        failureType === "plan_expired"
          ? "Tu plan venció. Renovalo para seguir usando el servicio."
          : failureType === "update_required"
            ? "Debes actualizar la extension para continuar."
            : failureType === "rate_limit"
              ? "Login limitado temporalmente (429). Esperá unos segundos y reintentá."
              : failureType === "auth"
                ? "No se pudo iniciar sesión. Revisá la API Key."
                : "No se pudo conectar con la API. Revisá URL base e intentá de nuevo.";
    }
    setCfgStatus("err", "Login falló");
    return;
  }
  await persistAuthState({ loginResult: result });
  if (resultEl) resultEl.value = "Login OK";
  setCfgStatus("ok", "OK");
  fetchQuotas({ cacheMode: "network-only" });
}

async function test() {
  const base = normalizeBaseUrl($("#api_base").value);
  if (!base) return ($("#health_result").value = "Configura la API primero.");
  if (!isSecureApiBase(base)) return ($("#health_result").value = "La API debe usar HTTPS.");
  const hasPermission = await ensureApiHostPermission(base, true);
  if (!hasPermission)
    return ($("#health_result").value = "No se concedió permiso para el dominio de la API.");

  const url = buildApiUrl(base, API_PATHS.health);
  $("#health_result").value = "Probando…";

  try {
    const r = await fetch(url, { headers: buildClientHeaders(), cache: "no-store" });
    const t = await r.text();
    let data;
    try {
      data = t ? JSON.parse(t) : {};
    } catch {
      data = {};
    }
    if (r.ok) {
      $("#health_result").value = "OK";
      await clearVersionBlockState();
      hideVersionBlockScreen();
      setCfgStatus("ok", "API OK");
    } else {
      const failureType = classifyLoginFailure({ status: r.status, error: data?.error || {} });
      if (failureType === "update_required") {
        await persistVersionBlockState({ status: r.status, error: data?.error || {} });
        showVersionBlockScreen({
          message: toUserApiError(r.status, data || {}, t),
          details: data?.error?.details,
          update_url: data?.error?.details?.updateUrl || data?.error?.details?.update_url,
        });
      }
      const retrySec =
        typeof window.retryAfterFromResponse === "function"
          ? window.retryAfterFromResponse(r, data)
          : null;
      const msg = toUserApiError(r.status, data, t, retrySec);
      $("#health_result").value = msg;
      setCfgStatus("warn", r.status === 429 ? "Demasiadas solicitudes" : "API responde con error");
    }
  } catch (e) {
    logApiErrorDiagnostic("options.test_health.network_failure", e, {
      endpoint: API_PATHS.health,
    });
    $("#health_result").value = "Error de red o permisos. Revisá URL y permiso del dominio API.";
    setCfgStatus("err", "Sin conexión");
  }
}

// --- Cuotas (GET /ext/v2/limits) ---
function formatResetIn(isoStr) {
  if (!isoStr) return "";
  try {
    const then = new Date(isoStr);
    if (isNaN(then.getTime())) return "";
    const now = new Date();
    let ms = then - now;
    if (ms <= 0) return "Ya se restableció";
    const totalMinutes = Math.round(ms / 60000);
    if (totalMinutes < 1) return "menos de 1 min";
    if (totalMinutes < 60) return `${totalMinutes} min`;
    const h = Math.floor(ms / 3600000);
    const m = Math.round((ms % 3600000) / 60000);
    if (h >= 24) {
      const d = Math.floor(h / 24);
      return `${d}d ${m}m`;
    }
    return `${h}h ${m}m`;
  } catch {
    return "";
  }
}

function formatResetDate(isoStr) {
  if (!isoStr) return "";
  try {
    const raw = String(isoStr || "").trim();
    const m = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (!m) return "";
    const year = Number(m[1]);
    const monthNum = Number(m[2]);
    const day = Number(m[3]);
    const month = new Date(Date.UTC(year, monthNum - 1, 1)).toLocaleString("es-AR", {
      month: "long",
      timeZone: "UTC",
    });
    return `${day} de ${month}`;
  } catch {
    return "";
  }
}

/** Etiqueta de reset diario: ventana 24h si no hay uso; sino "Se restablece en: X" o "—". */
function formatResetLabel(used, resetAtIso) {
  if (used === 0) return "Se restablece al enviar el primer mensaje (ventana 24h).";
  const r = resetAtIso ? formatResetIn(resetAtIso) : "";
  return r ? "Se restablece en: " + r : "—";
}

function setQuotaBar(fillEl, parentProgress, value, maxVal) {
  if (!fillEl) return;
  const max = maxVal <= 0 ? 1 : maxVal;
  const pct = Math.min(100, Math.round((value / max) * 100));
  fillEl.style.width = pct + "%";
  const prog = parentProgress || fillEl.closest(".progress");
  if (prog) {
    prog.classList.remove("progress-warn", "progress-danger");
    if (pct >= 90) prog.classList.add("progress-danger");
    else if (pct >= 70) prog.classList.add("progress-warn");
  }
}

async function fetchQuotas(options = {}) {
  const networkOnly =
    String(options?.cacheMode || "default")
      .trim()
      .toLowerCase() === "network-only";
  const loadingEl = $("#quotas_loading");
  const contentEl = $("#quotas_content");
  const base = normalizeBaseUrl($("#api_base")?.value);
  if (!base) {
    if (loadingEl) loadingEl.textContent = "Configurá la API base.";
    if (contentEl) contentEl.style.display = "none";
    return;
  }
  if (!isSecureApiBase(base)) {
    if (loadingEl) loadingEl.textContent = "La API debe usar HTTPS.";
    if (contentEl) contentEl.style.display = "none";
    return;
  }
  if (!(await ensureApiHostPermission(base, false))) {
    if (loadingEl)
      loadingEl.textContent = "Concedé permiso al dominio de la API desde Guardar configuración.";
    if (contentEl) contentEl.style.display = "none";
    return;
  }

  const headers = await getAuthHeadersFromBackground();
  if (!headers.Authorization) {
    if (loadingEl) loadingEl.textContent = "Probar API Key para ver cuotas.";
    if (contentEl) contentEl.style.display = "none";
    return;
  }

  if (loadingEl) loadingEl.textContent = "Cargando cuotas…";

  let tabAccount = "no detectada";
  let fromAccount = "";
  try {
    const r = await chrome.runtime.sendMessage({ action: "get_logged_in_username" });
    if (r?.user_id) {
      tabAccount = "ID: " + r.user_id;
      fromAccount = String(r.user_id).trim();
    } else if (r?.username) {
      tabAccount = "@" + r.username;
      fromAccount = String(r.username).trim();
    } else if (r?.error === "no_instagram_tab") tabAccount = "abrí Instagram en una pestaña";
  } catch {}
  const tabEl = $("#quotas_tab_account");
  if (tabEl) tabEl.textContent = "Cuenta en pestaña: " + tabAccount;

  if (!fromAccount) {
    try {
      const ping = await fetchPingWithHeaders(base, headers, {
        cacheMode: networkOnly ? "network-only" : "default",
      });
      fromAccount = (ping?.accountUsername || "").trim();
    } catch {}
  }

  try {
    if (!fromAccount) {
      if (loadingEl)
        loadingEl.textContent =
          "No se pudo detectar from_account. Abrí Instagram o configurá una cuenta default en la API.";
      if (contentEl) contentEl.style.display = "none";
      return;
    }
    const query = new URLSearchParams({ from_account: fromAccount }).toString();
    const r = await apiFetch(base, `${API_PATHS.limits}?${query}`, {
      cacheMode: networkOnly ? "network-only" : "default",
    });
    const data = r?.data || null;
    const payload = unwrapApiDataEnvelope(data);
    if (!r?.ok || !data) {
      const failureType = classifyLoginFailure({
        status: r?.status || 0,
        error: data?.error || {},
      });
      if (failureType === "update_required") {
        await persistVersionBlockState({ status: r?.status || 0, error: data?.error || {} });
        showVersionBlockScreen({
          message: r?.errorMessage || toUserApiError(r?.status || 0, data || {}, ""),
          details: data?.error?.details,
          update_url: data?.error?.details?.updateUrl || data?.error?.details?.update_url,
        });
      }
      const retrySec = Number(r?.error?.retryAfterSec || 0) || null;
      const msg = r?.errorMessage
        ? r.errorMessage
        : r?.status
          ? toUserApiError(r.status, data || {}, "", retrySec)
          : "Error de red. Revisá token y API.";
      if (loadingEl) loadingEl.textContent = msg;
      if (contentEl) contentEl.style.display = "none";
      return;
    }
    const safety = Number(payload.limits?.safety_messages_per_day ?? 0);
    const planMonth = Number(payload.limits?.plan_messages_per_month ?? 0);
    const usedMonth = resolveUsedMonth(payload.messages, planMonth);
    const safeDailyLimit = Number.isFinite(safety) ? safety : 0;
    const safeMonthlyLimit = Number.isFinite(planMonth) ? planMonth : 0;
    const limitMonthStr = safeMonthlyLimit <= 0 ? "∞" : String(safeMonthlyLimit);
    const accounts = Array.isArray(payload.accounts) ? payload.accounts : [];

    await clearVersionBlockState();
    hideVersionBlockScreen();

    if (loadingEl) loadingEl.style.display = "none";
    if (contentEl) contentEl.style.display = "block";

    const barMonth = $("#quotas_bar_month");
    const valMonth = $("#quotas_value_month");
    const planNum = safeMonthlyLimit <= 0 ? 1 : safeMonthlyLimit;

    setQuotaBar(barMonth, barMonth?.closest(".progress"), usedMonth, planNum);
    if (valMonth) valMonth.textContent = usedMonth + " / " + limitMonthStr;

    const resetMonthEl = $("#quotas_reset_month");
    const resetMonthText = formatResetDate(payload.reset_at_monthly);
    if (resetMonthEl) resetMonthEl.textContent = `Próximo vencimiento: ${resetMonthText || "—"}`;

    const listEl = $("#quotas_accounts_list");
    if (listEl) {
      listEl.innerHTML = "";
      const items = accounts.length > 0 ? accounts : [];
      const showCookiePlaceholder =
        items.length === 0 &&
        tabAccount !== "no detectada" &&
        tabAccount !== "abrí Instagram en una pestaña";
      if (items.length === 0 && showCookiePlaceholder) {
        const limitStr = safeDailyLimit <= 0 ? "∞" : String(safeDailyLimit);
        const card = document.createElement("div");
        card.className = "quotas-account-card";
        card.innerHTML = renderPendingLinkAccountCard(
          tabAccount,
          limitStr,
          formatResetLabel(0, null),
          escapeHtml
        );
        listEl.appendChild(card);
      } else if (items.length === 0) {
        const card = document.createElement("div");
        card.className = "quotas-account-card";
        card.innerHTML = renderNoLinkedAccountsCard();
        listEl.appendChild(card);
      } else {
        items.forEach((acc, idx) => {
          const name =
            typeof acc === "object" && acc && acc.username != null ? acc.username : String(acc);
          const usedRaw =
            typeof acc === "object" && acc && acc.used_today != null ? acc.used_today : 0;
          const limRaw =
            typeof acc === "object" && acc && acc.daily_limit != null ? acc.daily_limit : safety;
          const used = Number(usedRaw) || 0;
          const lim = Number(limRaw);
          const safeAccLimit = Number.isFinite(lim) ? lim : 0;
          const limitStr = safeAccLimit <= 0 ? "∞" : String(safeAccLimit);
          const limNum = safeAccLimit <= 0 ? 1 : safeAccLimit;
          const resetAt = typeof acc === "object" && acc && acc.reset_at ? acc.reset_at : null;
          const resetText = formatResetLabel(used, resetAt);
          const barId = "q_bar_" + idx;
          const card = document.createElement("div");
          card.className = "quotas-account-card";
          card.innerHTML = renderQuotaAccountCard(
            name,
            used,
            limitStr,
            resetText,
            barId,
            escapeHtml
          );
          listEl.appendChild(card);
          const fillEl = document.getElementById(barId);
          const wrapEl = document.getElementById(barId + "_wrap");
          if (fillEl) setQuotaBar(fillEl, wrapEl, used, limNum);
        });
      }
    }
  } catch (e) {
    logApiErrorDiagnostic("options.fetch_quotas.network_failure", e, {
      endpoint: API_PATHS.limits,
    });
    if (loadingEl) loadingEl.textContent = "Error de red al cargar cuotas.";
    if (contentEl) contentEl.style.display = "none";
  }
}

let quotasRefreshInterval = null;

document.addEventListener("DOMContentLoaded", () => {
  load();
  setTimeout(verifyWithPing, 300);
  setTimeout(fetchQuotas, 500);
  // Actualización en tiempo real cada 30s
  if (quotasRefreshInterval) clearInterval(quotasRefreshInterval);
  quotasRefreshInterval = setInterval(() => {
    if (document.visibilityState === "hidden") return;
    fetchQuotas();
  }, OPTIONS_QUOTAS_REFRESH_MS);
});

$("#save").addEventListener("click", save);
$("#test").addEventListener("click", async () => {
  await test();
  const base = normalizeBaseUrl($("#api_base")?.value);
  if (base) {
    const limits = await fetchApiConfig(base, { cacheMode: "network-only" });
    if (limits) applyPromptLimits(limits);
  }
});
$("#test_health").addEventListener("click", async () => {
  await testHealth();
});
if ($("#logout_device")) {
  $("#logout_device").addEventListener("click", async () => {
    await logoutSession({ allDevices: false });
  });
}
if ($("#logout_all_devices")) {
  $("#logout_all_devices").addEventListener("click", async () => {
    await logoutSession({ allDevices: true });
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
