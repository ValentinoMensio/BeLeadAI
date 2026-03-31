import {
  renderPendingLinkAccountCard,
  renderNoLinkedAccountsCard,
  renderQuotaAccountCard,
} from "./options-templates.js";
import { isSecureApiBase, normalizeBaseUrl, resolveUsedMonth } from "./options-shared.js";
import { API_PATHS } from "../../config/endpoints.js";
import { logApiErrorDiagnostic } from "../../shared/errors/error-diagnostics.js";

function formatResetIn(isoStr) {
  if (!isoStr) return "";
  try {
    const then = new Date(isoStr);
    if (isNaN(then.getTime())) return "";
    const now = new Date();
    const ms = then - now;
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

function formatResetLabel(used, resetAtIso) {
  if (used === 0) return "Se restablece al enviar el primer mensaje (ventana 24h).";
  const r = resetAtIso ? formatResetIn(resetAtIso) : "";
  return r ? `Se restablece en: ${r}` : "-";
}

function resolveSentToday(account) {
  const sent = Number(account?.sent_today ?? account?.messages_sent_today ?? account?.delivered_today ?? 0);
  return Number.isFinite(sent) && sent > 0 ? sent : 0;
}

function setQuotaBar(fillEl, parentProgress, value, maxVal) {
  if (!fillEl) return;
  const max = maxVal <= 0 ? 1 : maxVal;
  const pct = Math.min(100, Math.round((value / max) * 100));
  fillEl.style.width = `${pct}%`;
  const prog = parentProgress || fillEl.closest(".progress");
  if (prog) {
    prog.classList.remove("progress-warn", "progress-danger");
    if (pct >= 90) prog.classList.add("progress-danger");
    else if (pct >= 70) prog.classList.add("progress-warn");
  }
}

export function createOptionsQuotasController(deps) {
  const { dom, auth, services, helpers, config } = deps;
  const { $ } = dom;
  const { getAuthHeadersFromBackground, getLoggedInUsername } = auth;
  const { apiFetch, fetchPingWithHeaders } = services;
  const { ensureApiHostPermission } = helpers;
  const { refreshMs } = config;
  let quotasRefreshInterval = null;

  async function fetchQuotas(options = {}) {
    const networkOnly = String(options?.cacheMode || "default").trim().toLowerCase() === "network-only";
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
      if (loadingEl) loadingEl.textContent = "Concedé permiso al dominio de la API desde Guardar configuración.";
      if (contentEl) contentEl.style.display = "none";
      return;
    }

    const headers = await getAuthHeadersFromBackground();
    if (!headers.Authorization) {
      if (loadingEl) loadingEl.textContent = "Probar API Key para ver cuotas.";
      if (contentEl) contentEl.style.display = "none";
      return;
    }
    if (loadingEl) loadingEl.textContent = "Cargando cuotas...";

    let tabAccount = "no detectada";
    let fromAccount = "";
    try {
      const r = await getLoggedInUsername();
      if (r?.username) {
        const normalizedUsername = String(r.username).trim().toLowerCase();
        tabAccount = `@${normalizedUsername}`;
        fromAccount = normalizedUsername;
      } else if (r?.user_id) {
        const userId = String(r.user_id).trim();
        tabAccount = `ID: ${userId}`;
        fromAccount = userId;
      } else if (r?.error === "no_instagram_tab") tabAccount = "abrí Instagram en una pestaña";
    } catch {}
    const tabEl = $("#quotas_tab_account");
    if (tabEl) tabEl.textContent = `Cuenta en pestaña: ${tabAccount}`;

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
        if (loadingEl) {
          loadingEl.textContent =
            "No se pudo detectar from_account. Abrí Instagram o configurá una cuenta default en la API.";
        }
        if (contentEl) contentEl.style.display = "none";
        return;
      }
      const query = new URLSearchParams({ from_account: fromAccount }).toString();
      const r = await apiFetch(base, `${API_PATHS.limits}?${query}`, {
        cacheMode: networkOnly ? "network-only" : "default",
      });
      const data = r?.data || null;
      const payload = helpers.unwrapApiDataEnvelope(data);
      if (!r?.ok || !data) {
        const retrySec = Number(r?.error?.retryAfterSec || 0) || null;
        const msg = r?.errorMessage
          ? r.errorMessage
          : r?.status
            ? helpers.toUserApiError(r.status, data || {}, "", retrySec)
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

      if (loadingEl) loadingEl.style.display = "none";
      if (contentEl) contentEl.style.display = "block";

      const barMonth = $("#quotas_bar_month");
      const valMonth = $("#quotas_value_month");
      const planNum = safeMonthlyLimit <= 0 ? 1 : safeMonthlyLimit;
      setQuotaBar(barMonth, barMonth?.closest(".progress"), usedMonth, planNum);
      if (valMonth) valMonth.textContent = `${usedMonth} / ${limitMonthStr}`;

      const resetMonthEl = $("#quotas_reset_month");
      const resetMonthText = formatResetDate(payload.reset_at_monthly);
      if (resetMonthEl) resetMonthEl.textContent = `Próximo vencimiento: ${resetMonthText || "-"}`;

      const listEl = $("#quotas_accounts_list");
      if (listEl) {
        listEl.replaceChildren();
        const items = accounts.length > 0 ? accounts : [];
        const showCookiePlaceholder =
          items.length === 0 &&
          tabAccount !== "no detectada" &&
          tabAccount !== "abrí Instagram en una pestaña";
        if (items.length === 0 && showCookiePlaceholder) {
          const limitStr = safeDailyLimit <= 0 ? "∞" : String(safeDailyLimit);
          const card = document.createElement("div");
          card.className = "quotas-account-card";
          card.replaceChildren(renderPendingLinkAccountCard(tabAccount, limitStr, formatResetLabel(0, null)));
          listEl.appendChild(card);
        } else if (items.length === 0) {
          const card = document.createElement("div");
          card.className = "quotas-account-card";
          card.replaceChildren(renderNoLinkedAccountsCard());
          listEl.appendChild(card);
        } else {
          items.forEach((acc, idx) => {
            const name = typeof acc === "object" && acc && acc.username != null ? acc.username : String(acc);
            const usedRaw = resolveSentToday(acc);
            const limRaw = typeof acc === "object" && acc && acc.daily_limit != null ? acc.daily_limit : safety;
            const used = Number(usedRaw) || 0;
            const lim = Number(limRaw);
            const safeAccLimit = Number.isFinite(lim) ? lim : 0;
            const limitStr = safeAccLimit <= 0 ? "∞" : String(safeAccLimit);
            const limNum = safeAccLimit <= 0 ? 1 : safeAccLimit;
            const resetAt = typeof acc === "object" && acc && acc.reset_at ? acc.reset_at : null;
            const resetText = formatResetLabel(used, resetAt);
            const barId = `q_bar_${idx}`;
            const card = document.createElement("div");
            card.className = "quotas-account-card";
            card.replaceChildren(renderQuotaAccountCard(name, used, limitStr, resetText, barId));
            listEl.appendChild(card);
            const fillEl = document.getElementById(barId);
            const wrapEl = document.getElementById(`${barId}_wrap`);
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

  function startAutoRefresh() {
    if (quotasRefreshInterval) clearInterval(quotasRefreshInterval);
    quotasRefreshInterval = setInterval(() => {
      if (document.visibilityState === "hidden") return;
      fetchQuotas();
    }, refreshMs);
  }

  return {
    fetchQuotas,
    startAutoRefresh,
  };
}
