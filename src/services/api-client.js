/**
 * Cliente API: fetch con auth desde background, timeout, errores normalizados.
 * No loguea tokens ni credenciales. Usa api-errors.js (global) para mensajes.
 */

import { API_PATHS } from "../config/endpoints.js";
import { buildClientHeaders } from "../shared/utils/client-metadata.js";
import { buildApiUrl } from "../shared/utils/url.js";
import {
  classifyRequestGroup,
  getCircuitBlock,
  markRateLimited,
  markRequestSuccess,
  runSingleFlight,
} from "./request-coordinator.js";

const DEFAULT_TIMEOUT_MS = 15000;
const VERSION_BLOCK_STATE_KEY = "version_block_state";
const READ_CACHE_MAX_ENTRIES = 120;

const READ_CACHE_POLICY = {
  ui_summary: { freshMs: 2500, staleMs: 120000 },
  ui_list: { freshMs: 3000, staleMs: 90000 },
  ui_limits: { freshMs: 8000, staleMs: 180000 },
  ui_recipients: { freshMs: 2500, staleMs: 120000 },
  default: { freshMs: 0, staleMs: 0 },
};

const readResponseCache = new Map();

function isUpdateRequiredError(status, data) {
  const code = String(data?.error?.code || "")
    .trim()
    .toUpperCase();
  return Number(status || 0) === 426 || code === "CLIENT_UPDATE_REQUIRED";
}

function persistVersionBlockState(status, data) {
  if (!chrome?.storage?.local) return;
  const details =
    data?.error?.details && typeof data.error.details === "object" ? data.error.details : {};
  const payload = {
    code: "CLIENT_UPDATE_REQUIRED",
    status: Number(status || 0) || 426,
    message: String(data?.error?.message || "A newer version of the extension is required.").trim(),
    details,
    update_url: String(details.updateUrl || details.update_url || "").trim(),
    ts: Date.now(),
  };
  try {
    chrome.storage.local.set({ [VERSION_BLOCK_STATE_KEY]: payload }, () => {});
  } catch {}
}

function clearVersionBlockState() {
  if (!chrome?.storage?.local) return;
  try {
    chrome.storage.local.remove([VERSION_BLOCK_STATE_KEY], () => {});
  } catch {}
}

function parseJsonSafe(text, fallback = {}) {
  try {
    return text ? JSON.parse(text) : fallback;
  } catch {
    return fallback;
  }
}

function getRetryAfterSec(resp, data) {
  if (!resp) return null;
  const raw = String(resp.headers?.get?.("Retry-After") || "").trim();
  const headerSec = Number(raw);
  if (Number.isFinite(headerSec) && headerSec > 0) return Math.round(headerSec);
  const detailSec = Number(data?.error?.details?.retry_after || 0);
  if (Number.isFinite(detailSec) && detailSec > 0) return Math.round(detailSec);
  return null;
}

function fallbackApiErrorMessage(status) {
  const s = Number(status || 0) || 0;
  if (s === 401) return "API key inválida o expirada. Revisá la key en Opciones.";
  if (s === 403) return "No tenés permiso para esta acción.";
  if (s === 404) return "No encontrado. El recurso puede haber sido eliminado.";
  if (s === 409) return "Conflicto con el estado actual. Probá de nuevo.";
  if (s === 410) return "Endpoint removido. Actualizá la extensión para usar /ext/v2.";
  if (s === 413) return "Los datos enviados son demasiado grandes.";
  if (s === 426) return "Necesitás actualizar la extensión para continuar.";
  if (s === 429) return "Demasiadas solicitudes. Esperá un momento antes de reintentar.";
  if (s === 503) return "Servicio no disponible. Probá en unos minutos.";
  if (s >= 500) return "Error interno del servidor. Probá más tarde.";
  if (s > 0) return `Error de la API (HTTP ${s}).`;
  return "Error de conexión.";
}

function toUserApiErrorMessage(status, data, rawText = "", retryAfterSec = null) {
  if (typeof window.formatApiErrorForUser === "function") {
    const formatted = window.formatApiErrorForUser(status, data, rawText, retryAfterSec);
    if (typeof formatted === "string" && formatted.trim()) return formatted.trim();
  }
  return fallbackApiErrorMessage(status);
}

function buildApiError(status, data, fallbackMessage = "Error de la API.", resp = null) {
  const code = String(data?.error?.code || "").trim() || null;
  const message = String(data?.error?.message || "").trim() || fallbackMessage;
  const details =
    data?.error?.details && typeof data.error.details === "object" ? data.error.details : null;
  const traceId =
    String(data?.error?.trace_id || "").trim() ||
    String(resp?.headers?.get?.("x-trace-id") || "").trim() ||
    null;
  const retryAfterSec = getRetryAfterSec(resp, data);
  return {
    code,
    message,
    details,
    traceId,
    retryAfterSec,
    status: Number(status || 0) || 0,
  };
}

function isSecureApiBase(baseUrl) {
  try {
    const u = new URL((baseUrl || "").trim());
    return u.protocol === "https:";
  } catch {
    return false;
  }
}

function cloneJsonSafe(value) {
  try {
    if (typeof structuredClone === "function") {
      return structuredClone(value);
    }
  } catch {}
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return value;
  }
}

function getReadCachePolicy(group) {
  return READ_CACHE_POLICY[group] || READ_CACHE_POLICY.default;
}

function buildReadCacheKey(method, url) {
  return `${String(method || "GET")
    .trim()
    .toUpperCase()}::${String(url || "").trim()}`;
}

function clearReadCache() {
  readResponseCache.clear();
}

function pruneReadCacheIfNeeded() {
  if (readResponseCache.size <= READ_CACHE_MAX_ENTRIES) return;
  let oldestKey = null;
  let oldestTs = Infinity;
  for (const [key, entry] of readResponseCache.entries()) {
    const ts = Number(entry?.ts || 0) || 0;
    if (ts < oldestTs) {
      oldestTs = ts;
      oldestKey = key;
    }
  }
  if (oldestKey) {
    readResponseCache.delete(oldestKey);
  }
}

function putReadCacheEntry(cacheKey, group, status, data) {
  if (!cacheKey) return;
  readResponseCache.set(cacheKey, {
    group,
    status: Number(status || 200) || 200,
    data: cloneJsonSafe(data),
    ts: Date.now(),
  });
  pruneReadCacheIfNeeded();
}

function getReadCacheEntry(cacheKey) {
  if (!cacheKey) return null;
  return readResponseCache.get(cacheKey) || null;
}

function toCachedApiResult(entry, reason, policy, nowMs = Date.now()) {
  if (!entry || !policy) return null;
  const ageMs = Math.max(0, nowMs - (Number(entry.ts || 0) || 0));
  return {
    ok: true,
    status: Number(entry.status || 200) || 200,
    data: cloneJsonSafe(entry.data),
    meta: {
      fromCache: true,
      stale: reason !== "fresh",
      reason,
      ageSec: Math.max(0, Math.round(ageMs / 1000)),
      maxFreshSec: Math.max(0, Math.round((policy.freshMs || 0) / 1000)),
      maxStaleSec: Math.max(0, Math.round((policy.staleMs || 0) / 1000)),
    },
  };
}

function getCachedApiResult(cacheKey, group, mode = "fresh") {
  const policy = getReadCachePolicy(group);
  if (!policy || (!policy.freshMs && !policy.staleMs)) return null;
  const entry = getReadCacheEntry(cacheKey);
  if (!entry) return null;
  const now = Date.now();
  const ageMs = Math.max(0, now - (Number(entry.ts || 0) || 0));
  if (mode === "fresh") {
    if (ageMs > Number(policy.freshMs || 0)) return null;
    return toCachedApiResult(entry, "fresh", policy, now);
  }
  if (mode === "stale") {
    if (ageMs > Number(policy.staleMs || 0)) return null;
    return toCachedApiResult(entry, "stale", policy, now);
  }
  return null;
}

function shouldCacheReadResponse(method, group, status) {
  const m = String(method || "")
    .trim()
    .toUpperCase();
  if (m !== "GET" && m !== "HEAD") return false;
  const policy = getReadCachePolicy(group);
  if (!policy || policy.freshMs <= 0) return false;
  const s = Number(status || 0) || 0;
  return s >= 200 && s < 300;
}

function isTransientResponseStatus(status) {
  const s = Number(status || 0) || 0;
  return s === 408 || s === 425 || s === 429 || s === 500 || s === 502 || s === 503 || s === 504;
}

/** Headers de auth desde background (centralizado; background puede refrescar JWT). */
export async function getAuthHeaders() {
  try {
    const r = await chrome.runtime.sendMessage({ action: "getAuthHeaders" });
    return r?.headers || {};
  } catch {
    return {};
  }
}

async function ensureFreshAccessToken() {
  try {
    const r = await chrome.runtime.sendMessage({ action: "auth_ensure_fresh_access", force: true });
    return !!r?.ok;
  } catch {
    return false;
  }
}

/**
 * @param {string} baseUrl - URL base (sin trailing slash)
 * @param {string} path - path relativo a la API
 * @param {{ method?: string, body?: string | object, headers?: Record<string,string>, timeoutMs?: number, cacheMode?: "default" | "network-only" }} options
 * @returns {Promise<{ ok: true, data: any, status: number } | { ok: false, status: number, data?: any, errorMessage: string, error: { code: string | null, message: string, details: any, traceId: string | null, retryAfterSec: number | null, status: number } }>}
 */
export async function apiFetch(baseUrl, path, options = {}) {
  const {
    method = "GET",
    body,
    headers: extraHeaders,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    cacheMode = "default",
  } = options;
  const methodUpper = String(method || "GET")
    .trim()
    .toUpperCase();
  const base = (baseUrl || "").trim().replace(/\/+$/, "");
  if (!base) {
    const error = buildApiError(0, {}, "URL base no configurada.");
    return { ok: false, status: 0, errorMessage: error.message, error };
  }
  if (!isSecureApiBase(base)) {
    const error = buildApiError(0, {}, "La URL base debe usar HTTPS.");
    return { ok: false, status: 0, errorMessage: error.message, error };
  }
  const pathRaw = String(path || "").trim() || "/";
  const pathForGrouping = pathRaw.split("?")[0] || pathRaw;
  const requestGroup = classifyRequestGroup(methodUpper, pathForGrouping);
  const url = buildApiUrl(base, pathRaw);
  const allowReadCache =
    String(cacheMode || "default")
      .trim()
      .toLowerCase() !== "network-only";
  const canUseReadCache = allowReadCache && (methodUpper === "GET" || methodUpper === "HEAD");
  const readCacheKey = canUseReadCache ? buildReadCacheKey(methodUpper, url) : "";

  if (readCacheKey) {
    const freshCached = getCachedApiResult(readCacheKey, requestGroup, "fresh");
    if (freshCached) return freshCached;
  }

  const circuit = getCircuitBlock(methodUpper, pathForGrouping);
  if (circuit.blocked) {
    if (readCacheKey) {
      const staleCached = getCachedApiResult(readCacheKey, requestGroup, "stale");
      if (staleCached?.meta) {
        staleCached.meta.reason = "circuit_open";
        return staleCached;
      }
    }
    const status = Number(circuit.status || 429) || 429;
    const code = status === 503 ? "SERVICE_UNAVAILABLE" : "RATE_LIMIT_EXCEEDED";
    const data = {
      error: {
        code,
        details: {
          retry_after: circuit.retryAfterSec,
          endpoint_group: circuit.group,
          blocking_quota: "client_circuit_breaker",
        },
      },
    };
    const errorMessage = toUserApiErrorMessage(status, data, "", circuit.retryAfterSec);
    const error = buildApiError(status, data, errorMessage);
    return { ok: false, status, data, errorMessage, error };
  }
  const headers = await getAuthHeaders();
  if (!headers.Authorization) {
    clearReadCache();
    const error = buildApiError(
      401,
      { error: { code: "AUTH_REQUIRED" } },
      "Faltan credenciales. Configurá en Opciones."
    );
    return { ok: false, status: 401, errorMessage: error.message, error };
  }

  const mergedHeaders = { ...headers, ...extraHeaders };
  const requestHeaders = buildClientHeaders(mergedHeaders);
  const bodyStr =
    body != null ? (typeof body === "string" ? body : JSON.stringify(body)) : undefined;
  return runSingleFlight(methodUpper, url, bodyStr, async () => {
    const controller = new AbortController();
    const to = timeoutMs ? setTimeout(() => controller.abort(), timeoutMs) : null;
    const doFetch = async (headersToUse) =>
      fetch(url, {
        method,
        headers: headersToUse,
        body: bodyStr,
        signal: controller.signal,
      });
    try {
      let resp = await doFetch(requestHeaders);
      if (resp.status === 401) {
        const refreshed = await ensureFreshAccessToken();
        if (refreshed) {
          const retryHeaders = await getAuthHeaders();
          const retryMerged = buildClientHeaders({ ...retryHeaders, ...extraHeaders });
          resp = await doFetch(retryMerged);
        }
      }
      if (to) clearTimeout(to);
      const text = await resp.text();
      const data = parseJsonSafe(text, { raw: text });
      if (!resp.ok) {
        if (isUpdateRequiredError(resp.status, data)) {
          persistVersionBlockState(resp.status, data);
        }
        let retrySec =
          typeof window.retryAfterFromResponse === "function"
            ? window.retryAfterFromResponse(resp, data)
            : null;
        if (resp.status === 429 || resp.status === 503) {
          const mark = markRateLimited(methodUpper, pathForGrouping, resp.status, retrySec || 0);
          if (!retrySec || retrySec <= 0) {
            retrySec = Math.max(1, Math.ceil(Number(mark.backoffMs || 0) / 1000));
          }
        }
        if ((resp.status === 401 || resp.status === 403) && canUseReadCache) {
          clearReadCache();
        }
        if (readCacheKey && isTransientResponseStatus(resp.status) && resp.status !== 426) {
          const staleCached = getCachedApiResult(readCacheKey, requestGroup, "stale");
          if (staleCached?.meta) {
            staleCached.meta.reason =
              resp.status === 429 || resp.status === 503 ? "rate_limited" : "upstream_error";
            return staleCached;
          }
        }
        const errorMessage = toUserApiErrorMessage(resp.status, data, text, retrySec);
        const error = buildApiError(resp.status, data, errorMessage, resp);
        return { ok: false, status: resp.status, data, errorMessage, error };
      }
      markRequestSuccess(methodUpper, pathForGrouping);
      clearVersionBlockState();
      if (readCacheKey && shouldCacheReadResponse(methodUpper, requestGroup, resp.status)) {
        putReadCacheEntry(readCacheKey, requestGroup, resp.status, data);
      }
      return { ok: true, data, status: resp.status };
    } catch (e) {
      if (to) clearTimeout(to);
      if (e?.name === "AbortError") {
        if (readCacheKey) {
          const staleCached = getCachedApiResult(readCacheKey, requestGroup, "stale");
          if (staleCached?.meta) {
            staleCached.meta.reason = "timeout";
            return staleCached;
          }
        }
        const error = buildApiError(
          0,
          { error: { code: "REQUEST_TIMEOUT" } },
          "La solicitud tardó demasiado."
        );
        return { ok: false, status: 0, errorMessage: error.message, error };
      }
      const msg = (e?.message || String(e)).toLowerCase();
      const errorMessage = msg.includes("cors")
        ? "La API no permite CORS desde la extensión."
        : msg.includes("failed to fetch") || msg.includes("networkerror")
          ? "Error de red. Verificá URL o conectividad."
          : "Error de conexión.";
      if (readCacheKey) {
        const staleCached = getCachedApiResult(readCacheKey, requestGroup, "stale");
        if (staleCached?.meta) {
          staleCached.meta.reason = "network_error";
          return staleCached;
        }
      }
      const error = buildApiError(0, { error: { code: "NETWORK_ERROR" } }, errorMessage);
      return { ok: false, status: 0, errorMessage: error.message, error };
    }
  });
}

/** Clasificación de error de fetch para mensaje preciso. */
export function classifyFetchError(e) {
  if (!e || typeof e !== "object") return { kind: "unknown", message: "Error de red." };
  const msg = (e.message || String(e)).toLowerCase();
  const name = (e.name || "").toLowerCase();
  if (name === "aborterror" || msg.includes("timeout") || msg.includes("timed out")) {
    return {
      kind: "timeout",
      message: "La API tardó demasiado. Revisá conectividad o servidor caído.",
    };
  }
  if (msg.includes("cors") || msg.includes("cross-origin")) {
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
      message: "Error de certificado/HTTPS. Probá con https:// y certificado válido.",
    };
  }
  if (
    msg.includes("failed to fetch") ||
    msg.includes("networkerror") ||
    msg.includes("load failed")
  ) {
    return { kind: "dns", message: "" };
  }
  return { kind: "unknown", message: "Error de red. Verificá URL, HTTPS o CORS." };
}

const PING_TIMEOUT_MS = 12000;

async function probeLoginFailure(cfg, options = {}) {
  const networkOnly =
    String(options?.cacheMode || "default")
      .trim()
      .toLowerCase() === "network-only";
  const apiKey = String(cfg?.api_token || "").trim();
  const apiBase = String(cfg?.api_base || "").trim();
  if (!apiKey || !apiBase || !isSecureApiBase(apiBase)) {
    return {
      errorCode: null,
      errorDetails: null,
      planName: null,
      apiErrorMessage: null,
      status: 0,
    };
  }
  try {
    const url = buildApiUrl(apiBase.replace(/\/+$/, ""), API_PATHS.authLogin);
    const resp = await fetch(url, {
      method: "POST",
      cache: networkOnly ? "no-store" : "default",
      headers: buildClientHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ api_key: apiKey, device_id: "00000000-0000-4000-8000-000000000099" }),
    });
    const text = await resp.text();
    const data = parseJsonSafe(text, {});
    const errorCode = data?.error?.code ? String(data.error.code) : null;
    const errorDetails =
      data?.error?.details && typeof data.error.details === "object" ? data.error.details : null;
    const planName =
      (errorDetails?.plan_name && String(errorDetails.plan_name).trim()) ||
      (errorDetails?.plan_id && String(errorDetails.plan_id).trim()) ||
      null;
    const retrySec = getRetryAfterSec(resp, data);
    const apiErrorMessage = toUserApiErrorMessage(resp.status, data, text, retrySec);
    return { errorCode, errorDetails, planName, apiErrorMessage, status: resp.status };
  } catch {
    return {
      errorCode: null,
      errorDetails: null,
      planName: null,
      apiErrorMessage: null,
      status: 0,
    };
  }
}

/** GET /config para límites de mensaje (max_message_length, etc.). */
export async function fetchApiConfig(apiBase) {
  if (!apiBase) return null;
  if (!isSecureApiBase(apiBase)) return null;
  try {
    const url = buildApiUrl((apiBase || "").trim().replace(/\/+$/, ""), API_PATHS.config);
    const r = await fetch(url, { headers: buildClientHeaders() });
    if (!r.ok) return null;
    const raw = await r.json();
    const data =
      raw?.data && typeof raw.data === "object" && !Array.isArray(raw.data) ? raw.data : raw;
    return {
      max_message_length: data.max_message_length ?? 1000,
      min_message_length: data.min_message_length ?? 10,
      max_client_prompt_length: data.max_client_prompt_length ?? 2000,
    };
  } catch {
    return null;
  }
}

/** GET /ext/v2/meta/version para política de actualización del cliente. */
export async function fetchVersionMeta(apiBase) {
  const base = (apiBase || "").trim().replace(/\/+$/, "");
  if (!base || !isSecureApiBase(base)) return null;
  try {
    const url = buildApiUrl(base, API_PATHS.metaVersion);
    const r = await fetch(url, { headers: buildClientHeaders() });
    const text = await r.text();
    const raw = parseJsonSafe(text, {});
    const data =
      raw?.data && typeof raw.data === "object" && !Array.isArray(raw.data) ? raw.data : raw;
    const blocked = !!data?.blocked;
    if (blocked) {
      persistVersionBlockState(426, {
        error: {
          code: "CLIENT_UPDATE_REQUIRED",
          message: String(data?.message || "A newer version of the extension is required."),
          details: {
            minRequiredVersion: data?.minRequiredVersion,
            latestVersion: data?.latestVersion,
            updateUrl: data?.updateUrl,
          },
        },
      });
    }
    return {
      blocked,
      minRequiredVersion: String(data?.minRequiredVersion || "").trim() || null,
      latestVersion: String(data?.latestVersion || "").trim() || null,
      updateUrl: String(data?.updateUrl || "").trim() || null,
      message: String(data?.message || "").trim() || null,
      blockedReason: String(data?.blockedReason || "").trim() || null,
      status: Number(r.status || 0) || 0,
    };
  } catch {
    return null;
  }
}

/** Valida URL + Token. GET /ext/v2/ping. No loguea credenciales. */
export async function fetchPing(cfg, options = {}) {
  const networkOnly =
    String(options?.cacheMode || "default")
      .trim()
      .toLowerCase() === "network-only";
  const base = (cfg?.api_base || "").trim().replace(/\/+$/, "");
  const empty = {
    urlOk: false,
    tokenOk: false,
    status: 0,
    accountUsername: null,
    defaultFromAccount: null,
    accounts: [],
    errorCode: null,
    errorDetails: null,
    planName: null,
    apiErrorMessage: null,
    error: null,
  };
  if (!base) return empty;
  if (!isSecureApiBase(base)) {
    const error = buildApiError(
      0,
      { error: { code: "HTTPS_REQUIRED" } },
      "La URL base debe usar HTTPS."
    );
    return { ...empty, errorMessage: error.message, error };
  }
  const headers = await getAuthHeaders();
  const pingPath = networkOnly
    ? `${API_PATHS.ping}${String(API_PATHS.ping).includes("?") ? "&" : "?"}_ts=${Date.now()}`
    : API_PATHS.ping;
  const url = buildApiUrl(base, pingPath);
  const controller = new AbortController();
  const to = setTimeout(() => controller.abort(), PING_TIMEOUT_MS);
  try {
    const r = await fetch(url, {
      headers: buildClientHeaders(headers),
      signal: controller.signal,
      cache: networkOnly ? "no-store" : "default",
    });
    clearTimeout(to);
    const text = await r.text();
    const parsed = parseJsonSafe(text, {});
    const data =
      parsed?.data && typeof parsed.data === "object" && !Array.isArray(parsed.data)
        ? parsed.data
        : parsed;
    const errorCode = parsed?.error?.code ? String(parsed.error.code) : null;
    const errorDetails =
      parsed?.error?.details && typeof parsed.error.details === "object"
        ? parsed.error.details
        : null;
    const apiErrorMessage = toUserApiErrorMessage(
      r.status,
      parsed,
      text,
      getRetryAfterSec(r, parsed)
    );
    const planName =
      (errorDetails?.plan_name && String(errorDetails.plan_name).trim()) ||
      (errorDetails?.plan_id && String(errorDetails.plan_id).trim()) ||
      null;
    const serverReachable = r.ok || r.status === 401 || r.status === 403;
    if (!serverReachable && !r.ok) {
      const fallbackMessage = toUserApiErrorMessage(
        r.status,
        parsed,
        text,
        getRetryAfterSec(r, parsed)
      );
      const error = buildApiError(r.status, parsed, fallbackMessage, r);
      return {
        urlOk: false,
        tokenOk: false,
        status: r.status,
        accountUsername: null,
        errorCode,
        errorDetails,
        planName,
        apiErrorMessage,
        error,
        errorMessage: error.message,
      };
    }
    if (!headers.Authorization) {
      const loginProbe = await probeLoginFailure(cfg, {
        cacheMode: networkOnly ? "network-only" : "default",
      });
      return {
        urlOk: true,
        tokenOk: false,
        status: r.status,
        accountUsername: null,
        accounts: [],
        defaultFromAccount: null,
        errorCode: loginProbe.errorCode || errorCode,
        errorDetails: loginProbe.errorDetails || errorDetails,
        planName: loginProbe.planName || planName,
        apiErrorMessage: loginProbe.apiErrorMessage || apiErrorMessage,
        error: buildApiError(
          loginProbe.status || r.status,
          {
            error: {
              code: loginProbe.errorCode || errorCode || "AUTH_REQUIRED",
              message: loginProbe.apiErrorMessage || apiErrorMessage || "Faltan credenciales.",
              details: loginProbe.errorDetails || errorDetails || null,
            },
          },
          loginProbe.apiErrorMessage || apiErrorMessage || "Faltan credenciales."
        ),
        errorMessage: loginProbe.apiErrorMessage || apiErrorMessage || "Faltan credenciales.",
      };
    }
    if (!r.ok) {
      if (isUpdateRequiredError(r.status, parsed)) {
        persistVersionBlockState(r.status, parsed);
      }
      const fallbackMessage = toUserApiErrorMessage(
        r.status,
        parsed,
        text,
        getRetryAfterSec(r, parsed)
      );
      const error = buildApiError(r.status, parsed, fallbackMessage, r);
      return {
        urlOk: true,
        tokenOk: r.status !== 401,
        status: r.status,
        accountUsername: null,
        accounts: [],
        defaultFromAccount: null,
        errorCode,
        errorDetails,
        planName,
        apiErrorMessage,
        error,
        errorMessage: error.message,
      };
    }
    const accounts = Array.isArray(data.accounts) ? data.accounts : [];
    const defaultFromAccount =
      data.default_from_account != null && String(data.default_from_account).trim()
        ? String(data.default_from_account).trim().toLowerCase()
        : null;
    const accountUsername = defaultFromAccount
      ? defaultFromAccount
      : accounts.length > 0
        ? String(accounts[0]).trim().toLowerCase()
        : null;
    clearVersionBlockState();
    return {
      urlOk: true,
      tokenOk: true,
      status: r.status,
      accountUsername,
      defaultFromAccount,
      accounts,
      errorCode,
      errorDetails,
      planName,
      apiErrorMessage,
    };
  } catch (e) {
    clearTimeout(to);
    const { message } = classifyFetchError(e);
    const error = buildApiError(
      0,
      { error: { code: "NETWORK_ERROR" } },
      message || "Error de red."
    );
    return { ...empty, errorMessage: error.message, error };
  }
}
