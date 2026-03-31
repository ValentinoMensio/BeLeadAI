import { API_PATHS } from "../../config/endpoints.js";
import { buildApiUrl } from "../../shared/utils/url.js";
import { buildClientHeaders } from "../../shared/utils/client-metadata.js";
import { logApiErrorDiagnostic } from "../../shared/errors/error-diagnostics.js";
import { classifyLoginFailure, isSecureApiBase, normalizeBaseUrl } from "./options-shared.js";

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

export function createOptionsHealthController(deps) {
  const { dom, auth, ui, services, versioning, helpers, config } = deps;
  const { $ } = dom;
  const { getAuthHeadersFromBackground, ensureApiHostPermission } = auth;
  const { setCfgStatus } = ui;
  const { fetchPingService } = services;
  const {
    persistVersionBlockState,
    clearVersionBlockState,
    showVersionBlockScreen,
    hideVersionBlockScreen,
  } = versioning;
  const { refreshCfgStatus } = helpers;

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
      setCfgStatus("err", `Auth falló (HTTP ${result.status})${hint}`);
      return;
    }
    refreshCfgStatus();
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
    const to = setTimeout(() => controller.abort(), config.apiConfigTimeoutMs);
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
        setCfgStatus(
          "warn",
          r.status === 429 ? "Demasiadas solicitudes" : "API responde con error"
        );
      }
    } catch (e) {
      logApiErrorDiagnostic("options.test_health.network_failure", e, {
        endpoint: API_PATHS.health,
      });
      $("#health_result").value = "Error de red o permisos. Revisá URL y permiso del dominio API.";
      setCfgStatus("err", "Sin conexión");
    }
  }

  return {
    classifyFetchError,
    toUserApiError,
    unwrapApiDataEnvelope,
    fetchPingWithHeaders,
    verifyWithPing,
    fetchApiConfig,
    test,
  };
}
