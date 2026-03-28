(function initBackgroundJobsModule(globalScope) {
  function createBackgroundJobsModule({
    state,
    config,
    storageModule,
    authModule,
    wsModule,
    processTriggerMinGapMs,
    heartbeatMinGapMs,
    heartbeatInstanceId,
    wsPullGraceMs,
    pendingReportsMax,
  }) {
    let lastProcessTriggerTs = 0;
    let pendingProcessTriggerTimer = null;
    let pendingProcessNextTimer = null;
    let senderRunVersion = 0;
    let activeProcessToken = null;
    let startSenderInFlight = false;
    let fatalStopInFlight = false;
    let lastProcessingSkipLogTs = 0;
    let lastSenderNotRunningLogTs = 0;

    const AUTH_ERROR_BACKOFF_MS = 60000;
    const SEND_DM_TOTAL_TIMEOUT_MS = 120000;
    const NETWORK_FETCH_TIMEOUT_MS = 20000;
    const THREAD_IDENTITY_MAX_RETRIES = 1;
    const EMPTY_PULL_MAX_STREAK_BEFORE_STOP = 8;
    const EMPTY_PULL_RETRY_BASE_MS = 1500;
    const ACCOUNT_FALLBACK_LIVENESS_GRACE_MS = 120000;
    const STACK_OVERFLOW_ERROR_TOKEN = "maximum call stack size exceeded";

    function randomBetween(min, max) {
      return Math.floor(Math.random() * (max - min + 1)) + min;
    }

    function formatTime(ms) {
      const seconds = Math.floor(ms / 1000);
      const minutes = Math.floor(seconds / 60);
      const secs = seconds % 60;
      return `${minutes}:${secs.toString().padStart(2, "0")}`;
    }

    function maskIdentity(value) {
      const raw = String(value || "").trim();
      if (!raw) return "unknown";
      if (raw.length <= 2) return "*".repeat(raw.length);
      return `${raw.slice(0, 2)}***`;
    }

    function normalizeAccount(value) {
      return String(value || "")
        .trim()
        .toLowerCase();
    }

    const runStateModule = self.createBackgroundJobsRunStateModule({
      state,
      storageModule,
      normalizeAccount,
      maskIdentity,
      accountFallbackLivenessGraceMs: ACCOUNT_FALLBACK_LIVENESS_GRACE_MS,
    });

    function buildFailureMetrics() {
      return runStateModule.buildFailureMetrics();
    }

    const runtimeSendMessage =
      typeof chrome?.runtime?.sendMessage === "function"
        ? chrome.runtime.sendMessage.bind(chrome.runtime)
        : null;

    function isIgnorableRuntimeMessageError(error) {
      const msg = String(error?.message || error || "").toLowerCase();
      return (
        msg.includes("receiving end does not exist") ||
        msg.includes("could not establish connection") ||
        msg.includes("message port closed before a response was received")
      );
    }

    async function safeRuntimeSendMessage(payload) {
      if (!runtimeSendMessage) return null;
      try {
        return await runtimeSendMessage(payload);
      } catch (e) {
        if (isIgnorableRuntimeMessageError(e)) {
          return null;
        }
        throw e;
      }
    }

    async function notifyPopupStatusUpdate(data, context = "status_update") {
      try {
        await safeRuntimeSendMessage({
          type: "dm_status_update",
          data,
        });
      } catch (e) {
        console.warn(`[BG] Failed to notify popup (${context}):`, e?.message || e);
      }
    }

    function clearPendingProcessNextTimer() {
      if (!pendingProcessNextTimer) return;
      clearTimeout(pendingProcessNextTimer);
      pendingProcessNextTimer = null;
    }

    function clearPendingProcessTriggerTimer() {
      if (!pendingProcessTriggerTimer) return;
      clearTimeout(pendingProcessTriggerTimer);
      pendingProcessTriggerTimer = null;
    }

    function scheduleProcessNextTask(delayMs, reason = "scheduled") {
      const waitMs = Math.max(0, Number(delayMs || 0));
      const expectedRunVersion = senderRunVersion;
      clearPendingProcessNextTimer();
      pendingProcessNextTimer = setTimeout(() => {
        pendingProcessNextTimer = null;
        if (!state.isRunning || expectedRunVersion !== senderRunVersion) {
          return;
        }
        console.log("[BG] Trigger processNextTask:", reason, `(+${waitMs}ms)`);
        runProcessNextTaskSafe();
      }, waitMs);
    }

    let lifecycleModule = null;

    const watchdogModule = self.createBackgroundJobsWatchdogModule({
      state,
      storageModule,
      wsModule,
      authModule,
      scheduleProcessNextTask,
      stopSender: (reason) => stopSender(reason),
      notifyPopupStatusUpdate,
      reportResult: (...args) => reportingModule.reportResult(...args),
      ensureInstagramDirectReady: (...args) => runtimeModule.ensureInstagramDirectReady(...args),
      buildFailureMetrics,
      extendedStateProvider: () => ({
        emptyPullStreak: runStateModule.getEmptyPullStreak(),
        consecutiveThreadIdentityFails: runStateModule.getConsecutiveThreadIdentityFails(),
      }),
    });

    const runtimeModule = self.createBackgroundJobsRuntimeModule({
      maskIdentity,
      updateProgress: watchdogModule.updateProgress,
      sendDmTotalTimeoutMs: SEND_DM_TOTAL_TIMEOUT_MS,
    });

    const reportingModule = self.createBackgroundJobsReportingModule({
      state,
      storageModule,
      authModule,
      pendingReportsMax,
      heartbeatMinGapMs,
      heartbeatInstanceId,
      authErrorBackoffMs: AUTH_ERROR_BACKOFF_MS,
      networkFetchTimeoutMs: NETWORK_FETCH_TIMEOUT_MS,
      maskIdentity,
      normalizeAccount,
      getPinnedSenderAccount: runStateModule.getPinnedSenderAccount,
      pinSenderAccountForRun: runStateModule.pinSenderAccountForRun,
      getFallbackHeartbeatAccount: runStateModule.getFallbackHeartbeatAccount,
      getLoggedInUsername: runtimeModule.getLoggedInUsername,
      updateProgress: watchdogModule.updateProgress,
    });

    const outcomesModule = self.createBackgroundJobsOutcomesModule({
      state,
      storageModule,
      reportingModule,
      runStateModule,
      wsModule,
      maskIdentity,
      scheduleProcessNextTask,
      notifyPopupStatusUpdate,
      stopSender: (reason) => stopSender(reason),
      randomBetween,
      minDelayBetweenDMs: config.minDelayBetweenDMs,
      maxDelayBetweenDMs: config.maxDelayBetweenDMs,
    });

    function isStackOverflowError(error) {
      if (error instanceof RangeError) return true;
      const msg = String(error?.message || error || "").toLowerCase();
      return msg.includes(STACK_OVERFLOW_ERROR_TOKEN);
    }

    function runProcessNextTaskSafe(prefetchedTask = null) {
      processNextTask(prefetchedTask).catch((e) => {
        console.error("[BG] processNextTask fatal error:", e?.message || e);
        if (!isStackOverflowError(e) || !state.isRunning || fatalStopInFlight) {
          return;
        }
        fatalStopInFlight = true;
        stopSender("runtime_stack_overflow")
          .then(() =>
            notifyPopupStatusUpdate(
              {
                error: "runtime_stack_overflow",
                message:
                  "El envio se detuvo por un error interno de mensajeria. Recarga la extension y reintenta.",
                isRunning: false,
              },
              "runtime_stack_overflow"
            )
          )
          .catch((stopErr) => {
            console.error("[BG] stopSender failed after stack overflow:", stopErr?.message || stopErr);
          })
          .finally(() => {
            fatalStopInFlight = false;
          });
      });
    }

    function triggerProcessNextTaskThrottled() {
      const now = Date.now();
      const elapsed = now - lastProcessTriggerTs;
      if (elapsed >= processTriggerMinGapMs) {
        lastProcessTriggerTs = now;
        runProcessNextTaskSafe();
        return;
      }
      if (pendingProcessTriggerTimer) return;
      const waitMs = Math.max(50, processTriggerMinGapMs - elapsed);
      pendingProcessTriggerTimer = setTimeout(() => {
        pendingProcessTriggerTimer = null;
        lastProcessTriggerTs = Date.now();
        runProcessNextTaskSafe();
      }, waitMs);
    }

    function isSafeThreadIdentityRetry(result) {
      const code = String(result?.error || "")
        .trim()
        .toLowerCase();
      if (code !== "thread_identity_not_verified") return false;
      const steps = Array.isArray(result?.steps)
        ? result.steps.map((s) =>
            String(s || "")
              .trim()
              .toLowerCase()
          )
        : [];
      if (!steps.length) return false;
      const touchedComposer =
        steps.includes("type_message") || steps.some((s) => s === "send" || s.startsWith("sent:"));
      return !touchedComposer;
    }

    async function prepareThreadIdentityRetry() {
      try {
        const recovered = await runtimeModule.ensureInstagramDirectReady(2);
        return !!recovered?.ok;
      } catch (e) {
        console.warn("[BG] prepareThreadIdentityRetry failed:", e?.message || e);
        return false;
      }
    }

    function isSessionLimitReached() {
      return state.dmsSentThisSession >= config.maxDMsPerSession;
    }

    async function runBackgroundSyncSideEffects() {
      reportingModule.sendSenderHeartbeat().catch((e) => {
        console.warn("[BG] sendSenderHeartbeat failed:", e?.message || e);
      });
      reportingModule.flushPendingReports().catch((e) => {
        console.warn("[BG] flushPendingReports failed:", e?.message || e);
      });
    }

    function handleCooldownWait(now) {
      if (state.nextDMTime <= now) return false;
      if (watchdogModule.getProgressStage() !== "cooldown_wait") {
        watchdogModule.updateProgress("cooldown_wait");
      } else {
        watchdogModule.markProgressStage("cooldown_wait");
      }
      console.log(`[BG] Esperando... próximo DM en ${Math.round((state.nextDMTime - now) / 1000)}s`);
      return true;
    }

    async function pullTaskWithRecovery(isRunAborted) {
      console.log("[BG] Pulling task (HTTP)...");
      const pull = await reportingModule.pullTask();
      if (isRunAborted()) {
        return { type: "aborted" };
      }
      if (pull?.status === "task") {
        return { type: "task", task: pull.task };
      }
      if (pull?.status === "empty") {
        return { type: "empty" };
      }

      let waitMs = Math.max(1000, Number(pull?.retryAfterMs || 5000));
      const pullReason = String(pull?.reason || "")
        .trim()
        .toLowerCase();
      if (pullReason === "account_not_detected") {
        console.warn("[BG] Pull sin cuenta detectada: intentando recuperación agresiva de pestaña...");
        try {
          const recovered = await runtimeModule.ensureInstagramDirectReady(1);
          if (recovered?.ok) {
            waitMs = Math.min(waitMs, 1500);
          }
        } catch (e) {
          console.warn("[BG] Pull recovery failed:", e?.message || e);
        }
      }

      return { type: "retry", waitMs };
    }

    async function acquireNextTask(prefetchedTask, isRunAborted) {
      if (prefetchedTask) {
        return { type: "task", task: prefetchedTask };
      }

      if (wsModule.isSendWsConnected() && wsModule.hasPendingWsTasks()) {
        const wsTask = wsModule.shiftPendingWsTask();
        if (wsTask) {
          watchdogModule.updateProgress("ws_tasks");
          return { type: "task", task: wsTask };
        }
      }

      if (wsModule.isSendWsConnected() && state.isRunning) {
        const requested = wsModule.requestSendWsPull();
        if (requested) {
          const wsTask = await wsModule.waitForWsTask(wsPullGraceMs);
          if (wsTask) {
            watchdogModule.updateProgress("ws_tasks");
            return { type: "task", task: wsTask };
          }
        }
      }

      return pullTaskWithRecovery(isRunAborted);
    }

    async function handleNoTaskAvailable() {
      const emptyPullStreak = runStateModule.incrementEmptyPullStreak();
      const shouldStopForNoTasks = emptyPullStreak >= EMPTY_PULL_MAX_STREAK_BEFORE_STOP;
      if (!shouldStopForNoTasks) {
        const retryMs = Math.min(5000, EMPTY_PULL_RETRY_BASE_MS + (emptyPullStreak - 1) * 500);
        watchdogModule.updateProgress("no_tasks_retry");
        notifyPopupStatusUpdate(
          {
            isRunning: true,
            message: `Sin tareas por ahora. Reintentando en ${Math.max(1, Math.ceil(retryMs / 1000))}s...`,
          },
          "no_tasks_retry"
        );
        if (state.isRunning) {
          scheduleProcessNextTask(retryMs, "no_tasks_retry");
        }
        return;
      }

      runStateModule.resetEmptyPullStreak();
      console.log("[BG] No hay tareas pendientes (confirmado tras reintentos)");
      try {
        await stopSender("no_tasks");
        notifyPopupStatusUpdate(
          {
            isRunning: false,
            message: "No hay más mensajes pendientes para enviar.",
          },
          "no_tasks"
        );
      } catch (e) {
        console.error("[BG] Error stopping sender (no_tasks):", e);
      }
    }

    async function claimTask(task) {
      runStateModule.resetEmptyPullStreak();
      console.log("[BG] Task obtenida:", String(task?.task_id || "sin_task_id"));
      state.currentTask = task;
      watchdogModule.resetRecoveryState();
      watchdogModule.updateProgress("task_claimed");
      await storageModule.saveState({
        dm_current_task: {
          job_id: task.job_id,
          task_id: task.task_id,
          lease_proof: task.lease_proof || null,
          dest_username: task.dest_username || task.payload?.target_username,
          claimed_at: Date.now(),
        },
      });
    }

    function extractTaskExecutionPayload(task) {
      return {
        leaseProof: String(task?.lease_proof || "").trim(),
        username: task?.dest_username || task?.payload?.target_username || null,
        message: task?.payload?.message_template || task?.payload?.message || "Hola!",
        dryRun: task?.payload?.dry_run !== false,
      };
    }

    async function handleInvalidClaimedTask(task, payload, isRunAborted) {
      if (!payload.leaseProof) {
        console.error("[BG] Task sin lease_proof");
        await stopSender("missing_lease_proof");
        return true;
      }

      if (!payload.username) {
        console.error("[BG] Task sin username");
        await reportingModule.reportResult(
          task.job_id,
          task.task_id,
          payload.leaseProof,
          false,
          null,
          "missing_username"
        );
        return true;
      }

      const processed = await storageModule.getProcessedTaskResult(task.task_id);
      if (processed && processed.report) {
        console.warn(
          "[BG] Task ya procesada localmente; se omite reenvío y se reintenta reportar",
          task.task_id
        );
        await reportingModule.reportResult(
          task.job_id,
          task.task_id,
          payload.leaseProof,
          !!processed.report.ok,
          processed.report.dest_username || payload.username,
          processed.report.error || null,
          !!processed.report.dry_run
        );
        state.currentTask = null;
        return true;
      }

      if (isRunAborted()) {
        await reportingModule.reportResult(
          task.job_id,
          task.task_id,
          payload.leaseProof,
          false,
          payload.username,
          "sender_stopped_before_send",
          payload.dryRun
        );
        state.currentTask = null;
        return true;
      }

      return false;
    }

    async function executeTaskWithRetries(username, message, dryRun, isRunAborted) {
      console.log(`[BG] Ejecutando DM a ${maskIdentity(username)} (dryRun: ${dryRun})`);
      let result = await runtimeModule.sendDMViaContentScriptWithTimeout(username, message, dryRun);

      let threadIdentityRetries = 0;
      while (
        !result?.success &&
        isSafeThreadIdentityRetry(result) &&
        threadIdentityRetries < THREAD_IDENTITY_MAX_RETRIES &&
        !isRunAborted()
      ) {
        threadIdentityRetries += 1;
        console.warn(
          "[BG] thread_identity_not_verified para",
          maskIdentity(username),
          "- reintento controlado",
          `${threadIdentityRetries}/${THREAD_IDENTITY_MAX_RETRIES}`
        );
        watchdogModule.updateProgress("thread_identity_retry");
        const prepared = await prepareThreadIdentityRetry();
        if (!prepared) break;
        await new Promise((r) => setTimeout(r, 900));
        result = await runtimeModule.sendDMViaContentScriptWithTimeout(username, message, dryRun);
      }

      return result;
    }

    async function processNextTask(prefetchedTask = null) {
      await storageModule.loadState();
      const runVersion = senderRunVersion;
      const isRunAborted = () => !state.isRunning || runVersion !== senderRunVersion;

      if (state.isProcessing) {
        const now = Date.now();
        if (now - lastProcessingSkipLogTs > 10000) {
          console.log("[BG] Ya hay un envío en curso, esperando...");
          lastProcessingSkipLogTs = now;
        }
        return;
      }
      const processToken = Symbol("process_next_task");
      activeProcessToken = processToken;
      state.isProcessing = true;

      try {
        if (isRunAborted()) {
          const now = Date.now();
          if (now - lastSenderNotRunningLogTs > 10000) {
            console.log("[BG] Sender no está corriendo");
            lastSenderNotRunningLogTs = now;
          }
          return;
        }

        await runBackgroundSyncSideEffects();

        if (isSessionLimitReached()) {
          console.log("[BG] Límite de sesión alcanzado");
          try {
            await stopSender("session_limit");
          } catch (e) {
            console.error("[BG] Error stopping sender (session_limit):", e);
          }
          return;
        }

        const now = Date.now();
        if (handleCooldownWait(now)) {
          return;
        }

        const acquired = await acquireNextTask(prefetchedTask, isRunAborted);
        if (acquired.type === "aborted") {
          return;
        }
        if (acquired.type === "retry") {
          console.warn("[BG] Pull no disponible temporalmente, reintentando en", acquired.waitMs, "ms");
          if (state.isRunning) {
            scheduleProcessNextTask(acquired.waitMs, "pull_retry");
          }
          return;
        }

        const task = acquired.type === "task" ? acquired.task : null;
        if (!task) {
          await handleNoTaskAvailable();
          return;
        }

        if (isRunAborted()) {
          return;
        }

        await claimTask(task);
        const payload = extractTaskExecutionPayload(task);
        const shouldStop = await handleInvalidClaimedTask(task, payload, isRunAborted);
        if (shouldStop) {
          return;
        }

        const result = await executeTaskWithRetries(
          payload.username,
          payload.message,
          payload.dryRun,
          isRunAborted
        );
        const outcome = await outcomesModule.buildTaskOutcome(task, payload, result);

        if (!result.success && outcome.errorCode === "thread_identity_not_verified") {
          watchdogModule.updateProgress("thread_identity_skip");
          await outcomesModule.handleThreadIdentityFailure(payload.username, outcome.failureClass);
          return;
        }

        await outcomesModule.finalizeTaskRun(
          payload.username,
          payload.dryRun,
          result,
          outcome.failureClass
        );
      } finally {
        if (activeProcessToken === processToken) {
          activeProcessToken = null;
          state.isProcessing = false;
        }
      }
    }

    lifecycleModule = self.createBackgroundJobsLifecycleModule({
      state,
      config,
      storageModule,
      authModule,
      wsModule,
      reportingModule,
      watchdogModule,
      normalizeAccount,
      getPinnedSenderAccount: runStateModule.getPinnedSenderAccount,
      pinSenderAccountForRun: runStateModule.pinSenderAccountForRun,
      clearPendingProcessNextTimer,
      clearPendingProcessTriggerTimer,
      notifyPopupStatusUpdate,
      getActiveProcessToken: () => activeProcessToken,
      getStartSenderInFlight: () => startSenderInFlight,
      setStartSenderInFlight: (value) => {
        startSenderInFlight = !!value;
      },
      getSenderRunVersion: () => senderRunVersion,
      setSenderRunVersion: (value) => {
        senderRunVersion = Number(value || 0);
      },
      getNoTasksRestartCooldownUntil: runStateModule.getNoTasksRestartCooldownUntil,
      setNoTasksRestartCooldownUntil: runStateModule.setNoTasksRestartCooldownUntil,
      resetRuntimeCounters: runStateModule.clearRuntimeState,
      getCurrentKnownAccount: runStateModule.getCurrentKnownAccount,
      processNextTask,
    });

    async function startSender(options = {}) {
      return lifecycleModule.startSender(options);
    }

    async function stopSender(reason = "manual") {
      return lifecycleModule.stopSender(reason);
    }

    async function getSenderStatus() {
      await storageModule.loadState();

      const now = Date.now();
      const timeUntilNext = Math.max(0, state.nextDMTime - now);

      return {
        isRunning: state.isRunning,
        isProcessing: state.isProcessing,
        sessionCount: state.dmsSentThisSession,
        lastDMTime: state.lastDMTime,
        nextDMTime: state.nextDMTime,
        timeUntilNextMs: timeUntilNext,
        timeUntilNextFormatted: formatTime(timeUntilNext),
        currentTask: state.currentTask,
        progressStage: watchdogModule.getProgressStage(),
        lastProgressTs: watchdogModule.getLastProgressTs(),
        watchdogRecoveryAttempts: watchdogModule.getWatchdogRecoveryAttempts(),
        watchdogState: watchdogModule.getWatchdogState(),
        failureMetrics: buildFailureMetrics(),
        noTasksRestartCooldownMs: Math.max(0, runStateModule.getNoTasksRestartCooldownUntil() - now),
        fromAccount: normalizeAccount(
          runStateModule.getCurrentActiveAccount() || runStateModule.getCurrentKnownAccount()
        ),
      };
    }

    async function reportOrphanTask(task) {
      if (!task) return;
      console.warn("[BG] Reporting orphan task:", task.task_id);
      await reportingModule.reportResult(
        task.job_id,
        task.task_id,
        task.lease_proof,
        false,
        task.dest_username,
        "orphan_on_restart"
      );
      await storageModule.saveState({ dm_current_task: null });
    }

    function restoreKnownAccount(account, accountTs = 0) {
      runStateModule.restoreKnownAccount(account, accountTs);
    }

    return {
      triggerProcessNextTaskThrottled,
      getLoggedInUsername: runtimeModule.getLoggedInUsername,
      pullTask: reportingModule.pullTask,
      sendReportRequest: reportingModule.sendReportRequest,
      flushPendingReports: reportingModule.flushPendingReports,
      reportResult: reportingModule.reportResult,
      sendSenderHeartbeat: reportingModule.sendSenderHeartbeat,
      sendAutonomousHeartbeat: reportingModule.sendAutonomousHeartbeat,
      findOrCreateInstagramTab: runtimeModule.findOrCreateInstagramTab,
      waitTabLoadComplete: runtimeModule.waitTabLoadComplete,
      ensureContentScriptReady: runtimeModule.ensureContentScriptReady,
      sendDMViaContentScript: runtimeModule.sendDMViaContentScript,
      processNextTask,
      startSender,
      stopSender,
      getSenderStatus,
      formatTime,
      runWatchdog: watchdogModule.runWatchdog,
      reportOrphanTask,
      getWatchdogState: watchdogModule.getWatchdogState,
      restoreProgressState: watchdogModule.restoreProgressState,
      restoreKnownAccount,
    };
  }

  globalScope.createBackgroundJobsModule = createBackgroundJobsModule;
})(self);
