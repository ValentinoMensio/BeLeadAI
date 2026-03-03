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

function getRawMessage(data, _rawText) {
  if (!data) return "";
  const err = data.error;
  if (err && (err.message || err.code)) return err.message || err.code;
  return "";
}

function formatBlockingQuotaError(data) {
  const err = data && data.error;
  if (!err || !err.details) return null;
  const details = err.details;
  const quota = details.blocking_quota;
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
    let base = err.message || "Límite diario de leads para enviar alcanzado.";
    const analyzed = details.analyzed_today != null ? details.analyzed_today : 0;
    const followings = details.followings_limit_today != null ? details.followings_limit_today : 0;
    const cap =
      details.cap_analyze_today != null
        ? details.cap_analyze_today
        : details.cap_leads_today != null
          ? details.cap_leads_today
          : null;
    if (cap != null) {
      base +=
        " Usado hoy: " +
        analyzed +
        " analizados + " +
        followings +
        " followings = " +
        (analyzed + followings) +
        " de " +
        cap +
        ".";
    }
    return base;
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

function formatFollowingsQuotaError(data) {
  const err = data && data.error;
  if (!err || !err.details) return null;
  const details = err.details;
  if (details.requested == null && details.limit == null) return null;
  let base = err.message || "Cuota insuficiente para más followings.";
  const parts = [];
  if (details.requested != null && details.limit != null) {
    parts.push("Pediste " + details.requested + ", el límite es " + details.limit + ".");
  }
  if (details.used_today != null) parts.push("usados hoy: " + details.used_today);
  if (details.pending_followings != null) parts.push("pendientes: " + details.pending_followings);
  if (parts.length > 1) base += " " + parts[0] + " (" + parts.slice(1).join(", ") + ")";
  else if (parts.length === 1) base += " " + parts[0];
  return base;
}

export function formatApiErrorForUser(status, data, rawText, retryAfterSec) {
  const code = data && data.error && data.error.code ? data.error.code : "";
  const byStatus = MESSAGES[status];
  let message;
  if ((status === 400 || status === 409 || status === 422) && (message = formatBlockingQuotaError(data))) {
    // prioritized blocking quota message
  } else if (status === 400 && (message = formatFollowingsQuotaError(data))) {
    // prioritized followings quota message
  } else {
    message =
      (byStatus && (byStatus[code] || byStatus.default)) ||
      getRawMessage(data, rawText) ||
      "Error de la API.";
  }

  if ((status === 429 || status === 503) && retryAfterSec != null && retryAfterSec > 0) {
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
  if (data && data.error && data.error.details && typeof data.error.details.retry_after === "number") {
    return data.error.details.retry_after;
  }
  return null;
}

if (typeof globalThis !== "undefined") {
  globalThis.formatApiErrorForUser = formatApiErrorForUser;
  globalThis.getRetryAfterSec = getRetryAfterSec;
  globalThis.retryAfterFromResponse = retryAfterFromResponse;
}
