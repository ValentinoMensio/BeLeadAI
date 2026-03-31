import {
  describeSenderActivity,
  normalizeJobId,
  waitForSenderAccountReady,
  waitMs,
} from "./send-shared.js";

export function createSendSenderController(deps) {
  const { store, services, ui, dom, config, runtime, state, helpers } = deps;
  const { getState, setState } = store;
  const { loadSettings } = services;
  const { setSendStatus } = ui;
  const { qs } = dom;
  const { getSelectedRecipients, getFromAccountContext, setSendInfoStatus } = helpers;

  async function startSender() {
    const now = Date.now();
    if (now - state.lastStartSenderAttemptTs < config.startSenderClickGuardMs) {
      setSendStatus("Esperá un momento antes de volver a iniciar.", true);
      return;
    }
    state.lastStartSenderAttemptTs = now;

    if (state.startSenderInFlight) {
      setSendStatus("El sender ya se está iniciando. Esperá un momento.", true);
      return;
    }
    state.startSenderInFlight = true;
    let senderStartedByThisCall = false;
    let senderWarmupStarted = false;
    let senderWarmupStartedByThisCall = false;
    try {
      const selectedRecipients = getSelectedRecipients();
      const hasSelectedRecipients = selectedRecipients.length > 0;
      let preferredFromAccount = "";
      const startBtn = qs("#start_sender");
      if (startBtn) startBtn.disabled = true;

      if (hasSelectedRecipients) {
        try {
          const accountCtx = await getFromAccountContext();
          preferredFromAccount = String(accountCtx.sendFromAccount || "")
            .trim()
            .toLowerCase();
        } catch {
          preferredFromAccount = "";
        }

        setSendInfoStatus("Activando sender para esta cuenta...", { force: true });
        let warmup = null;
        try {
          warmup = await chrome.runtime.sendMessage({
            action: "start_sender",
            defer_first_pull: true,
            allow_idle_start: true,
            from_account_hint: preferredFromAccount,
          });
        } catch {
          warmup = null;
        }
        const warmupStatus = String(warmup?.status || "")
          .trim()
          .toLowerCase();
        senderWarmupStarted =
          warmupStatus === "started" ||
          warmupStatus === "already_running" ||
          warmupStatus === "starting";
        senderWarmupStartedByThisCall = warmupStatus === "started";
        const warmupAccepted =
          senderWarmupStarted ||
          warmupStatus === "no_tasks" ||
          warmupStatus === "no_tasks_cooldown";
        if (!warmupAccepted) {
          if (warmup?.reason === "sender_offline") {
            setSendStatus(
              "No hay sender activo para esta cuenta. Abrí Instagram e iniciá sesión.",
              true
            );
          } else {
            setSendStatus("No se pudo iniciar el sender para encolar mensajes.", true);
          }
          runtime.updateSenderStatus();
          return;
        }

        const warmupFromAccount = String(warmup?.from_account || "")
          .trim()
          .toLowerCase();
        preferredFromAccount =
          warmupFromAccount || (await waitForSenderAccountReady(preferredFromAccount, 3200));

        setSendInfoStatus("Encolando mensajes...", { force: true });
        let ok = await runtime.enqueueSendMessages({
          force: true,
          fromAccountOverride: preferredFromAccount,
        });

        if (!ok && runtime.getLastEnqueueBlockingQuota() === "sender_offline") {
          try {
            const hb = await chrome.runtime.sendMessage({
              action: "sender_heartbeat_now",
              from_account: preferredFromAccount,
            });
            const hbAccount = String(hb?.from_account || "")
              .trim()
              .toLowerCase();
            if (hbAccount) {
              preferredFromAccount = hbAccount;
            }
          } catch {
            // best-effort preflight
          }
          await waitMs(350);
          ok = await runtime.enqueueSendMessages({
            force: true,
            fromAccountOverride: preferredFromAccount,
          });
        }

        if (!ok) {
          if (senderWarmupStartedByThisCall) {
            try {
              await chrome.runtime.sendMessage({ action: "stop_sender" });
            } catch {
              // best-effort rollback when warmup was started by this call
            }
          }
          runtime.updateSenderStatus();
          return;
        }

        if (senderWarmupStarted) {
          setSendInfoStatus("Sender activo. Iniciando procesamiento...", { force: true });
          try {
            await chrome.runtime.sendMessage({ action: "process_now" });
          } catch {
            // best-effort trigger
          }
          runtime.updateSenderStatus();
          return;
        }
      }

      setSendInfoStatus("Iniciando sender...", { force: true });
      const result = await chrome.runtime.sendMessage({
        action: "start_sender",
        defer_first_pull: false,
        allow_idle_start: hasSelectedRecipients,
      });
      if (result?.status !== "started") {
        if (result?.status === "already_running" || result?.status === "starting") {
          setSendInfoStatus("El sender ya está en ejecución.", { force: true });
          if (hasSelectedRecipients) {
            try {
              await chrome.runtime.sendMessage({ action: "process_now" });
            } catch {
              // best-effort trigger
            }
          }
          runtime.updateSenderStatus();
          return;
        }
        if (result?.status === "no_tasks" || result?.status === "no_tasks_cooldown") {
          setSendInfoStatus("Sin tareas pendientes", { force: true, source: "activity" });
          runtime.updateSenderStatus();
          return;
        }
        if (result?.reason === "sender_offline") {
          setSendStatus(
            "No hay sender activo para esta cuenta. Abrí Instagram e iniciá sesión.",
            true
          );
        } else {
          setSendStatus("No se pudo iniciar el envío.", true);
        }
        return;
      }
      senderStartedByThisCall = true;

      if (!result?.prefetched_task) {
        try {
          await chrome.runtime.sendMessage({ action: "process_now" });
        } catch {
          // best-effort trigger
        }
      }

      setSendInfoStatus("Envío iniciado", { force: true });
      runtime.updateSenderStatus();
    } catch {
      setSendStatus("Error al iniciar el envío.", true);
      if (senderStartedByThisCall) {
        try {
          await chrome.runtime.sendMessage({ action: "stop_sender" });
        } catch {}
      }
      runtime.updateSenderStatus();
    } finally {
      state.startSenderInFlight = false;
      runtime.updateSenderStatus();
    }
  }

  async function stopSender() {
    try {
      setSendInfoStatus("Deteniendo envío...", { force: true });
      let result = null;
      try {
        result = await chrome.runtime.sendMessage({ action: "stop_sender" });
      } catch {
        result = null;
      }
      let canceledInfo = null;
      let canceledJobId = "";
      try {
        const stateJobId = String(getState().pendingCancelableSendJobId || "").trim();
        const cachedJobId = await runtime.getLastSendJobId();
        const jobId = stateJobId || cachedJobId;
        canceledJobId = jobId;
        if (jobId) {
          const cfg = await loadSettings();
          const base = (cfg.api_base || "").trim().replace(/\/+$/, "");
          if (base) {
            canceledInfo = await runtime.cancelJobWithRetry(base, jobId);
          }
        }
      } catch (e) {
        canceledInfo = {
          ok: false,
          status: 0,
          errorMessage: String(e?.message || "Error de red al cancelar"),
          error: String(e?.message || "Error de red al cancelar"),
          attempts: 0,
        };
      }

      if (canceledInfo?.ok && canceledInfo?.data?.cancel) {
        const sentConfirmed = Number(canceledInfo.data.cancel.sent_confirmed || 0);
        setSendInfoStatus(`Envío detenido. Job cancelado (ya enviados: ${sentConfirmed}).`, {
          force: true,
        });
        setState({ pendingCancelableSendJobId: null });
      } else if (canceledJobId) {
        const attempts = Number(canceledInfo?.attempts || config.cancelJobRetryDelaysMs.length);
        const reason = String(
          canceledInfo?.error || "No se pudo cancelar el job en el servidor."
        ).trim();
        setState({ pendingCancelableSendJobId: canceledJobId });
        setSendStatus(
          `Envío detenido en la extensión, pero falló la cancelación remota tras ${attempts} intento(s): ${reason}. Reintentá "Detener envío".`,
          true
        );
      } else if (result?.status === "stopped") {
        setSendInfoStatus("Listo", { force: true });
      } else {
        setSendInfoStatus("Envío detenido en la extensión.", { force: true });
      }

      runtime.updateSenderStatus();
      const st = getState();
      await runtime.refreshSendProgress(true);
      await runtime.refreshRecipients();
      const sel = qs("#send_recipients_job_select");
      if (st.selectedSendJobId && sel) {
        sel.value = st.selectedSendJobId;
        await runtime.onSendRecipientsJobChange(st.selectedSendJobId, st.selectedSendKind);
      }
    } catch {
      setSendStatus("Error al detener el envío.", true);
    }
  }

  function stopSenderStatusPolling() {
    if (state.senderStatusIntervalId) {
      clearInterval(state.senderStatusIntervalId);
      state.senderStatusIntervalId = null;
    }
  }

  function startSenderStatusPolling(updateSenderStatus) {
    if (state.senderStatusIntervalId) return;
    const intervalId = setInterval(() => {
      updateSenderStatus();
    }, config.senderStatusPollMs);
    state.senderStatusIntervalId = intervalId;
  }

  async function updateSenderStatus() {
    try {
      const status = await chrome.runtime.sendMessage({ action: "get_sender_status" });
      await runtime.reconcilePendingCancelableJobId(status);
      const startBtn = qs("#start_sender");
      const stopBtn = qs("#stop_sender");

      const st = getState();
      const stateCancelableId = normalizeJobId(st.pendingCancelableSendJobId);
      const taskCancelableId = normalizeJobId(status?.currentTask?.job_id);
      const resolvedCancelableId = stateCancelableId || taskCancelableId;
      const hasCancelablePending = !!resolvedCancelableId;

      if (resolvedCancelableId && resolvedCancelableId !== stateCancelableId) {
        setState({ pendingCancelableSendJobId: resolvedCancelableId });
      }

      if (!status) {
        if (startBtn) startBtn.disabled = false;
        if (stopBtn) stopBtn.disabled = !hasCancelablePending;
        return;
      }
      runtime.updateSendSyncLabel();
      if (status.isRunning) {
        if (startBtn) startBtn.disabled = true;
        if (stopBtn) stopBtn.disabled = false;
        startSenderStatusPolling(updateSenderStatus);
        const activity = describeSenderActivity(status);
        if (activity) {
          setSendInfoStatus(activity, { source: "activity" });
        }
      } else {
        const cooldownMs = Math.max(0, Number(status?.noTasksRestartCooldownMs || 0));
        if (startBtn) startBtn.disabled = cooldownMs > 0;
        if (stopBtn) stopBtn.disabled = !hasCancelablePending;
        if (cooldownMs > 0) {
          startSenderStatusPolling(updateSenderStatus);
        } else {
          stopSenderStatusPolling();
        }
        setSendInfoStatus("Sin tareas pendientes", { source: "activity" });
      }
    } catch {
      stopSenderStatusPolling();
      const st = getState();
      const hasCancelablePending = !!String(st.pendingCancelableSendJobId || "").trim();
      const startBtn = qs("#start_sender");
      const stopBtn = qs("#stop_sender");
      if (startBtn) startBtn.disabled = false;
      if (stopBtn) stopBtn.disabled = !hasCancelablePending;
    }
  }

  return {
    startSender,
    stopSender,
    stopSenderStatusPolling,
    startSenderStatusPolling,
    updateSenderStatus,
  };
}
