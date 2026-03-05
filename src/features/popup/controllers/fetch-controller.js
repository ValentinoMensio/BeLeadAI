/**
 * Controlador TAB Analizar: enqueue followings/analyze, últimos jobs, progreso del job seleccionado.
 */

import { API_PATHS } from "../../../config/endpoints.js";
import {
  isTerminalJobStatus,
  normalizeEntityType,
  normalizeJobStatus,
} from "../../../shared/domain/job-contract.js";
import { logApiErrorDiagnostic } from "../../../shared/errors/error-diagnostics.js";

const DEEP_RUBROS_OPTIONS = [
  "Health_Medical",
  "Fitness_Wellness",
  "Legal_Accounting_Finance",
  "Real_Estate_Construction",
  "Food_Beverage_Hospitality",
  "Beauty_Fashion_Personal_Care",
  "Marketing_Advertising_PR",
  "Creative_Media_Audiovisual",
  "Education_Training",
  "Brands_Commerce_Retail",
  "Influencer_Creator_Public_Figure",
  "Business_Tech_Industry",
  "Government_NGO_Religion",
  "Travel_Tourism_Recreation",
  "Other",
];

const DEEP_RUBROS_LABELS = {
  Health_Medical: "Salud",
  Fitness_Wellness: "Fitness",
  Legal_Accounting_Finance: "Legal y finanzas",
  Real_Estate_Construction: "Inmobiliaria",
  Food_Beverage_Hospitality: "Gastronomia",
  Beauty_Fashion_Personal_Care: "Belleza",
  Marketing_Advertising_PR: "Marketing",
  Creative_Media_Audiovisual: "Creativo",
  Education_Training: "Educacion",
  Brands_Commerce_Retail: "Comercio",
  Influencer_Creator_Public_Figure: "Influencer",
  Business_Tech_Industry: "Tecnologia",
  Government_NGO_Religion: "Gobierno/ONG",
  Travel_Tourism_Recreation: "Turismo",
  Other: "Otros",
};

const LEGACY_RUBRO_MAP = {
  Salud: "Health_Medical",
  Fitness_Bienestar: "Fitness_Wellness",
  Legal_Contable: "Legal_Accounting_Finance",
  Inmobiliaria: "Real_Estate_Construction",
  Gastronomia: "Food_Beverage_Hospitality",
  Belleza_Estetica: "Beauty_Fashion_Personal_Care",
  Marketing_Publicidad: "Marketing_Advertising_PR",
  Creativo_Audiovisual: "Creative_Media_Audiovisual",
  Educacion_Formacion: "Education_Training",
  Marca_Comercio: "Brands_Commerce_Retail",
  Influencer_Creador: "Influencer_Creator_Public_Figure",
  Doctor: "Health_Medical",
  Nutricionista: "Health_Medical",
  Gimnasio: "Fitness_Wellness",
  Abogado: "Legal_Accounting_Finance",
  Restaurante: "Food_Beverage_Hospitality",
  Belleza: "Beauty_Fashion_Personal_Care",
  Fotografo: "Creative_Media_Audiovisual",
  Coach: "Education_Training",
  Marca: "Brands_Commerce_Retail",
};

function toCanonicalDeepRubro(v) {
  const raw = String(v || "").trim();
  if (!raw) return "";
  return LEGACY_RUBRO_MAP[raw] || raw;
}
const STATUS_CHECK_INTERVAL_MS = 7000;

window.selectedDeepRubros = window.selectedDeepRubros || new Set();

function toCanonicalResultId(value, kindHint = "job") {
  const raw = String(value || "").trim();
  if (!raw) return "";
  if (raw.includes(":")) return raw;
  const kind = normalizeEntityType(kindHint);
  if (kind === "flow") return `flow:${raw}`;
  return raw;
}

/**
 * @param {{ store, services, ui, dom }} deps
 * @returns {{ refreshJobsList, refreshSelectedJobProgress, showJobStatusSection, bindFetchEvents }}
 */
export function initFetchTab(deps) {
  const { store, services, ui, dom } = deps;
  const { getState, setState } = store;
  const {
    loadSettings,
    saveSettings,
    getAuthHeaders,
    apiFetch,
    loadLastJobsService,
    loadJobSummary,
  } = services;
  const { setStatus, renderJobsList, renderJobDetails, getLimitsData } = ui;
  const { qs } = dom;

  let refreshJobsListInFlight = null;
  let autoRefreshInFlight = false;
  let delayedProgressTimerId = null;
  let fetchApiBackoffUntil = 0;
  let lastRateLimitJobsLogTs = 0;
  let lastRateLimitSummaryLogTs = 0;
  let lastJobStatusWasRateLimited = false;

  function hasFetchErrorVisible() {
    const el = qs("#status");
    return !!(el && el.classList.contains("err"));
  }

  function setFetchStatus(msg, isErr = false, { force = false } = {}) {
    if (!msg) return;
    if (isErr) {
      setStatus(msg, true);
      return;
    }
    if (!force && hasFetchErrorVisible()) return;
    setStatus(msg, false);
  }

  function updateFetchSyncLabel() {
    const syncEl = qs("#fetch_last_sync");
    if (!syncEl) return;
    syncEl.textContent = `Ultima sincronizacion: ${new Date().toLocaleTimeString()}`;
  }

  function hasFetchApiBackoff() {
    return fetchApiBackoffUntil > Date.now();
  }

  function retryAfterFromResult(result) {
    const retry = Number(
      result?.error?.retryAfterSec ??
        result?.error?.details?.retry_after ??
        result?.error?.details?.retry_after_sec ??
        result?.error?.details?.retryAfter
    );
    if (!Number.isFinite(retry) || retry <= 0) return 0;
    return Math.ceil(retry);
  }

  function applyFetchApiBackoff(result) {
    const status = Number(result?.status || result?.error?.status || 0) || 0;
    if (status !== 429 && status !== 503) return 0;
    const retryAfterSec = retryAfterFromResult(result);
    const floorSec = status === 429 ? 5 : 3;
    const backoffSec = Math.max(floorSec, retryAfterSec || 0);
    fetchApiBackoffUntil = Math.max(fetchApiBackoffUntil, Date.now() + backoffSec * 1000);
    return backoffSec;
  }

  function clearDelayedProgressTimer() {
    if (!delayedProgressTimerId) return;
    clearTimeout(delayedProgressTimerId);
    delayedProgressTimerId = null;
  }

  function scheduleDelayedProgressRefresh(delayMs = 1000) {
    clearDelayedProgressTimer();
    delayedProgressTimerId = setTimeout(
      async () => {
        delayedProgressTimerId = null;
        try {
          await refreshSelectedJobProgress();
          startAutoRefresh(STATUS_CHECK_INTERVAL_MS);
        } catch {
          setFetchStatus("No se pudo refrescar el estado del job.", true);
        }
      },
      Math.max(0, Number(delayMs || 0))
    );
  }

  function shouldPollJobProgress(stats) {
    if (!stats || typeof stats !== "object") return false;
    const queued = Number(stats.queued || 0) || 0;
    const sent = Number(stats.sent || 0) || 0;
    if (queued > 0 || sent > 0) return true;
    const status = normalizeJobStatus(stats.status);
    if (!status) return false;
    return !isTerminalJobStatus(status);
  }

  function syncAutoRefresh(stats) {
    const hasInterval = !!getState().statusCheckInterval;
    const shouldPoll = shouldPollJobProgress(stats);
    if (shouldPoll && !hasInterval) {
      startAutoRefresh(STATUS_CHECK_INTERVAL_MS);
      return;
    }
    if (!shouldPoll && hasInterval) {
      stopAutoRefresh();
    }
  }

  function getRemainingMessagesForLeads() {
    const limits = typeof getLimitsData === "function" ? getLimitsData() : null;
    if (!limits || !limits.messages) return null;
    const remToday = Number(limits.messages.remaining_today);
    const remMonth = Number(limits.messages.remaining_this_month);
    const remHour = Number(limits.messages.remaining_hour);
    const vals = [remToday, remMonth, remHour].filter((v) => Number.isFinite(v) && v >= 0);
    if (!vals.length) return null;
    return Math.max(0, Math.min(...vals));
  }

  function enforceLimitInputByRemainingMessages(showMessage = false) {
    const limitInput = qs("#limit");
    if (!limitInput) return null;
    const remaining = getRemainingMessagesForLeads();
    if (!Number.isFinite(remaining)) {
      limitInput.removeAttribute("max");
      return null;
    }
    limitInput.max = String(remaining);
    let current = parseInt(limitInput.value || "0", 10);
    if (!Number.isFinite(current) || current <= 0) current = 1;
    if (current > remaining) {
      limitInput.value = String(Math.max(1, remaining));
      if (showMessage) {
        setFetchStatus(`Leads ajustados a ${remaining} (mensajes restantes).`, true);
      }
    }
    return remaining;
  }

  async function checkJobStatus(jobId) {
    if (hasFetchApiBackoff()) {
      lastJobStatusWasRateLimited = true;
      updateFetchSyncLabel();
      return null;
    }
    const cfg = await loadSettings();
    const base = (cfg.api_base || "").trim().replace(/\/+$/, "");
    if (!base) {
      setFetchStatus("Configurá la conexión primero", true);
      return null;
    }
    const resultId = toCanonicalResultId(jobId, "result");
    const mainSummary = await loadJobSummary(base, resultId);
    if (!mainSummary?.ok) {
      const backoffSec = applyFetchApiBackoff(mainSummary);
      if (Number(mainSummary?.error?.status || 0) === 401) {
        setFetchStatus("Sesion expirada. Proba la conexion en Opciones.", true);
        await saveSettings({ jwt_token: "", jwt_expires_at: 0 });
        return null;
      }
      const summaryStatus = Number(mainSummary?.error?.status || 0);
      const summaryCode = String(mainSummary?.error?.code || "")
        .trim()
        .toUpperCase();
      if (summaryStatus === 404 || summaryStatus === 422 || summaryCode === "RESULT_ID_REQUIRED") {
        lastJobStatusWasRateLimited = false;
        setFetchStatus("No se encontro el resultado", true);
        setState({ currentJobId: null });
        stopAutoRefresh();
        await new Promise((resolve) => {
          chrome.storage.local.remove(["last_job_id", "last_flow_id"], () => resolve());
        });
        const sel = qs("#last_jobs_select");
        if (sel) sel.value = "";
      } else {
        const isRateLimited = summaryStatus === 429 || summaryStatus === 503;
        lastJobStatusWasRateLimited = isRateLimited;
        const now = Date.now();
        if (!isRateLimited || now - lastRateLimitSummaryLogTs >= 12000) {
          logApiErrorDiagnostic("fetch.check_job_status.summary_failed", mainSummary, {
            resultId,
            backoffSec,
          });
          if (isRateLimited) lastRateLimitSummaryLogTs = now;
        }
        if (isRateLimited) {
          setFetchStatus("Sincronizando resultados...", false);
        } else {
          setFetchStatus(mainSummary?.errorMessage || "No se pudo cargar el estado", true);
        }
      }
      return null;
    }
    lastJobStatusWasRateLimited = false;
    const mainStats = mainSummary.data;
    if (!mainStats || typeof mainStats !== "object") {
      setFetchStatus("No se encontro el resultado", true);
      return null;
    }
    const mainKind = String(mainStats.kind || "").toLowerCase();
    const isFlow = mainKind === "followings_flow";
    if (isFlow) {
      return {
        queued: mainStats.queued || 0,
        sent: mainStats.sent || 0,
        ok: mainStats.ok || 0,
        error: mainStats.error || 0,
        hasAnalyzeJob: true,
        analyzeJobId: null,
        kind: mainStats.kind || "followings_flow",
        mainQueued: 0,
        mainSent: 0,
        roundsDone: Number(mainStats.rounds_done || 0),
        matchedTotal: Number(mainStats.matched_total || 0),
        scannedTotal: Number(mainStats.scanned_total || 0),
        leadTarget: Number(mainStats.lead_target || 0),
        stopReason: mainStats.stop_reason || "",
        status: mainStats.status || "",
      };
    }
    const analyzeJobId = toCanonicalResultId(mainStats.related_analyze_job_id || "", "job");
    const analyzeSummary = analyzeJobId ? await loadJobSummary(base, analyzeJobId) : null;
    const analyzeExists = !!(analyzeSummary?.ok && analyzeSummary?.data);
    const analyzeStats = analyzeExists ? analyzeSummary.data : null;
    const sameCanonical =
      analyzeExists &&
      mainStats.resolved_job_id &&
      mainStats.resolved_job_id === analyzeStats.resolved_job_id;
    const hasAnalyze = analyzeExists && !sameCanonical;
    if (hasAnalyze) {
      return {
        queued: analyzeStats.queued || 0,
        sent: analyzeStats.sent || 0,
        ok: analyzeStats.ok || 0,
        error: analyzeStats.error || 0,
        hasAnalyzeJob: true,
        analyzeJobId,
        kind: analyzeStats.kind || "analyze_profile",
        mainQueued: mainStats.queued || 0,
        mainSent: mainStats.sent || 0,
      };
    }
    return {
      queued: mainStats.queued || 0,
      sent: mainStats.sent || 0,
      ok: mainStats.ok || 0,
      error: mainStats.error || 0,
      hasAnalyzeJob: false,
      analyzeJobId: null,
      kind: mainStats.kind || "",
      mainQueued: 0,
      mainSent: 0,
    };
  }

  function stopAutoRefresh() {
    const s = getState();
    if (s.statusCheckInterval) {
      clearInterval(s.statusCheckInterval);
      setState({ statusCheckInterval: null });
    }
    autoRefreshInFlight = false;
  }

  function startAutoRefresh(intervalMs = STATUS_CHECK_INTERVAL_MS) {
    stopAutoRefresh();
    const id = setInterval(async () => {
      if (autoRefreshInFlight) return;
      autoRefreshInFlight = true;
      try {
        const currentJobId = getState().currentJobId;
        if (!currentJobId) {
          syncAutoRefresh(null);
          return;
        }
        const stats = await checkJobStatus(currentJobId);
        if (stats) {
          renderJobDetails(
            null,
            stats,
            qs("#last_jobs_select")?.selectedOptions?.[0]?.dataset?.kind || ""
          );
          syncAutoRefresh(stats);
        } else {
          if (lastJobStatusWasRateLimited || hasFetchApiBackoff()) {
            updateFetchSyncLabel();
            return;
          }
          const prog = document.getElementById("job_progress");
          if (prog) prog.style.display = "none";
          syncAutoRefresh(null);
        }
        updateFetchSyncLabel();
      } finally {
        autoRefreshInFlight = false;
      }
    }, intervalMs);
    setState({ statusCheckInterval: id });
  }

  async function refreshSelectedJobProgress() {
    const jid = getState().currentJobId;
    if (!jid) {
      const prog = document.getElementById("job_progress");
      if (prog) prog.style.display = "none";
      updateFetchSyncLabel();
      return;
    }
    const stats = await checkJobStatus(jid);
    if (stats) {
      const sel = qs("#last_jobs_select");
      const jobKind = sel?.selectedOptions?.[0]?.dataset?.kind || "";
      renderJobDetails(null, stats, jobKind);
      syncAutoRefresh(stats);
    } else {
      if (lastJobStatusWasRateLimited || hasFetchApiBackoff()) {
        updateFetchSyncLabel();
        return;
      }
      const prog = document.getElementById("job_progress");
      if (prog) prog.style.display = "none";
      syncAutoRefresh(null);
    }
    updateFetchSyncLabel();
  }

  function showJobStatusSection(jobId, kind = "") {
    const resultId = toCanonicalResultId(jobId, kind || "job");
    setState({ currentJobId: resultId });
    const sel = qs("#last_jobs_select");
    if (sel && resultId) {
      if (Array.from(sel.options).every((o) => o.value !== resultId)) {
        const opt = document.createElement("option");
        opt.value = resultId;
        opt.textContent = "Recién encolado";
        opt.dataset.kind = String(kind || "")
          .trim()
          .toLowerCase();
        sel.appendChild(opt);
      }
      sel.value = resultId;
    }
    const progress = document.getElementById("job_progress");
    if (progress) progress.style.display = "none";
    chrome.storage.local.set({ last_job_id: resultId });
  }

  function ensureSelectedJobOption(selectEl, jobId, kind = "") {
    if (!selectEl) return false;
    const id = toCanonicalResultId(jobId, kind || "job");
    if (!id) return false;
    if (Array.from(selectEl.options).some((o) => o.value === id)) {
      selectEl.value = id;
      return true;
    }
    const opt = document.createElement("option");
    opt.value = id;
    opt.textContent = "En curso...";
    opt.dataset.kind = String(kind || "")
      .trim()
      .toLowerCase();
    selectEl.appendChild(opt);
    selectEl.value = id;
    return true;
  }

  function pickRunningJobId(jobs) {
    const list = Array.isArray(jobs) ? jobs : [];
    const running = list.find((j) => {
      const st = normalizeJobStatus(j?.status);
      if (!st) return false;
      return !isTerminalJobStatus(st);
    });
    return running?.id ? toCanonicalResultId(running.id, running.kind || "job") : "";
  }

  async function refreshJobsList(limit = 5) {
    if (hasFetchApiBackoff()) {
      updateFetchSyncLabel();
      return null;
    }
    if (refreshJobsListInFlight) return refreshJobsListInFlight;
    refreshJobsListInFlight = (async () => {
      try {
        const cfg = await loadSettings();
        const base = (cfg.api_base || "").trim().replace(/\/+$/, "");
        if (!base) return;
        const result = await loadLastJobsService(base, limit);
        if (!result?.ok) {
          const backoffSec = applyFetchApiBackoff(result);
          const status = Number(result?.status || result?.error?.status || 0) || 0;
          const isRateLimited = status === 429 || status === 503;
          const now = Date.now();
          if (!isRateLimited || now - lastRateLimitJobsLogTs >= 12000) {
            logApiErrorDiagnostic("fetch.refresh_jobs_list.failed", result, { limit, backoffSec });
            if (isRateLimited) lastRateLimitJobsLogTs = now;
          }
          if (isRateLimited) {
            setFetchStatus("Sincronizando resultados...", false);
          } else {
            setFetchStatus(result?.errorMessage || "No se pudieron cargar los resultados", true);
          }
          return;
        }
        const { extractJobs, savedJobId } = result.data;
        const sel = qs("#last_jobs_select");
        if (!sel) return;
        const currentJobId = getState().currentJobId;
        const runningJobId = pickRunningJobId(extractJobs);
        const preferredJobId = toCanonicalResultId(
          runningJobId || savedJobId || currentJobId || "",
          "result"
        );
        renderJobsList(sel, extractJobs, {
          selectedJobId: preferredJobId,
        });
        if (!sel.value && runningJobId) {
          ensureSelectedJobOption(sel, runningJobId, "result");
        }
        if (sel.value) {
          setState({ currentJobId: sel.value });
          const stats = await checkJobStatus(sel.value);
          if (stats) {
            renderJobDetails(null, stats, sel.selectedOptions?.[0]?.dataset?.kind || "");
            syncAutoRefresh(stats);
          } else {
            if (lastJobStatusWasRateLimited || hasFetchApiBackoff()) {
              updateFetchSyncLabel();
              return;
            }
            const prog = document.getElementById("job_progress");
            if (prog) prog.style.display = "none";
            syncAutoRefresh(null);
          }
        } else {
          const prog = document.getElementById("job_progress");
          if (prog) prog.style.display = "none";
          syncAutoRefresh(null);
        }
        updateFetchSyncLabel();
      } finally {
        refreshJobsListInFlight = null;
      }
    })();
    return refreshJobsListInFlight;
  }

  async function enqueue() {
    const cfg = await loadSettings();
    const modeEl = qs("#mode");
    const mode = modeEl ? modeEl.value : "followings";
    if (!cfg.api_base) return setFetchStatus("Configurá la conexión en Opciones.", true);
    const headers = await getAuthHeaders();
    if (!headers.Authorization) {
      return setFetchStatus("No hay sesión activa. Abrí Opciones para reautenticar.", true);
    }
    if (mode === "followings") {
      let fromAccount = "";
      try {
        const r = await chrome.runtime.sendMessage({ action: "get_logged_in_username" });
        fromAccount = ((r?.user_id != null ? String(r.user_id) : "") || r?.username || "").trim();
      } catch {}
      if (!fromAccount) {
        return setFetchStatus(
          "Abrí Instagram en una pestaña e iniciá sesión para detectar la cuenta.",
          true
        );
      }
      const target = (qs("#target") && qs("#target").value) || "";
      let limit = parseInt((qs("#limit") && qs("#limit").value) || "50", 10);
      if (!target.trim()) return setFetchStatus("Ingresá un target.", true);
      if (!Number.isFinite(limit) || limit <= 0) limit = cfg.default_limit || 50;
      const remainingMsgs = getRemainingMessagesForLeads();
      if (Number.isFinite(remainingMsgs)) {
        if (remainingMsgs <= 0) {
          return setFetchStatus(
            "No tenés mensajes disponibles para generar nuevos leads en este momento.",
            true
          );
        }
        if (limit > remainingMsgs) {
          return setFetchStatus(
            `Leads excede mensajes restantes (${remainingMsgs}). Reducí la cantidad.`,
            true
          );
        }
      }
      const depthChecked = document.querySelector('input[name="analysis_depth"]:checked');
      const analysisDepthMode = depthChecked ? depthChecked.value : "all";
      const followingsBody = {
        from_account: fromAccount,
        target_username: target.trim(),
        limit,
        analysis_depth_mode: analysisDepthMode,
      };
      if (analysisDepthMode === "only_rubros") {
        const deepRubros = window.selectedDeepRubros
          ? Array.from(window.selectedDeepRubros)
              .map(toCanonicalDeepRubro)
              .filter((r) => DEEP_RUBROS_OPTIONS.includes(r))
          : [];
        if (deepRubros.length === 0) {
          return setFetchStatus(
            "No se hará análisis profundo a ningún perfil. Elegí al menos una categoría.",
            true
          );
        }
        followingsBody.deep_rubros = deepRubros;
      }
      const base = (cfg.api_base || "").trim().replace(/\/+$/, "");
      const result = await apiFetch(base, API_PATHS.followingsEnqueue, {
        method: "POST",
        body: followingsBody,
      });
      setFetchStatus("Encolando job...", false, { force: true });
      if (!result.ok) {
        logApiErrorDiagnostic("fetch.enqueue_followings.failed", result, {
          target: target.trim().toLowerCase(),
          limit,
        });
        return setFetchStatus(result?.errorMessage || "Error", true);
      }
      const payload =
        result.data?.data && typeof result.data.data === "object" ? result.data.data : result.data;
      const flowId = toCanonicalResultId(payload?.flow_id || "", "flow");
      const jobId = toCanonicalResultId(flowId || payload?.job_id || "", flowId ? "flow" : "job");
      setFetchStatus(flowId ? "Flow encolado" : "Job encolado", false, { force: true });
      await saveSettings({ default_limit: limit });
      if (jobId) {
        showJobStatusSection(jobId, flowId ? "followings_flow" : "fetch_followings");
        scheduleDelayedProgressRefresh(1000);
      }
      return;
    }
    await doEnqueueAnalyze(cfg);
  }

  async function doEnqueueAnalyze(cfg) {
    const raw = (qs("#usernames") && qs("#usernames").value) || "";
    const usernames = raw
      .split(/[\n,]/)
      .map((s) => s.trim().toLowerCase())
      .filter((s) => s.length > 0);
    if (usernames.length === 0) return setFetchStatus("Ingresá al menos un username.", true);
    let batchSize = parseInt((qs("#batch_size") && qs("#batch_size").value) || "25", 10);
    if (!Number.isFinite(batchSize) || batchSize <= 0) batchSize = 25;
    const base = (cfg.api_base || "").trim().replace(/\/+$/, "");
    const result = await apiFetch(base, API_PATHS.analyzeEnqueue, {
      method: "POST",
      body: { usernames, batch_size: batchSize },
    });
    setFetchStatus("Encolando job...", false, { force: true });
    if (!result.ok) {
      logApiErrorDiagnostic("fetch.enqueue_analyze.failed", result, {
        usernamesCount: usernames.length,
        batchSize,
      });
      return setFetchStatus(result?.errorMessage || "Error", true);
    }
    const payload =
      result.data?.data && typeof result.data.data === "object" ? result.data.data : result.data;
    const jobId = toCanonicalResultId(payload?.job_id || "", "job");
    const totalItems = payload?.total_items || usernames.length;
    setFetchStatus(`${totalItems} perfiles encolados`, false, { force: true });
    if (jobId) {
      showJobStatusSection(jobId, "analyze_profile");
      scheduleDelayedProgressRefresh(1000);
    }
  }

  function getAnalysisDepthMode() {
    const checked = document.querySelector('input[name="analysis_depth"]:checked');
    return checked ? checked.value : "all";
  }

  function updateAnalysisDepthUI() {
    const mode = getAnalysisDepthMode();
    const isOnlyRubros = mode === "only_rubros";
    const deepRubrosContainer = qs("#deep_rubros_container");
    if (deepRubrosContainer) deepRubrosContainer.style.display = isOnlyRubros ? "block" : "none";
    updateAnalysisDepthOnlyRubrosWarning();
  }

  function updateAnalysisDepthOnlyRubrosWarning() {
    const mode = getAnalysisDepthMode();
    const warningEl = qs("#analysis_depth_warning");
    if (!warningEl) return;
    if (mode !== "only_rubros") {
      warningEl.style.display = "none";
      return;
    }
    const deepRubros = window.selectedDeepRubros
      ? Array.from(window.selectedDeepRubros)
          .map(toCanonicalDeepRubro)
          .filter((r) => DEEP_RUBROS_OPTIONS.includes(r))
      : [];
    const noDeep = deepRubros.length === 0;
    warningEl.style.display = noDeep ? "block" : "none";
  }

  function initDepthRubrosChips() {
    const wrap = qs("#deep_rubros_chips");
    if (!wrap) return;
    if (window.selectedDeepRubros && window.selectedDeepRubros.size > 0) {
      const normalized = new Set();
      window.selectedDeepRubros.forEach((v) => {
        const canon = toCanonicalDeepRubro(v);
        if (canon && DEEP_RUBROS_OPTIONS.includes(canon)) normalized.add(canon);
      });
      window.selectedDeepRubros = normalized;
    }
    wrap.innerHTML = "";
    DEEP_RUBROS_OPTIONS.forEach((rubro) => {
      const chip = document.createElement("span");
      chip.className = "chip";
      chip.dataset.rubro = rubro;
      chip.textContent = DEEP_RUBROS_LABELS[rubro] || rubro;
      if (window.selectedDeepRubros.has(rubro)) {
        chip.classList.add("selected");
      }
      chip.addEventListener("click", () => {
        if (window.selectedDeepRubros.has(rubro)) {
          window.selectedDeepRubros.delete(rubro);
          chip.classList.remove("selected");
        } else {
          window.selectedDeepRubros.add(rubro);
          chip.classList.add("selected");
        }
        updateAnalysisDepthOnlyRubrosWarning();
      });
      wrap.appendChild(chip);
    });
  }

  function bindFetchEvents() {
    const cleanupFns = [];

    const advancedToggleFetch = document.getElementById("advanced-toggle-fetch");
    const advancedOptionsFetch = document.getElementById("advanced-options-fetch");
    if (advancedToggleFetch && advancedOptionsFetch) {
      const onAdvancedClick = () => {
        const open = advancedOptionsFetch.classList.toggle("open");
        advancedToggleFetch.classList.toggle("open", open);
        advancedToggleFetch.setAttribute("aria-expanded", open ? "true" : "false");
      };
      advancedToggleFetch.addEventListener("click", onAdvancedClick);
      cleanupFns.push(() => advancedToggleFetch.removeEventListener("click", onAdvancedClick));
    }

    initDepthRubrosChips();
    const depthRadios = document.querySelectorAll('input[name="analysis_depth"]');
    const depthChipsWrap = qs("#deep_rubros_chips");
    depthRadios.forEach((r) => {
      r.addEventListener("change", updateAnalysisDepthUI);
      cleanupFns.push(() => r.removeEventListener("change", updateAnalysisDepthUI));
    });
    if (depthChipsWrap) {
      const onChipsClick = () => setTimeout(updateAnalysisDepthOnlyRubrosWarning, 0);
      depthChipsWrap.addEventListener("click", onChipsClick);
      cleanupFns.push(() => depthChipsWrap.removeEventListener("click", onChipsClick));
    }
    updateAnalysisDepthUI();

    const limitInput = qs("#limit");
    if (limitInput) {
      const minusBtn = limitInput.closest(".limit-stepper")?.querySelector(".limit-stepper-minus");
      const plusBtn = limitInput.closest(".limit-stepper")?.querySelector(".limit-stepper-plus");
      const onMinus = () => {
        limitInput.stepDown();
        limitInput.dispatchEvent(new Event("change", { bubbles: true }));
      };
      const onPlus = () => {
        limitInput.stepUp();
        limitInput.dispatchEvent(new Event("change", { bubbles: true }));
      };
      const onLimitChange = () => enforceLimitInputByRemainingMessages(false);
      if (minusBtn) {
        minusBtn.addEventListener("click", onMinus);
        cleanupFns.push(() => minusBtn.removeEventListener("click", onMinus));
      }
      if (plusBtn) {
        plusBtn.addEventListener("click", onPlus);
        cleanupFns.push(() => plusBtn.removeEventListener("click", onPlus));
      }
      limitInput.addEventListener("change", onLimitChange);
      limitInput.addEventListener("blur", onLimitChange);
      cleanupFns.push(() => limitInput.removeEventListener("change", onLimitChange));
      cleanupFns.push(() => limitInput.removeEventListener("blur", onLimitChange));
      enforceLimitInputByRemainingMessages(false);
    }

    const enqueueBtn = qs("#enqueue");
    if (enqueueBtn) {
      enqueueBtn.addEventListener("click", enqueue);
      cleanupFns.push(() => enqueueBtn.removeEventListener("click", enqueue));
    }

    const enqueueAnalyzeBtn = qs("#enqueue_analyze");
    if (enqueueAnalyzeBtn) {
      const onEnqueueAnalyze = async () => {
        const c = await loadSettings();
        if (!c.api_base) return setFetchStatus("Configura la API en Opciones.", true);
        const h = await getAuthHeaders();
        if (!h.Authorization)
          return setFetchStatus("No hay sesión activa. Abrí Opciones para reautenticar.", true);
        await doEnqueueAnalyze(c, h);
      };
      enqueueAnalyzeBtn.addEventListener("click", onEnqueueAnalyze);
      cleanupFns.push(() => enqueueAnalyzeBtn.removeEventListener("click", onEnqueueAnalyze));
    }

    const modeSel = qs("#mode");
    if (modeSel) {
      const onModeChange = () => {
        const m = modeSel.value;
        if (qs("#followings_fields"))
          qs("#followings_fields").style.display = m === "followings" ? "block" : "none";
        if (qs("#analyze_fields"))
          qs("#analyze_fields").style.display = m === "analyze" ? "block" : "none";
      };
      modeSel.addEventListener("change", onModeChange);
      cleanupFns.push(() => modeSel.removeEventListener("change", onModeChange));
    }

    const lastJobsSelect = qs("#last_jobs_select");
    if (lastJobsSelect) {
      const onJobsSelectChange = async () => {
        const jid = toCanonicalResultId(lastJobsSelect.value, "result");
        if (!jid) {
          const prog = document.getElementById("job_progress");
          if (prog) prog.style.display = "none";
          updateFetchSyncLabel();
          return;
        }
        setState({ currentJobId: jid });
        chrome.storage.local.set({ last_job_id: jid });
        setFetchStatus("Cargando estado...", false, { force: true });
        const stats = await checkJobStatus(jid);
        if (stats) {
          const kind = lastJobsSelect.selectedOptions?.[0]?.dataset?.kind || "";
          renderJobDetails(null, stats, kind);
          syncAutoRefresh(stats);
        } else {
          if (lastJobStatusWasRateLimited || hasFetchApiBackoff()) {
            updateFetchSyncLabel();
            return;
          }
          const prog = document.getElementById("job_progress");
          if (prog) prog.style.display = "none";
          syncAutoRefresh(null);
        }
        updateFetchSyncLabel();
      };
      lastJobsSelect.addEventListener("change", onJobsSelectChange);
      cleanupFns.push(() => lastJobsSelect.removeEventListener("change", onJobsSelectChange));
    }

    function cleanup() {
      stopAutoRefresh();
      clearDelayedProgressTimer();
      cleanupFns.forEach((fn) => fn());
    }
    return cleanup;
  }

  return {
    refreshJobsList,
    refreshSelectedJobProgress,
    showJobStatusSection,
    bindFetchEvents,
    checkJobStatus,
    stopAutoRefresh,
  };
}
