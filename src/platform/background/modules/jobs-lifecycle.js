(function initBackgroundJobsLifecycleModule(globalScope) {
  function createBackgroundJobsLifecycleModule({
    state,
    config,
    storageModule,
    authModule,
    wsModule,
    reportingModule,
    watchdogModule,
    normalizeAccount,
    getPinnedSenderAccount,
    pinSenderAccountForRun,
    clearPendingProcessNextTimer,
    clearPendingProcessTriggerTimer,
    notifyPopupStatusUpdate,
    getActiveProcessToken,
    getStartSenderInFlight,
    setStartSenderInFlight,
    getSenderRunVersion,
    setSenderRunVersion,
    getNoTasksRestartCooldownUntil,
    setNoTasksRestartCooldownUntil,
    resetRuntimeCounters,
    getCurrentKnownAccount,
    processNextTask,
  }) {
    const NO_TASKS_RESTART_COOLDOWN_MS = 8000;

    async function startSender(options = {}) {
      if (state.isRunning) {
        return {
          status: "already_running",
          from_account: getPinnedSenderAccount() || "",
        };
      }
      const now = Date.now();
      const cooldownUntil = getNoTasksRestartCooldownUntil();
      if (cooldownUntil > now) {
        return {
          status: "no_tasks_cooldown",
          retryAfterMs: Math.max(1000, cooldownUntil - now),
          from_account: normalizeAccount(getCurrentKnownAccount()),
        };
      }
      if (getStartSenderInFlight() || getActiveProcessToken()) {
        return {
          status: "starting",
          from_account: getPinnedSenderAccount() || normalizeAccount(getCurrentKnownAccount()),
        };
      }

      console.log("[BG] Iniciando sender...");

      setStartSenderInFlight(true);
      const deferFirstPull = !!options?.deferFirstPull;
      const allowIdleStart = !!options?.allowIdleStart;
      const fromAccountHint = normalizeAccount(options?.fromAccountHint);

      try {
        let prefetchedTask = null;
        if (!allowIdleStart) {
          const preflight = await reportingModule.pullTask();
          if (preflight?.status === "task") {
            prefetchedTask = preflight.task;
          } else if (preflight?.status === "empty") {
            return { status: "no_tasks" };
          } else {
            return {
              status: "error",
              reason: preflight?.reason || "pull_unavailable",
              retryAfterMs: Math.max(1000, Number(preflight?.retryAfterMs || 5000)),
            };
          }
        }

        clearPendingProcessNextTimer();
        setSenderRunVersion(getSenderRunVersion() + 1);
        resetRuntimeCounters();
        state.isRunning = true;
        state.dmsSentThisSession = 0;
        state.nextDMTime = Date.now();
        wsModule.resetSendWsFailures();
        watchdogModule.resetRecoveryState();
        watchdogModule.updateProgress("started");

        await storageModule.saveState({
          dm_sender_running: true,
          dm_sender_session_count: 0,
          dm_sender_next_time: state.nextDMTime,
          dm_sender_failure_metrics: {
            transient: 0,
            definitive: 0,
            last_error_code: null,
            last_failure_class: null,
            updated_at: Date.now(),
          },
        });

        const cfg = await authModule.loadSettings();
        await wsModule.connectSendWs(cfg);
        if (fromAccountHint) {
          pinSenderAccountForRun(fromAccountHint);
        }
        const heartbeatOk = await reportingModule.sendSenderHeartbeat(true, fromAccountHint);
        if (!heartbeatOk) {
          console.warn("[BG] Heartbeat preflight falló; sender no quedó activo.");
          await stopSender("heartbeat_preflight_failed");
          return { status: "error", reason: "sender_offline" };
        }

        chrome.alarms.create(state.pollAlarmName, {
          periodInMinutes: config.pollIntervalMs / 60000,
        });
        reportingModule.flushPendingReports().catch((e) => {
          console.warn("[BG] flushPendingReports on start failed:", e?.message || e);
        });

        if (prefetchedTask) {
          await processNextTask(prefetchedTask);
        } else if (!deferFirstPull) {
          await processNextTask();
        }

        return {
          status: "started",
          defer_first_pull: deferFirstPull,
          prefetched_task: !!prefetchedTask,
          idle_start: allowIdleStart,
          from_account: getPinnedSenderAccount() || "",
        };
      } finally {
        setStartSenderInFlight(false);
      }
    }

    async function stopSender(reason = "manual") {
      const hasActiveProcessing = !!getActiveProcessToken();
      if (!state.isRunning && !hasActiveProcessing) {
        return { status: "already_stopped", reason };
      }
      console.log("[BG] Deteniendo sender, razón:", reason);

      setSenderRunVersion(getSenderRunVersion() + 1);

      if (reason === "no_tasks") {
        setNoTasksRestartCooldownUntil(Date.now() + NO_TASKS_RESTART_COOLDOWN_MS);
      } else if (reason !== "manual") {
        setNoTasksRestartCooldownUntil(0);
      }

      state.isRunning = false;
      resetRuntimeCounters();
      if (!hasActiveProcessing) {
        state.isProcessing = false;
        state.currentTask = null;
      }
      watchdogModule.resetRecoveryState();
      watchdogModule.updateProgress("idle");
      reportingModule.resetRuntimeState();
      clearPendingProcessTriggerTimer();
      clearPendingProcessNextTimer();
      wsModule.disconnectSendWs();

      const statePatch = {
        dm_sender_running: false,
      };
      if (!hasActiveProcessing || !state.currentTask) {
        statePatch.dm_current_task = null;
      }
      await storageModule.saveState(statePatch);

      chrome.alarms.clear(state.pollAlarmName);

      notifyPopupStatusUpdate(
        {
          lastUsername: null,
          success: null,
          sessionCount: state.dmsSentThisSession,
          nextDMTime: state.nextDMTime,
          isRunning: false,
        },
        "sender_stopped"
      );

      return { status: "stopped", reason };
    }

    return {
      startSender,
      stopSender,
    };
  }

  globalScope.createBackgroundJobsLifecycleModule = createBackgroundJobsLifecycleModule;
})(self);
