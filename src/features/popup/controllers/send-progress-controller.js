import { logApiErrorDiagnostic } from "../../../shared/errors/error-diagnostics.js";
import { isTerminalSendJobStatus, normalizeSendSummary } from "./send-shared.js";

export function createSendProgressController(deps) {
  const {
    store,
    services,
    ui,
    helpers,
    config,
    state,
  } = deps;
  const { setState, getSelectedRecipientCount } = store;
  const { loadSettings, loadJobSummary } = services;
  const { setEnqueueSendEnabled, updateSendJobProgress } = ui;
  const {
    hasSendApiBackoff,
    restoreSendProgressFromCache,
    getLastSendJobId,
    markSendProgressStatusSticky,
    updateSendSyncLabel,
    applySendApiBackoff,
    clearSendProgressCache,
    setSendInfoStatus,
  } = helpers;

  function stopSendProgressPolling() {
    if (state.sendProgressIntervalId) {
      clearInterval(state.sendProgressIntervalId);
      state.sendProgressIntervalId = null;
    }
    state.sendProgressNullTicks = 0;
  }

  function startSendProgressPolling(refreshSendProgress) {
    stopSendProgressPolling();
    const id = setInterval(async () => {
      const stats = await refreshSendProgress();
      if (!stats) {
        state.sendProgressNullTicks += 1;
        if (state.sendProgressNullTicks >= 2) {
          stopSendProgressPolling();
        }
        return;
      }
      state.sendProgressNullTicks = 0;
      if ((stats.queued || 0) + (stats.sent || 0) === 0) stopSendProgressPolling();
    }, config.sendProgressPollMs);
    state.sendProgressIntervalId = id;
  }

  async function refreshSendProgress(force = false) {
    if (state.refreshSendProgressInFlight) return state.refreshSendProgressInFlight;
    state.refreshSendProgressInFlight = (async () => {
      try {
        if (hasSendApiBackoff(force)) {
          const restored = await restoreSendProgressFromCache();
          updateSendSyncLabel();
          return restored || null;
        }
        const jobId = await getLastSendJobId();
        if (!jobId) {
          setState({ pendingCancelableSendJobId: null });
          return null;
        }
        const cfg = await loadSettings();
        const base = (cfg.api_base || "").trim().replace(/\/+$/, "");
        if (!base) return null;
        const summary = await loadJobSummary(base, jobId);
        if (summary?.ok && summary?.data) {
          const stats = normalizeSendSummary(summary.data);
          updateSendJobProgress(stats);
          markSendProgressStatusSticky(stats);
          chrome.storage.local.set({ last_send_job_id: jobId, last_send_job_stats: stats });
          const queued = Number(stats.queued || 0) || 0;
          const sent = Number(stats.sent || 0) || 0;
          const inFlight = queued + sent > 0;
          const isTerminal = isTerminalSendJobStatus(stats.status);
          if (!inFlight && isTerminal) {
            setState({ pendingCancelableSendJobId: null });
          }
          let senderRunning = false;
          if (inFlight) {
            try {
              const senderStatus = await chrome.runtime.sendMessage({ action: "get_sender_status" });
              senderRunning = !!senderStatus?.isRunning;
            } catch {
              senderRunning = false;
            }
          }

          if (inFlight && senderRunning) {
            setEnqueueSendEnabled(false, "Esperá a que termine el envío.");
          } else if (inFlight && !senderRunning) {
            setEnqueueSendEnabled(true);
            if (sent > 0 && queued === 0) {
              setSendInfoStatus("Hay envios pendientes de confirmacion.");
            }
          } else if (getSelectedRecipientCount() > 0) {
            setEnqueueSendEnabled(true);
          } else {
            setEnqueueSendEnabled(false, "Sin destinatarios seleccionados.");
          }
          updateSendSyncLabel();
          return stats;
        }
        const summaryStatus = Number(summary?.error?.status || 0) || 0;
        const summaryCode = String(summary?.error?.code || "UNKNOWN")
          .trim()
          .toUpperCase();
        const backoffSec = applySendApiBackoff(summary);
        try {
          const restored = await restoreSendProgressFromCache();
          if (
            summaryStatus === 404 ||
            summaryStatus === 422 ||
            summaryCode === "RESULT_ID_REQUIRED"
          ) {
            await clearSendProgressCache();
            setState({ pendingCancelableSendJobId: null });
            updateSendSyncLabel();
            return restored || null;
          }
          if (!restored) {
            const now = Date.now();
            const isRateLimited = summaryStatus === 429 || summaryStatus === 503;
            if (!isRateLimited || now - state.lastRateLimitProgressLogTs >= 12000) {
              logApiErrorDiagnostic("send.refresh_progress.summary_unavailable", summary, {
                jobId,
                summaryCode: summaryCode || "UNKNOWN",
                summaryStatus,
                backoffSec,
              });
              if (isRateLimited) state.lastRateLimitProgressLogTs = now;
            }
          }
          updateSendSyncLabel();
          return restored;
        } catch (e) {
          logApiErrorDiagnostic("send.refresh_progress.restore_cache_failed", e, { jobId });
          updateSendSyncLabel();
          return null;
        }
      } finally {
        state.refreshSendProgressInFlight = null;
      }
    })();
    return state.refreshSendProgressInFlight;
  }

  return {
    stopSendProgressPolling,
    startSendProgressPolling,
    refreshSendProgress,
  };
}
