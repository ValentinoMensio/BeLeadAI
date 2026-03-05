/**
 * Orquestador del popup: init idempotente, dependencias, setup/limits/fetch/send controllers, WS y visibilidad.
 */

import { loadSettings, saveSettings } from "../../services/settings-service.js";
import {
  getAuthHeaders,
  apiFetch,
  fetchPing,
  fetchApiConfig,
  fetchVersionMeta,
} from "../../services/api-client.js";
import {
  loadLastJobs as loadLastJobsService,
  loadJobSummary,
  cancelJob as cancelJobService,
  loadRecipientsJobsForSend as loadRecipientsJobsService,
} from "../../services/jobs-service.js";
import { ensureJobsWsConnected, subscribeJobsUpdated } from "../../services/ws-jobs-service.js";
import { getState, setState } from "./state/popup-store.js";
import { qs, qsa } from "../../shared/utils/dom.js";
import {
  formatJobDate,
  formatJobStatusLabel,
  formatJobOptionLabel,
  isUnlimited,
} from "../../shared/utils/format.js";
import { renderJobsList } from "./ui/components/jobs-list.js";
import { renderJobDetails } from "./ui/components/job-details.js";
import {
  renderRecipients,
  updateRecipientsSummaryLabel,
} from "./ui/components/recipients-panel.js";
import { refreshLimitsWithCache, showLimitDetail, getLimitsData } from "./ui/limits-view.js";
import { setSendStatus, setEnqueueSendEnabled, updateSendJobProgress } from "./ui/send-view.js";
import { initSetup } from "./controllers/setup-controller.js";
import { initLimits } from "./controllers/limits-controller.js";
import { initFetchTab } from "./controllers/fetch-controller.js";
import { initSendTab } from "./controllers/send-controller.js";

let cleanupAll = null;
let wsUnsubscribe = null;

const DM_STATUS_UI_REFRESH_MIN_MS = 2500;
const WS_SYNC_DEBOUNCE_MS = 1200;
const WS_SYNC_FETCH_MIN_MS = 6000;
const WS_SYNC_SEND_MIN_MS = 6000;

function setStatus(msg, isErr = false) {
  const el = qs("#status");
  if (el) {
    const nextText = String(msg || "");
    const nextClass = isErr ? "status-line err" : "status-line ok";
    if (el.textContent === nextText && el.className === nextClass) {
      return;
    }
    el.textContent = nextText;
    el.className = nextClass;
  }
}

function normalizePlanName(rawPlan) {
  const source = String(rawPlan || "").trim();
  if (!source) return "Free";
  return source.charAt(0).toUpperCase() + source.slice(1).toLowerCase();
}

function isExpiredPlanPingResult(pingResult) {
  const code = String(pingResult?.errorCode || "")
    .trim()
    .toUpperCase();
  if (code === "FREE_PLAN_EXPIRED" || code === "PLAN_EXPIRED") return true;
  const quota = String(pingResult?.errorDetails?.blocking_quota || "")
    .trim()
    .toLowerCase();
  if (quota === "free_plan_duration" || quota === "plan_duration") return true;
  return false;
}

function isUpdateRequiredPingResult(pingResult) {
  const code = String(pingResult?.errorCode || "")
    .trim()
    .toUpperCase();
  if (code === "CLIENT_UPDATE_REQUIRED") return true;
  const status = Number(pingResult?.status || 0) || 0;
  return status === 426;
}

function getUpdateInfo(pingResult, storedState = null) {
  const details =
    pingResult?.errorDetails && typeof pingResult.errorDetails === "object"
      ? pingResult.errorDetails
      : storedState?.details && typeof storedState.details === "object"
        ? storedState.details
        : {};
  const minRequired = String(
    details?.minRequiredVersion || details?.min_required_version || ""
  ).trim();
  const latest = String(details?.latestVersion || details?.latest_version || "").trim();
  const updateUrl =
    String(details?.updateUrl || details?.update_url || storedState?.update_url || "").trim() ||
    "https://github.com";
  const message =
    String(pingResult?.apiErrorMessage || storedState?.message || "").trim() ||
    "Necesitas instalar la version mas reciente para continuar.";
  return { minRequired, latest, updateUrl, message };
}

function loadPlanBlockState() {
  return new Promise((resolve) => {
    chrome.storage.local.get({ plan_block_state: null }, (data) => {
      const raw = data?.plan_block_state;
      if (!raw || typeof raw !== "object") return resolve(null);
      const ts = Number(raw.ts || 0) || 0;
      if (!ts) return resolve(null);
      resolve(raw);
    });
  });
}

function loadVersionBlockState() {
  return new Promise((resolve) => {
    chrome.storage.local.get({ version_block_state: null }, (data) => {
      const raw = data?.version_block_state;
      if (!raw || typeof raw !== "object") return resolve(null);
      resolve(raw);
    });
  });
}

function showExpiredPlanScreen(planName) {
  const setupScreen = qs("#setup-screen");
  const mainUi = qs("#main-ui");
  const expiredScreen = qs("#expired-screen");
  const planNameEl = qs("#expired-plan-name");
  if (setupScreen) setupScreen.style.display = "none";
  if (mainUi) mainUi.style.display = "none";
  if (expiredScreen) expiredScreen.style.display = "flex";
  if (planNameEl) planNameEl.textContent = normalizePlanName(planName);
}

function hideExpiredPlanScreen() {
  const expiredScreen = qs("#expired-screen");
  if (expiredScreen) expiredScreen.style.display = "none";
}

function showUpdateRequiredScreen(updateInfo) {
  const setupScreen = qs("#setup-screen");
  const mainUi = qs("#main-ui");
  const expiredScreen = qs("#expired-screen");
  const updateScreen = qs("#update-required-screen");
  const messageEl = qs("#update-required-message");
  const versionsEl = qs("#update-required-versions");
  const actionEl = qs("#update-required-action");
  if (setupScreen) setupScreen.style.display = "none";
  if (mainUi) mainUi.style.display = "none";
  if (expiredScreen) expiredScreen.style.display = "none";
  if (updateScreen) updateScreen.style.display = "flex";
  if (messageEl)
    messageEl.textContent =
      String(updateInfo?.message || "").trim() ||
      "Necesitas instalar la version mas reciente para continuar.";
  if (versionsEl) {
    const minV = String(updateInfo?.minRequired || "").trim();
    const latestV = String(updateInfo?.latest || "").trim();
    const parts = [];
    if (minV) parts.push(`Minima requerida: ${minV}`);
    if (latestV) parts.push(`Ultima disponible: ${latestV}`);
    versionsEl.textContent = parts.join(" | ");
  }
  if (actionEl) {
    actionEl.href = String(updateInfo?.updateUrl || "").trim() || "https://github.com";
  }
}

function hideUpdateRequiredScreen() {
  const updateScreen = qs("#update-required-screen");
  if (updateScreen) updateScreen.style.display = "none";
}

function buildDeps() {
  const store = { getState, setState };
  const services = {
    loadSettings,
    saveSettings,
    getAuthHeaders,
    apiFetch,
    fetchPing,
    fetchApiConfig,
    fetchVersionMeta,
    loadLastJobsService,
    loadJobSummary,
    cancelJobService,
    loadRecipientsJobsService,
    ensureJobsWsConnected,
    subscribeJobsUpdated,
  };
  const ui = {
    setStatus,
    refreshLimitsWithCache,
    showLimitDetail,
    getLimitsData,
    setSendStatus,
    setEnqueueSendEnabled,
    updateSendJobProgress,
    renderJobsList,
    renderJobDetails,
    renderRecipients,
    updateRecipientsSummaryLabel,
    formatJobDate,
    formatJobStatusLabel,
    formatJobOptionLabel,
    isUnlimited,
  };
  const dom = { qs, qsa };
  return { store, services, ui, dom };
}

export async function init() {
  if (cleanupAll) {
    cleanupAll();
    cleanupAll = null;
  }
  if (wsUnsubscribe) {
    wsUnsubscribe();
    wsUnsubscribe = null;
  }

  const deps = buildDeps();
  const { store, services } = deps;
  const { getState, setState } = store;

  const setupApi = initSetup(deps);
  const limitsApi = initLimits(deps);
  const fetchApi = initFetchTab(deps);
  const sendApi = initSendTab(deps);

  const cfg = await loadSettings();
  setState({ config: cfg });

  const versionMeta = cfg?.api_base ? await services.fetchVersionMeta(cfg.api_base) : null;
  if (versionMeta?.blocked) {
    showUpdateRequiredScreen({
      message: versionMeta.message,
      minRequired: versionMeta.minRequiredVersion,
      latest: versionMeta.latestVersion,
      updateUrl: versionMeta.updateUrl,
    });
    const cfgDot = qs("#cfgDot");
    const cfgText = qs("#cfgText");
    if (cfgDot && cfgText) {
      cfgDot.classList.remove("ok", "err", "warn");
      cfgDot.classList.add("err");
      cfgText.textContent = "Update";
    }
    cleanupAll = () => {
      cleanupAll = null;
    };
    return;
  }

  const setupScreen = qs("#setup-screen");
  const mainUi = qs("#main-ui");
  hideExpiredPlanScreen();
  hideUpdateRequiredScreen();

  let pingResult = await fetchPing(cfg);
  if (!pingResult.tokenOk && setupApi.hasAuth(cfg)) {
    try {
      await services.getAuthHeaders();
      pingResult = await fetchPing(cfg);
    } catch {}
  }
  if (pingResult.tokenOk) {
    chrome.storage.local.remove(["plan_block_state", "version_block_state"]);
  }
  const apiReachable = !!pingResult.urlOk;
  const tokenOkFromPing = pingResult.tokenOk;
  const hasAuthState = setupApi.hasAuth(cfg) || tokenOkFromPing;
  const hasAllFields = setupApi.isValidApiBase(cfg.api_base) && hasAuthState;
  const configOk = hasAllFields && apiReachable && tokenOkFromPing;

  if (!configOk && setupScreen) {
    setupApi.updateSetupChecklist(cfg, { apiReachable, tokenOk: tokenOkFromPing });
    const hint = document.getElementById("setup-network-error");
    if (hint) {
      if (!apiReachable && pingResult.errorMessage) {
        hint.textContent = pingResult.errorMessage;
        hint.style.display = "block";
      } else {
        hint.textContent = "";
        hint.style.display = "none";
      }
    }
  }

  const storedPlanBlock = await loadPlanBlockState();
  const storedVersionBlock = await loadVersionBlockState();
  const storedPlanCode = String(storedPlanBlock?.code || "")
    .trim()
    .toUpperCase();
  const storedPlanQuota = String(storedPlanBlock?.details?.blocking_quota || "")
    .trim()
    .toLowerCase();
  const isStoredPlanExpired =
    storedPlanCode === "PLAN_EXPIRED" ||
    storedPlanCode === "FREE_PLAN_EXPIRED" ||
    storedPlanQuota === "plan_duration" ||
    storedPlanQuota === "free_plan_duration";
  const isPlanExpired =
    isExpiredPlanPingResult(pingResult) || (!pingResult.tokenOk && isStoredPlanExpired);
  const isUpdateRequired =
    isUpdateRequiredPingResult(pingResult) ||
    (!pingResult.tokenOk &&
      String(storedVersionBlock?.code || "")
        .trim()
        .toUpperCase() === "CLIENT_UPDATE_REQUIRED");
  if (isUpdateRequired) {
    showUpdateRequiredScreen(getUpdateInfo(pingResult, storedVersionBlock));
    const cfgDot = qs("#cfgDot");
    const cfgText = qs("#cfgText");
    if (cfgDot && cfgText) {
      cfgDot.classList.remove("ok", "err", "warn");
      cfgDot.classList.add("err");
      cfgText.textContent = "Update";
    }
    cleanupAll = () => {
      cleanupAll = null;
    };
    return;
  }

  if (isPlanExpired) {
    const planName =
      pingResult?.planName ||
      pingResult?.errorDetails?.plan_id ||
      storedPlanBlock?.plan_name ||
      storedPlanBlock?.details?.plan_id ||
      "Free";
    showExpiredPlanScreen(planName);
    const cfgDot = qs("#cfgDot");
    const cfgText = qs("#cfgText");
    if (cfgDot && cfgText) {
      cfgDot.classList.remove("ok", "err", "warn");
      cfgDot.classList.add("err");
      cfgText.textContent = "Plan";
    }
    const cleanupSetup = setupApi.bindSetupEvents();
    cleanupAll = () => {
      cleanupSetup();
      cleanupAll = null;
    };
    return;
  }

  if (configOk && cfg.api_base) {
    try {
      const limits = await fetchApiConfig(cfg.api_base);
      if (limits) setState({ apiLimits: limits });
    } catch {}
  }

  if (setupScreen && mainUi) {
    if (configOk) {
      setupApi.hideSetup();
    } else {
      setupApi.showSetup();
      setupApi.updateSetupChecklist(cfg, { apiReachable, tokenOk: tokenOkFromPing });
    }
  }

  const cleanupSetup = setupApi.bindSetupEvents();

  if (configOk) {
    setupApi.refreshTabAccountDisplay();
    limitsApi.refreshLimitsWithCache(true);
    services.ensureJobsWsConnected();
    limitsApi.updateSandboxBadge();
  }

  const cleanupLimits = limitsApi.bindLimitsEvents();
  const cleanupFetch = fetchApi.bindFetchEvents();
  const cleanupSend = sendApi.bindSendEvents();

  const limitInput = qs("#limit");
  if (limitInput) limitInput.value = cfg.default_limit || 50;

  function initTabs() {
    const tabs = qsa(".tab");
    const contents = qsa(".tab-content");
    if (!tabs.length) return () => {};
    const handlers = [];
    tabs.forEach((tab) => {
      const onTabClick = async () => {
        const targetId = `tab-${tab.dataset.tab}`;
        tabs.forEach((t) => t.classList.remove("active"));
        contents.forEach((c) => c.classList.remove("active"));
        tab.classList.add("active");
        const targetContent = qs(`#${targetId}`);
        if (targetContent) {
          targetContent.classList.add("active");
          targetContent.scrollIntoView({ block: "nearest", behavior: "instant" });
        }
        if (tab.dataset.tab !== "send") {
          sendApi.stopSendProgressPolling();
          sendApi.stopSenderStatusPolling();
        }
        if (tab.dataset.tab !== "fetch") {
          fetchApi.stopAutoRefresh();
        }
        if (tab.dataset.tab === "send") {
          limitsApi.updateSandboxBadge();
          sendApi.updateSenderStatus();
          sendApi.refreshRecipients(true);
          const stats = await sendApi.refreshSendProgress();
          if (stats && (stats.queued || 0) + (stats.sent || 0) > 0)
            sendApi.startSendProgressPolling();
        }
        if (tab.dataset.tab === "fetch") {
          fetchApi.refreshJobsList(5);
        }
      };
      tab.addEventListener("click", onTabClick);
      handlers.push(() => tab.removeEventListener("click", onTabClick));
    });
    return () => handlers.forEach((h) => h());
  }

  const cleanupTabs = initTabs();

  if (configOk) {
    fetchApi.refreshJobsList(5);
    sendApi.updateSenderStatus();
    await sendApi.restoreSendProgressFromCache();
    const sendStats = await sendApi.refreshSendProgress();
    if (sendStats && (sendStats.queued || 0) + (sendStats.sent || 0) > 0) {
      sendApi.startSendProgressPolling();
    }
  }

  const cfgDot = qs("#cfgDot");
  const cfgText = qs("#cfgText");
  if (cfgDot && cfgText) {
    cfgDot.classList.remove("ok", "err", "warn");
    if (configOk) {
      cfgDot.classList.add("ok");
      cfgText.textContent = "OK";
    } else {
      cfgDot.classList.add("err");
      cfgText.textContent = "Config";
    }
  }

  let dmUiRefreshTimer = null;
  let dmUiRefreshInFlight = false;
  let dmUiNeedsRecipientsRefresh = false;
  let dmUiNeedsForceRefresh = false;
  let lastDmUiRefreshTs = 0;
  let wsSyncTimer = null;
  let wsSyncInFlight = false;
  let lastWsFetchSyncTs = 0;
  let lastWsSendSyncTs = 0;

  function activeTabName() {
    return String(document.querySelector(".tab.active")?.dataset?.tab || "")
      .trim()
      .toLowerCase();
  }

  async function refreshRecipientsPreservingSelection(force = false) {
    await sendApi.refreshRecipients(force);
    const sel = qs("#send_recipients_job_select");
    const st = getState();
    const selectedId = String(st.selectedSendJobId || "").trim();
    if (!selectedId || !sel || sel.disabled) return;
    const hasOption = [...(sel.options || [])].some((opt) => opt.value === selectedId);
    if (!hasOption) return;
    sel.value = selectedId;
    await sendApi.onSendRecipientsJobChange(selectedId, st.selectedSendKind);
  }

  function scheduleDmUiRefresh({ force = false, refreshRecipients = false } = {}) {
    if (refreshRecipients) dmUiNeedsRecipientsRefresh = true;
    if (force) dmUiNeedsForceRefresh = true;
    if (dmUiRefreshTimer) {
      if (!force) return;
      clearTimeout(dmUiRefreshTimer);
      dmUiRefreshTimer = null;
    }
    const elapsed = Date.now() - lastDmUiRefreshTs;
    const waitMs = force ? 0 : Math.max(0, DM_STATUS_UI_REFRESH_MIN_MS - elapsed);
    dmUiRefreshTimer = setTimeout(async () => {
      dmUiRefreshTimer = null;
      if (dmUiRefreshInFlight) {
        scheduleDmUiRefresh();
        return;
      }
      dmUiRefreshInFlight = true;
      try {
        lastDmUiRefreshTs = Date.now();
        const runForce = dmUiNeedsForceRefresh;
        dmUiNeedsForceRefresh = false;
        sendApi.updateSenderStatus();
        await sendApi.refreshSendProgress(runForce);
        if (dmUiNeedsRecipientsRefresh) {
          dmUiNeedsRecipientsRefresh = false;
          await refreshRecipientsPreservingSelection(true);
        }
      } finally {
        dmUiRefreshInFlight = false;
      }
    }, waitMs);
  }

  async function runWsSync() {
    if (wsSyncInFlight) return;
    wsSyncInFlight = true;
    try {
      const now = Date.now();
      const tab = activeTabName();
      if (tab === "fetch" && now - lastWsFetchSyncTs >= WS_SYNC_FETCH_MIN_MS) {
        lastWsFetchSyncTs = now;
        await fetchApi.refreshJobsList(5);
        const jid = getState().currentJobId;
        if (jid) {
          const stats = await fetchApi.checkJobStatus(jid);
          if (stats) {
            const sel = qs("#last_jobs_select");
            renderJobDetails(null, stats, sel?.selectedOptions?.[0]?.dataset?.kind || "");
          }
        }
      }
      if (tab === "send" && now - lastWsSendSyncTs >= WS_SYNC_SEND_MIN_MS) {
        lastWsSendSyncTs = now;
        await sendApi.refreshSendProgress();
      }
    } finally {
      wsSyncInFlight = false;
    }
  }

  function scheduleWsSync() {
    if (wsSyncTimer) return;
    wsSyncTimer = setTimeout(() => {
      wsSyncTimer = null;
      runWsSync();
    }, WS_SYNC_DEBOUNCE_MS);
  }

  const onDmStatusUpdate = async (message) => {
    if (message.type !== "dm_status_update") return;
    if (message.data?.error === "thread_identity_not_verified") {
      if (message.data?.isRunning === false) {
        setSendStatus(
          "No se pudo verificar el chat del destinatario. Revisá Instagram Direct y volvé a iniciar.",
          true
        );
      } else {
        setSendStatus(
          message.data?.message ||
            "No se pudo verificar un chat. Se omite ese contacto y el envío continúa.",
          false
        );
      }
    }
    if (message.data?.error === "watchdog_stuck") {
      setSendStatus(
        message.data?.message ||
          "El envío se detuvo por falta de progreso. Revisá Instagram y reiniciá.",
        true
      );
    }
    const senderStopped = message.data?.isRunning === false;
    scheduleDmUiRefresh({ force: senderStopped, refreshRecipients: senderStopped });
  };
  chrome.runtime.onMessage.addListener(onDmStatusUpdate);

  const onPageHide = () => {
    sendApi.stopSenderStatusPolling();
    sendApi.stopSendProgressPolling();
    if (dmUiRefreshTimer) {
      clearTimeout(dmUiRefreshTimer);
      dmUiRefreshTimer = null;
    }
    if (wsSyncTimer) {
      clearTimeout(wsSyncTimer);
      wsSyncTimer = null;
    }
  };
  window.addEventListener("pagehide", onPageHide);

  const onVisibilityChange = () => {
    if (document.visibilityState === "hidden") {
      sendApi.stopSenderStatusPolling();
      sendApi.stopSendProgressPolling();
      fetchApi.stopAutoRefresh();
    } else {
      if (configOk) {
        services.ensureJobsWsConnected();
        const tab = activeTabName();
        if (tab === "send") {
          sendApi.updateSenderStatus();
          sendApi.refreshSendProgress();
        }
        if (tab === "fetch") {
          fetchApi.refreshJobsList(5);
        }
        limitsApi.refreshLimitsWithCache(false);
      }
    }
  };
  window.addEventListener("visibilitychange", onVisibilityChange);

  wsUnsubscribe = subscribeJobsUpdated(() => {
    scheduleWsSync();
  });

  if (configOk) sendApi.updateSenderStatus();

  cleanupAll = () => {
    cleanupSetup();
    cleanupLimits();
    cleanupFetch();
    cleanupSend();
    cleanupTabs();
    chrome.runtime.onMessage.removeListener(onDmStatusUpdate);
    window.removeEventListener("pagehide", onPageHide);
    window.removeEventListener("visibilitychange", onVisibilityChange);
    if (wsUnsubscribe) {
      wsUnsubscribe();
      wsUnsubscribe = null;
    }
    if (dmUiRefreshTimer) {
      clearTimeout(dmUiRefreshTimer);
      dmUiRefreshTimer = null;
    }
    if (wsSyncTimer) {
      clearTimeout(wsSyncTimer);
      wsSyncTimer = null;
    }
    fetchApi.stopAutoRefresh();
    cleanupAll = null;
  };

  if (qs("#target")) qs("#target").focus();
}
