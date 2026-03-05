/**
 * Widget de límites: cache, fetch, render y detalle. No loguea credenciales.
 */

import { loadSettings } from "../../../services/settings-service.js";
import { apiFetch, fetchPing } from "../../../services/api-client.js";
import { API_PATHS } from "../../../config/endpoints.js";
import {
  isUnlimited,
  limitClass,
  formatResetIn,
  formatResetDate,
  formatLastUpdate,
} from "../../../shared/utils/format.js";
import { escapeHtml } from "../../../shared/utils/dom.js";

const LIMITS_CACHE_KEY = "limits_cache";
const LIMITS_CACHE_TTL_MS = 45 * 1000;
const LIMITS_DEBOUNCE_MS = 12 * 1000;

let limitsData = null;
let limitsLastFetchTime = 0;
let currentFromAccount = null;
let limitsBackoffUntilMs = 0;
let limitsBackoffStatus = 0;

function unwrapApiDataEnvelope(payload) {
  if (!payload || typeof payload !== "object") return {};
  const nested = payload.data;
  if (nested && typeof nested === "object" && !Array.isArray(nested)) return nested;
  return payload;
}

function toNumOrNull(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function resolveUsedToday(messages, safetyDaily) {
  const direct =
    toNumOrNull(messages?.used_today) ??
    toNumOrNull(messages?.used_day) ??
    toNumOrNull(messages?.sent_today) ??
    toNumOrNull(messages?.consumed_today);
  if (direct != null) return Math.max(0, direct);
  const remaining = toNumOrNull(messages?.remaining_today);
  const limit = toNumOrNull(safetyDaily);
  if (remaining != null && limit != null && limit > 0) return Math.max(0, limit - remaining);
  return 0;
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

function getLimitsFromCache() {
  return new Promise((resolve) => {
    chrome.storage.local.get({ [LIMITS_CACHE_KEY]: null }, (o) => {
      const raw = o[LIMITS_CACHE_KEY];
      if (!raw || !raw.data) return resolve(null);
      const age = Date.now() - (raw.ts || 0);
      if (age > LIMITS_CACHE_TTL_MS) return resolve(null);
      resolve({ data: raw.data, ts: raw.ts });
    });
  });
}

function setLimitsCache(data) {
  if (!data) return;
  chrome.storage.local.set({ [LIMITS_CACHE_KEY]: { data, ts: Date.now() } });
}

async function fetchLimits(signal = null) {
  void signal;
  const cfg = await loadSettings();
  if (!cfg.api_base) return { data: null, status: 0 };
  if (Date.now() < limitsBackoffUntilMs) {
    const remainingSec = Math.max(1, Math.ceil((limitsBackoffUntilMs - Date.now()) / 1000));
    const status = limitsBackoffStatus || 429;
    const baseMsg =
      status === 503
        ? "Servicio no disponible. Probá en unos minutos."
        : "Demasiadas solicitudes. Esperá un momento antes de reintentar.";
    return {
      data: null,
      status,
      errorMessage: `${baseMsg} Reintentá en ${remainingSec}s.`,
    };
  }
  try {
    if (new URL(cfg.api_base).protocol !== "https:") {
      return { data: null, status: 0, errorMessage: "La API debe usar HTTPS." };
    }
  } catch {
    return { data: null, status: 0, errorMessage: "URL base inválida." };
  }
  try {
    let fromAccount = "";
    try {
      const r = await chrome.runtime.sendMessage({ action: "get_logged_in_username" });
      fromAccount = ((r?.user_id != null ? String(r.user_id) : "") || r?.username || "").trim();
    } catch {}

    if (!fromAccount) {
      try {
        const ping = await fetchPing(cfg);
        fromAccount = (ping?.accountUsername || "").trim();
      } catch {}
    }

    if (!fromAccount) {
      return {
        data: null,
        status: 0,
        errorMessage:
          "No se pudo detectar from_account. Abrí Instagram o configurá una cuenta default en la API.",
      };
    }

    currentFromAccount = fromAccount;

    const query = new URLSearchParams({ from_account: fromAccount }).toString();
    const result = await apiFetch(cfg.api_base, `${API_PATHS.limits}?${query}`);
    if (!result?.ok) {
      const status = Number(result?.status || result?.error?.status || 0) || 0;
      if (status === 429 || status === 503) {
        const retryAfter = Number(
          result?.error?.retryAfterSec ??
            result?.error?.details?.retry_after ??
            result?.error?.details?.retry_after_sec ??
            0
        );
        const floorSec = status === 429 ? 8 : 4;
        const backoffSec =
          Number.isFinite(retryAfter) && retryAfter > 0
            ? Math.max(floorSec, Math.ceil(retryAfter))
            : floorSec;
        limitsBackoffUntilMs = Math.max(limitsBackoffUntilMs, Date.now() + backoffSec * 1000);
        limitsBackoffStatus = status;
      }
      return {
        data: null,
        status,
        errorMessage: result?.errorMessage || null,
      };
    }
    const data = unwrapApiDataEnvelope(result.data);
    limitsData = data;
    setLimitsCache(data);
    limitsBackoffUntilMs = 0;
    limitsBackoffStatus = 0;
    limitsLastFetchTime = Date.now();
    return { data, status: Number(result.status || 200) || 200 };
  } catch {
    return { data: null, status: 0, errorMessage: "Error de red. Verificá URL o conectividad." };
  }
}

function renderLimitsSummary(data, options = {}) {
  const {
    fromCache = false,
    fetchError = false,
    auth401 = false,
    errorMessage: networkErrorMessage = null,
  } = options;

  const widgetEl = document.getElementById("limits-widget");
  const summaryEl = document.getElementById("limits-summary");
  const circleDayEl = document.getElementById("limits-circle-day");
  const circleMonthEl = document.getElementById("limits-circle-month");
  const rowDayEl = document.getElementById("limits-row-day");
  const rowMonthEl = document.getElementById("limits-row-month");
  const alertEl = document.getElementById("limits-alert");
  const updateEl = document.getElementById("limits-update");

  if (!summaryEl) return;
  if (widgetEl) widgetEl.style.display = "block";
  summaryEl.classList.toggle("loading", !data && !fetchError);

  if (!data) {
    if (fromCache) return;
    if (circleDayEl) {
      circleDayEl.style.setProperty("--pct", "0");
      circleDayEl.setAttribute("aria-valuenow", 0);
    }
    if (circleMonthEl) {
      circleMonthEl.style.setProperty("--pct", "0");
      circleMonthEl.setAttribute("aria-valuenow", 0);
    }
    if (rowDayEl) rowDayEl.className = "limits-item limit-ok";
    if (rowMonthEl) rowMonthEl.className = "limits-item limit-ok";
    if (updateEl) {
      if (auth401) updateEl.textContent = "Sesión expirada. Abrí Opciones y probá la conexión.";
      else if (networkErrorMessage) updateEl.textContent = networkErrorMessage;
      else updateEl.textContent = formatLastUpdate(fetchError);
      updateEl.className = "limits-update" + (fetchError || auth401 ? " err" : "");
    }
    if (alertEl) {
      alertEl.classList.remove("open");
      if (auth401) {
        alertEl.classList.add("open");
        alertEl.innerHTML =
          '<div class="alert-title">⚠️ Sesión expirada</div><div class="alert-one-line">Abrí Opciones y probá la conexión para actualizar.</div>';
      } else if (networkErrorMessage) {
        alertEl.classList.add("open");
        alertEl.innerHTML =
          '<div class="alert-title">⚠️ Error de red</div><div class="alert-one-line">' +
          escapeHtml(networkErrorMessage) +
          "</div>";
      }
    }
    return;
  }

  limitsData = data;
  summaryEl.classList.remove("loading");

  const safetyDaily = data.limits?.safety_messages_per_day;
  const planMonth = data.limits?.plan_messages_per_month;
  const usedToday = resolveUsedToday(data.messages, safetyDaily);
  const usedMonth = resolveUsedMonth(data.messages, planMonth);
  const limitToday = isUnlimited(safetyDaily) ? null : (safetyDaily ?? 0);
  const limitMonth = isUnlimited(planMonth) ? null : (planMonth ?? 0);
  const classDay = limitClass(usedToday, limitToday);
  const classMonth = limitClass(usedMonth, limitMonth);

  const blocking = data.blocking_quota || null;

  const pctDay = limitToday && limitToday > 0 ? Math.min(100, (usedToday / limitToday) * 100) : 0;
  const pctMonth = limitMonth && limitMonth > 0 ? Math.min(100, (usedMonth / limitMonth) * 100) : 0;
  if (circleDayEl) {
    circleDayEl.style.setProperty("--pct", String(pctDay));
    circleDayEl.setAttribute("aria-valuenow", Math.round(pctDay));
  }
  if (circleMonthEl) {
    circleMonthEl.style.setProperty("--pct", String(pctMonth));
    circleMonthEl.setAttribute("aria-valuenow", Math.round(pctMonth));
  }

  if (rowDayEl) {
    rowDayEl.classList.remove("limit-ok", "limit-warn", "limit-blocked");
    rowDayEl.classList.add("limits-item", classDay);
  }
  if (rowMonthEl) {
    rowMonthEl.classList.remove("limit-ok", "limit-warn", "limit-blocked");
    rowMonthEl.classList.add("limits-item", classMonth);
  }

  if (alertEl) {
    alertEl.classList.remove(
      "open",
      "blocked-daily",
      "blocked-monthly",
      "blocked-analyses",
      "blocked-hourly"
    );
    alertEl.innerHTML = "";
    const dryRunEl = document.getElementById("dry_run");
    const sandboxNote = dryRunEl?.checked ? " Simulando (no se envía realmente)." : "";
    if (blocking === "safety_daily") {
      alertEl.classList.add("open", "blocked-daily");
      const resetIn = formatResetIn(data.reset_at_daily);
      alertEl.innerHTML =
        `<div class="alert-title">⛔ Límite diario (seguridad)</div>` +
        `<div class="alert-one-line">No podés enviar más mensajes hoy.${sandboxNote}</div>` +
        `<div class="alert-reset">Vuelve en ${resetIn || "—"}</div>` +
        `<div class="alert-link" data-detail-type="day">Ver detalles</div>`;
    } else if (blocking === "plan_messages_monthly") {
      alertEl.classList.add("open", "blocked-monthly");
      const resetDate = formatResetDate(data.reset_at_monthly);
      alertEl.innerHTML =
        `<div class="alert-title">⛔ Cuota mensual agotada</div>` +
        `<div class="alert-one-line">${usedMonth} / ${planMonth} mensajes este mes.${sandboxNote}</div>` +
        `<div class="alert-reset">Próximo vencimiento: ${resetDate || "—"}</div>` +
        `<div class="alert-link" data-detail-type="month">Ver detalles</div>`;
    } else if (blocking === "plan_analyses_monthly") {
      const usedAna = data.analyses?.used_this_month ?? 0;
      const limitAna = data.limits?.plan_analyses_per_month ?? 0;
      alertEl.classList.add("open", "blocked-analyses");
      alertEl.innerHTML =
        `<div class="alert-title">⛔ Cuota de análisis agotada</div>` +
        `<div class="alert-one-line">${usedAna} / ${limitAna} análisis este mes.${sandboxNote}</div>` +
        `<div class="alert-reset">Hasta el próximo ciclo.</div>`;
    } else if (blocking === "messages_hourly") {
      alertEl.classList.add("open", "blocked-hourly");
      alertEl.innerHTML =
        `<div class="alert-title">⛔ Límite por hora alcanzado</div>` +
        `<div class="alert-one-line">Ventana deslizante de 60 min.${sandboxNote}</div>` +
        `<div class="alert-reset">Reintentá en unos minutos.</div>`;
    }
    alertEl.querySelectorAll(".alert-link[data-detail-type]").forEach((link) => {
      link.addEventListener("click", (e) => {
        e.preventDefault();
        const t = link.getAttribute("data-detail-type");
        if (t) showLimitDetail(t);
      });
    });
    if (auth401) {
      alertEl.classList.add("open");
      alertEl.innerHTML =
        '<div class="alert-title">⚠️ Sesión expirada</div><div class="alert-one-line">Abrí Opciones y probá la conexión para actualizar.</div>';
    }
  }

  if (updateEl) {
    if (auth401) {
      updateEl.textContent = "Sesión expirada. Abrí Opciones y probá la conexión.";
      updateEl.className = "limits-update err";
    } else {
      updateEl.textContent = formatLastUpdate(fetchError);
      updateEl.className = "limits-update" + (fetchError ? " err" : "");
    }
  }
}

function showLimitDetail(type) {
  const detailEl = document.getElementById("limits-detail");
  if (!detailEl || !limitsData) return;
  if (detailEl.dataset.open === type) {
    detailEl.classList.remove("open", "border-ok", "border-warn", "border-blocked");
    detailEl.dataset.open = "";
    detailEl.innerHTML = "";
    return;
  }
  const safetyDaily = limitsData.limits?.safety_messages_per_day;
  const planMonth = limitsData.limits?.plan_messages_per_month;
  const usedToday = resolveUsedToday(limitsData.messages, safetyDaily);
  const usedMonth = resolveUsedMonth(limitsData.messages, planMonth);
  const limitToday = isUnlimited(safetyDaily) ? null : (safetyDaily ?? 0);
  const limitMonth = isUnlimited(planMonth) ? null : (planMonth ?? 0);
  const classDay = limitClass(usedToday, limitToday);
  const classMonth = limitClass(usedMonth, limitMonth);
  const planName = limitsData.plan_name || "Basic";

  const borderClass = type === "day" ? classDay : classMonth;
  const borderMap = {
    "limit-ok": "border-ok",
    "limit-warn": "border-warn",
    "limit-blocked": "border-blocked",
  };

  if (type === "day") {
    const accounts = Array.isArray(limitsData.accounts) ? limitsData.accounts : [];
    const loggedInAccount = accounts.find(
      (a) => (a.username || "").toLowerCase() === (currentFromAccount || "").toLowerCase()
    );
    const resetAt =
      loggedInAccount?.reset_at || (accounts.length > 0 ? accounts[0]?.reset_at : null);
    const resetIn = formatResetIn(resetAt);
    const resetLabel =
      usedToday === 0
        ? "Se restablece al enviar el primer mensaje (ventana 24h)."
        : resetIn
          ? `Se restablece en: ${resetIn}`
          : "—";
    let dayHtml = '<div class="detail-title">Límite diario por cuenta (seguridad)</div>';
    dayHtml += `<div class="detail-line">Enviados hoy: <strong>${usedToday}</strong> / ${limitToday != null ? limitToday : "∞"}</div>`;
    dayHtml += `<div class="detail-line reset-in">${escapeHtml(resetLabel)}</div>`;
    detailEl.innerHTML = dayHtml;
  } else {
    const resetDate = formatResetDate(limitsData.reset_at_monthly);
    const monthLimitLabel = limitMonth != null ? String(limitMonth) : "∞";
    detailEl.innerHTML =
      `<div class="detail-title">Cuota mensual (plan ${escapeHtml(planName)})</div>` +
      `<div class="detail-line">Enviados este ciclo: <strong>${usedMonth}</strong> / ${monthLimitLabel}</div>` +
      `<div class="detail-line reset-in">Próximo vencimiento: ${escapeHtml(resetDate || "—")}</div>`;
  }
  detailEl.classList.remove("border-ok", "border-warn", "border-blocked");
  if (borderMap[borderClass]) detailEl.classList.add(borderMap[borderClass]);
  detailEl.classList.add("open");
  detailEl.dataset.open = type;
}

export async function refreshLimitsWithCache(forceRefresh = false) {
  const widgetEl = document.getElementById("limits-widget");
  const summaryEl = document.getElementById("limits-summary");
  if (!summaryEl) return;
  if (widgetEl) widgetEl.style.display = "block";
  summaryEl.classList.add("loading");

  const opts = (ts, fromCache = false, fetchError = false) => ({
    updateTs: ts,
    fromCache,
    fetchError,
  });

  const cached = await getLimitsFromCache();
  if (cached?.data) {
    renderLimitsSummary(cached.data, opts(cached.ts, true));
  } else {
    renderLimitsSummary(null, {});
  }

  const now = Date.now();
  const debounce = !forceRefresh && now - limitsLastFetchTime < LIMITS_DEBOUNCE_MS;
  if (debounce && cached?.data) return;

  const result = await fetchLimits();
  const data = result?.data ?? null;
  const status = result?.status ?? 0;
  const auth401 = status === 401;
  const networkError = result?.errorMessage || null;
  if (data) {
    renderLimitsSummary(data, opts(Date.now()));
    const detailEl = document.getElementById("limits-detail");
    if (detailEl?.dataset?.open) showLimitDetail(detailEl.dataset.open);
  } else if (cached?.data) {
    renderLimitsSummary(cached.data, { ...opts(cached.ts, true, true), auth401 });
  } else {
    renderLimitsSummary(null, { fetchError: true, auth401, errorMessage: networkError });
  }
}

export { showLimitDetail };

export function getLimitsData() {
  return limitsData;
}
