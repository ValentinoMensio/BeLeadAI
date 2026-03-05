/**
 * Mensajes de error amigables para respuestas de la API BeLeadAI.
 * ESM + compat legacy (window/globalThis).
 */

const MESSAGES = {
  400: {
    default: "Solicitud incorrecta. Revisá los datos enviados.",
    BAD_REQUEST: "Solicitud incorrecta. Revisá los datos enviados.",
    SEND_LIMIT_EXCEEDED:
      "Límite de envíos alcanzado. Esperá a que se reinicie la cuota (diaria o por hora).",
  },
  401: {
    default: "API key inválida o expirada. Revisá la key en Opciones.",
    UNAUTHORIZED: "API key inválida o expirada. Revisá la key en Opciones.",
  },
  403: {
    default: "No tenés permiso para esta acción.",
    FORBIDDEN: "No tenés permiso para esta acción.",
    FREE_PLAN_EXPIRED: "Tu plan Free venció. Contactanos para activar un plan.",
  },
  404: {
    default: "No encontrado. El recurso puede haber sido eliminado.",
    NOT_FOUND: "No encontrado. El recurso puede haber sido eliminado.",
  },
  409: {
    default: "Conflicto con el estado actual. Probá de nuevo.",
    CONFLICT: "Conflicto con el estado actual. Probá de nuevo.",
  },
  410: {
    default: "Endpoint removido. Actualizá la extensión para usar /ext/v2.",
    GONE: "Endpoint removido. Actualizá la extensión para usar /ext/v2.",
  },
  413: {
    default: "Los datos enviados son demasiado grandes.",
    PAYLOAD_TOO_LARGE: "Los datos enviados son demasiado grandes.",
  },
  426: {
    default: "Necesitás actualizar la extensión para continuar.",
    CLIENT_UPDATE_REQUIRED: "Necesitás actualizar la extensión para continuar.",
  },
  429: {
    default: "Demasiadas solicitudes. Esperá un momento antes de reintentar.",
    RATE_LIMIT_EXCEEDED: "Demasiadas solicitudes. Esperá un momento antes de reintentar.",
  },
  500: {
    default: "Error interno del servidor. Probá más tarde.",
    INTERNAL_ERROR: "Error interno del servidor. Probá más tarde.",
  },
  503: {
    default: "Servicio no disponible. Probá en unos minutos.",
    SERVICE_UNAVAILABLE: "Servicio no disponible. Probá en unos minutos.",
  },
};

function fallbackStatusMessage(status) {
  const s = Number(status || 0) || 0;
  if (s === 0) return "Error de conexión.";
  if (s >= 500) return "Error interno del servidor. Probá más tarde.";
  if (s === 429) return "Demasiadas solicitudes. Esperá un momento antes de reintentar.";
  if (s === 426) return "Necesitás actualizar la extensión para continuar.";
  if (s === 401) return "API key inválida o expirada. Revisá la key en Opciones.";
  if (s === 403) return "No tenés permiso para esta acción.";
  return "Error de la API.";
}

function toCountOrNull(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.floor(n);
}

function pickCount(details, keys) {
  for (const key of keys) {
    const val = toCountOrNull(details?.[key]);
    if (val != null) return val;
  }
  return null;
}

function resolveDailyLeadCounts(details) {
  const sent =
    pickCount(details, [
      "sent_today",
      "used_today",
      "messages_sent_today",
      "sent_followings_today",
      "followings_sent_today",
      "sent_followings",
    ]) ?? 0;

  const pendingDirect = pickCount(details, [
    "pending_followings",
    "pending_to_send",
    "pending_leads",
    "followings_pending_today",
  ]);

  const extracted = pickCount(details, [
    "extracted_followings_today",
    "followings_extracted_today",
    "extracted_today",
    "lead_generated_today",
    "matched_total",
  ]);

  const pending = pendingDirect ?? (extracted != null ? Math.max(0, extracted - sent) : 0);

  const requestedToAnalyze =
    pickCount(details, [
      "analyze_requested",
      "requested_to_analyze",
      "requested_limit",
      "requested",
    ]) ?? 0;

  const requestedToSend =
    pickCount(details, ["requested_to_send", "requested_send", "requested_limit", "requested"]) ??
    0;

  return { pending, sent, requestedToAnalyze, requestedToSend };
}

function resolveQuotaAction(details, errMessage = "", rawText = "") {
  const blockingQuota = String(details?.blocking_quota || "")
    .trim()
    .toLowerCase();
  const message = `${String(errMessage || "")} ${String(rawText || "")}`.toLowerCase();

  if (
    details?.requested_to_send != null ||
    details?.pending_to_send != null ||
    message.includes("encolar envío") ||
    message.includes("encolar envio") ||
    message.includes("send/enqueue")
  ) {
    return "send";
  }

  if (
    blockingQuota === "analyze_to_send_daily" ||
    details?.requested_to_analyze != null ||
    details?.analyze_requested != null ||
    message.includes("encolar followings") ||
    message.includes("analy")
  ) {
    return "analyze";
  }

  return "generic";
}

function formatAnalyzeToSendDailyMessage(details, action = "generic") {
  const { pending, sent, requestedToAnalyze, requestedToSend } = resolveDailyLeadCounts(details);
  const requestedNow = action === "send" ? requestedToSend : requestedToAnalyze;
  const requestedLabel =
    action === "send" ? "A enviar" : action === "analyze" ? "A analizar" : "Solicitados ahora";
  return (
    "Límite diario alcanzado. " +
    "Ya enviaste " +
    sent +
    " hoy. " +
    "Pendientes: " +
    pending +
    " · " +
    requestedLabel +
    ": " +
    requestedNow +
    "."
  );
}

function formatLegacyLeadsInsufficientMessage(errMessage, action = "generic") {
  const raw = String(errMessage || "").trim();
  if (!raw) return null;
  const requestedMatch = raw.match(/Pediste\s*(\d+)/i);
  const usedMatch = raw.match(/Usados?\s+hoy\s*(\d+)/i);
  const remainingMatch = raw.match(/te\s+quedan\s*(\d+)/i);
  if (!requestedMatch && !usedMatch && !remainingMatch) return null;
  const requestedNow = requestedMatch ? (toCountOrNull(requestedMatch[1]) ?? 0) : 0;
  const sent = usedMatch ? (toCountOrNull(usedMatch[1]) ?? 0) : 0;
  const pending = remainingMatch ? (toCountOrNull(remainingMatch[1]) ?? 0) : 0;
  const requestedLabel =
    action === "send" ? "A enviar" : action === "analyze" ? "A analizar" : "Solicitados ahora";
  return (
    "Cupo insuficiente. Pendientes: " +
    pending +
    " · Enviados: " +
    sent +
    " · " +
    requestedLabel +
    ": " +
    requestedNow +
    "."
  );
}

function formatBlockingQuotaError(data, rawText = "") {
  const err = data && data.error;
  if (!err || !err.details) return null;
  const details = err.details;
  const quota = details.blocking_quota;
  const action = resolveQuotaAction(details, err.message, rawText);
  if (!quota) return null;
  if (quota === "one_job_per_client") {
    return "Tenés una acción en curso. Esperá a que termine antes de iniciar otra.";
  }
  if (quota === "active_send_job") {
    return "Ya hay un envío activo para esta cuenta. Esperá a que termine o detenelo.";
  }
  if (quota === "active_job_by_client") {
    return "Tenés una tarea en curso. Esperá a que termine antes de iniciar otra.";
  }
  if (quota === "enqueue_lock_busy") {
    return "Ya hay una operación de encolado en curso. Reintentá en unos segundos.";
  }
  if (quota === "sender_offline") {
    return "No hay sender activo para esta cuenta. Iniciá el sender y reintentá.";
  }
  if (quota === "analyze_to_send_daily") {
    return formatAnalyzeToSendDailyMessage(details, action);
  }
  if (quota === "lead_generation_anti_abuse") {
    let base = err.message || "Demasiados leads generados para el nivel de envio actual.";
    const analyzed = details.analyzed_today != null ? Number(details.analyzed_today) : 0;
    const followingsRequested =
      details.followings_requested_today != null
        ? Number(details.followings_requested_today)
        : details.followings_limit_today != null
          ? Number(details.followings_limit_today)
          : 0;
    const generated =
      details.lead_generated_today != null
        ? Number(details.lead_generated_today)
        : Math.max(analyzed, followingsRequested);
    const cap = details.anti_abuse_cap != null ? Number(details.anti_abuse_cap) : null;
    const requested =
      details.requested_limit != null
        ? Number(details.requested_limit)
        : details.requested != null
          ? Number(details.requested)
          : null;
    if (cap != null && Number.isFinite(cap)) {
      base +=
        " Usado hoy: " +
        generated +
        " leads (analizados: " +
        analyzed +
        ", followings objetivo: " +
        followingsRequested +
        ") de " +
        cap +
        ".";
    }
    if (requested != null && Number.isFinite(requested) && requested > 0) {
      base += " Pedido actual: " + requested + ".";
    }
    return base;
  }
  return null;
}

function formatFollowingsQuotaError(data, rawText = "") {
  const err = data && data.error;
  if (!err) return null;
  const details = err.details || {};
  const action = resolveQuotaAction(details, err.message, rawText);
  const hasCountLikeDetail =
    details.requested != null ||
    details.requested_limit != null ||
    details.used_today != null ||
    details.sent_today != null ||
    details.pending_followings != null ||
    details.extracted_followings_today != null ||
    details.followings_extracted_today != null;
  if (!hasCountLikeDetail) return formatLegacyLeadsInsufficientMessage(err.message, action);
  return formatAnalyzeToSendDailyMessage(details, action);
}

export function formatApiErrorForUser(status, data, rawText, retryAfterSec) {
  const code = data && data.error && data.error.code ? data.error.code : "";
  const byStatus = MESSAGES[status];
  let message;
  if (
    (status === 400 || status === 409 || status === 422) &&
    (message = formatBlockingQuotaError(data, rawText))
  ) {
    // prioritized blocking quota message
  } else if (status === 400 && (message = formatFollowingsQuotaError(data, rawText))) {
    // prioritized followings quota message
  } else {
    message = (byStatus && (byStatus[code] || byStatus.default)) || fallbackStatusMessage(status);
  }

  if ((status === 429 || status === 503) && retryAfterSec != null && retryAfterSec > 1) {
    if (retryAfterSec >= 60) {
      message += " Reintentá en " + Math.ceil(retryAfterSec / 60) + " min.";
    } else {
      message += " Reintentá en " + retryAfterSec + " s.";
    }
  }
  return message;
}

export function getRetryAfterSec(resp) {
  if (!resp || (resp.status !== 429 && resp.status !== 503)) return null;
  const retryAfter = resp.headers && resp.headers.get("Retry-After");
  if (!retryAfter) return null;
  const seconds = parseInt(retryAfter, 10);
  return Number.isNaN(seconds) ? null : seconds;
}

export function retryAfterFromResponse(resp, data) {
  const fromHeader = getRetryAfterSec(resp);
  if (fromHeader != null) return fromHeader;
  if (
    data &&
    data.error &&
    data.error.details &&
    typeof data.error.details.retry_after === "number"
  ) {
    return data.error.details.retry_after;
  }
  return null;
}

if (typeof globalThis !== "undefined") {
  globalThis.formatApiErrorForUser = formatApiErrorForUser;
  globalThis.getRetryAfterSec = getRetryAfterSec;
  globalThis.retryAfterFromResponse = retryAfterFromResponse;
}
