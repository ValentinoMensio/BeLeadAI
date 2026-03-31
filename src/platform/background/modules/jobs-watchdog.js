(function initBackgroundJobsWatchdogModule(globalScope) {
  function createBackgroundJobsWatchdogModule({
    state,
    storageModule,
    wsModule,
    authModule,
    scheduleProcessNextTask,
    stopSender,
    notifyPopupStatusUpdate,
    reportResult,
    ensureInstagramDirectReady,
    buildFailureMetrics,
    extendedStateProvider,
  }) {
    let lastProgressTs = 0;
    let progressStage = "idle";
    let watchdogRecoveryAttempts = 0;
    let watchdogRecoveryInFlight = null;
    let lastProgressLogTs = 0;
    let lastLoggedProgressStage = "";
    let lastPersistedProgressTs = 0;
    let lastPersistedProgressStage = "";

    const WATCHDOG_NO_PROGRESS_TIMEOUT_MS = 90000;
    const WATCHDOG_NO_PROGRESS_TIMEOUT_NAV_MS = 150000;
    const WATCHDOG_MAX_RECOVERY_ATTEMPTS = 3;
    const PROGRESS_PERSIST_MIN_GAP_MS = 4000;
    const PROGRESS_LOG_MIN_GAP_MS = 8000;
    const CRITICAL_PROGRESS_STAGES = new Set([
      "started",
      "task_claimed",
      "result_reported",
      "flush_ok",
      "idle",
      "recovery",
    ]);

    function updateProgress(stage) {
      const now = Date.now();
      lastProgressTs = now;
      progressStage = stage;
      if (stage !== lastLoggedProgressStage || now - lastProgressLogTs >= PROGRESS_LOG_MIN_GAP_MS) {
        console.log(`[BG] Progress: ${stage}`);
        lastLoggedProgressStage = stage;
        lastProgressLogTs = now;
      }
      const shouldPersist =
        CRITICAL_PROGRESS_STAGES.has(stage) ||
        stage !== lastPersistedProgressStage ||
        now - lastPersistedProgressTs >= PROGRESS_PERSIST_MIN_GAP_MS;
      if (!shouldPersist) return;
      lastPersistedProgressStage = stage;
      lastPersistedProgressTs = now;
      storageModule
        .saveState({
          dm_last_progress_ts: lastProgressTs,
          dm_progress_stage: stage,
        })
        .catch((e) => {
          console.warn("[BG] updateProgress: failed to persist progress state", e?.message || e);
        });
    }

    function markProgressStage(stage) {
      lastProgressTs = Date.now();
      progressStage = stage;
    }

    async function runWatchdog() {
      if (!state.isRunning) return;
      if (watchdogRecoveryInFlight) return;

      const now = Date.now();
      if (!state.currentTask && state.nextDMTime > now) {
        markProgressStage("cooldown_wait");
        return;
      }
      const timeSinceProgress = now - lastProgressTs;

      const isNavigationStage = ["started", "task_claimed", "ws_tasks", "pull_ok"].includes(
        progressStage
      );
      const effectiveTimeout = isNavigationStage
        ? WATCHDOG_NO_PROGRESS_TIMEOUT_NAV_MS
        : WATCHDOG_NO_PROGRESS_TIMEOUT_MS;

      if (timeSinceProgress <= effectiveTimeout) return;

      console.warn(
        `[BG] Watchdog: no progress for ${Math.round(timeSinceProgress / 1000)}s (stage: ${progressStage}, timeout: ${Math.round(effectiveTimeout / 1000)}s)`
      );

      if (watchdogRecoveryAttempts >= WATCHDOG_MAX_RECOVERY_ATTEMPTS) {
        console.error("[BG] Watchdog: max recovery attempts reached, stopping sender");
        await stopSender("watchdog_max_recovery");
        notifyPopupStatusUpdate(
          {
            error: "watchdog_stuck",
            message: "El envío se detuvo por falta de progreso. Revisá Instagram y reiniciá.",
            isRunning: false,
          },
          "watchdog_stuck"
        );
        return;
      }

      watchdogRecoveryAttempts += 1;
      console.log(
        `[BG] Watchdog: recovery attempt ${watchdogRecoveryAttempts}/${WATCHDOG_MAX_RECOVERY_ATTEMPTS}`
      );
      watchdogRecoveryInFlight = (async () => {
        try {
          await performWatchdogRecovery();
        } finally {
          watchdogRecoveryInFlight = null;
        }
      })();
      await watchdogRecoveryInFlight;
    }

    async function performWatchdogRecovery() {
      if (state.currentTask) {
        console.warn("[BG] Watchdog: reporting stuck task as uncertain");
        await reportResult(
          state.currentTask.job_id,
          state.currentTask.task_id,
          state.currentTask.lease_proof,
          false,
          state.currentTask.dest_username,
          "watchdog_uncertain_timeout"
        );
        state.currentTask = null;
      }

      if (!wsModule.isSendWsConnected()) {
        const cfg = await authModule.loadSettings();
        await wsModule.connectSendWs(cfg);
      }

      try {
        const recovered = await ensureInstagramDirectReady(2);
        if (!recovered?.ok) {
          console.warn("[BG] Watchdog: aggressive tab recovery did not succeed");
        }
      } catch (e) {
        console.warn("[BG] Watchdog: tab recovery failed", e?.message || e);
      }

      updateProgress("recovery");

      if (state.isRunning) {
        scheduleProcessNextTask(0, "watchdog_recovery");
      }
    }

    function getWatchdogState() {
      const extra =
        typeof extendedStateProvider === "function" ? extendedStateProvider() || {} : {};
      return {
        lastProgressTs,
        progressStage,
        watchdogRecoveryAttempts,
        emptyPullStreak: Number(extra.emptyPullStreak || 0),
        consecutiveThreadIdentityFails: Number(extra.consecutiveThreadIdentityFails || 0),
        failureMetrics: buildFailureMetrics(),
        noProgressTimeoutMs: WATCHDOG_NO_PROGRESS_TIMEOUT_MS,
        maxRecoveryAttempts: WATCHDOG_MAX_RECOVERY_ATTEMPTS,
      };
    }

    function restoreProgressState(progressTs, stage) {
      const restoredTs = Number(progressTs || 0);
      lastProgressTs = restoredTs > 0 ? restoredTs : Date.now();
      const restoredStage = String(stage || "").trim();
      progressStage = restoredStage || "idle";
    }

    function getProgressStage() {
      return progressStage;
    }

    function getLastProgressTs() {
      return lastProgressTs;
    }

    function getWatchdogRecoveryAttempts() {
      return watchdogRecoveryAttempts;
    }

    function resetRecoveryState() {
      watchdogRecoveryAttempts = 0;
    }

    return {
      updateProgress,
      markProgressStage,
      runWatchdog,
      getWatchdogState,
      restoreProgressState,
      getProgressStage,
      getLastProgressTs,
      getWatchdogRecoveryAttempts,
      resetRecoveryState,
    };
  }

  globalScope.createBackgroundJobsWatchdogModule = createBackgroundJobsWatchdogModule;
})(self);
