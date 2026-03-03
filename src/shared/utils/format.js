/**
 * Formato: fechas, etiquetas de job, límites, reset.
 */

import { normalizeJobStatus } from "../domain/job-contract.js";

export function formatJobDate(createdAt) {
  if (!createdAt) return "";
  try {
    const d = new Date(createdAt);
    if (isNaN(d.getTime())) return "";
    const day = String(d.getDate()).padStart(2, "0");
    const month = String(d.getMonth() + 1).padStart(2, "0");
    const h = String(d.getHours()).padStart(2, "0");
    const min = String(d.getMinutes()).padStart(2, "0");
    return `${day}/${month} ${h}:${min}`;
  } catch {
    return "";
  }
}

export function formatJobKindLabel(kind, hasAnalyze = false) {
  if (
    hasAnalyze &&
    (kind === "fetch_followings" || kind === "followings_and_analyze" || kind === "followings_flow")
  ) {
    return "Analizar perfiles";
  }
  const map = {
    fetch_followings: "Obtener seguidores",
    analyze_profile: "Analizar perfiles",
    send_message: "Enviar mensajes",
    followings_and_analyze: "Analizar perfiles",
    followings_flow: "Analizar perfiles",
    followings_extract: "Obtener seguidores",
  };
  return map[kind] || kind || "—";
}

export function formatJobStatusLabel(status) {
  const normalized = normalizeJobStatus(status);
  const map = {
    pending: "En cola",
    completed: "✔ completado",
    running: "En curso",
    failed: "Fallido",
    canceled: "Cancelado",
  };
  return map[normalized] || normalized || "—";
}

/** countOrNull = número de prospectos cuando existe. */
export function formatJobOptionLabel(job, hasAnalyze = false, countOrNull = null) {
  const resultadoUtil =
    countOrNull != null
      ? `${countOrNull} prospecto${countOrNull === 1 ? "" : "s"}`
      : formatJobKindLabel(job.kind || "", hasAnalyze);
  const dateStr = formatJobDate(job.created_at);
  const statusLabel = formatJobStatusLabel(job.status || "");
  const parts = [resultadoUtil, dateStr, statusLabel].filter(Boolean);
  return parts.length ? parts.join(" · ") : job.id;
}

// --- Límites ---

export function isUnlimited(limit) {
  return limit == null || limit === -1 || limit === "" || (typeof limit === "number" && limit < 0);
}

export function formatLimitValue(used, limit) {
  const u = used ?? 0;
  if (isUnlimited(limit)) return `${u} / ∞`;
  return `${u} / ${limit}`;
}

export function limitClass(used, limit) {
  if (isUnlimited(limit)) return "limit-ok";
  if (!limit || limit <= 0) return "limit-ok";
  const pct = used / limit;
  if (pct >= 1) return "limit-blocked";
  if (pct >= 0.8) return "limit-warn";
  return "limit-ok";
}

export function limitLabel(cls) {
  if (cls === "limit-blocked") return "🔴 Bloqueado";
  if (cls === "limit-warn") return "🟡 Por llegar";
  return "OK";
}

export function formatResetIn(isoStr) {
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

export function formatResetDate(isoStr) {
  if (!isoStr) return "";
  try {
    const raw = String(isoStr || "").trim();
    const m = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (!m) {
      const d = new Date(raw);
      if (isNaN(d.getTime())) return "";
      const dayFallback = d.getDate();
      const monthFallback = d.toLocaleString("es-AR", { month: "long" });
      return `${dayFallback} de ${monthFallback}`;
    }
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

export function formatLastUpdate(error) {
  if (error) return "Sin conexión (mostrando último dato)";
  return "";
}
