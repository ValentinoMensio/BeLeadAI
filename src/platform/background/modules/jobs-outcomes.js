(function initBackgroundJobsOutcomesModule(globalScope) {
  function createBackgroundJobsOutcomesModule({
    state,
    storageModule,
    reportingModule,
    runStateModule,
    wsModule,
    maskIdentity,
    scheduleProcessNextTask,
    notifyPopupStatusUpdate,
    stopSender,
    randomBetween,
    minDelayBetweenDMs,
    maxDelayBetweenDMs,
  }) {
    function classifyFailure(errorCode) {
      const code = String(errorCode || "")
        .trim()
        .toLowerCase();
      if (!code) return "transient";
      if (code === "invalid_username" || code === "unauthorized_sender") return "definitive";
      if (code === "thread_identity_not_verified") return "definitive";
      if (
        code.includes("timeout") ||
        code.includes("not_found") ||
        code.includes("recovery_failed")
      ) {
        return "transient";
      }
      if (code.includes("search_or_open_thread_failed")) return "transient";
      if (code.includes("navigation_direct_failed")) return "transient";
      if (code.includes("content_script_not_ready")) return "transient";
      if (code.includes("send_not_confirmed") || code.includes("write_failed")) return "transient";
      return "transient";
    }

    async function recordFailureMetric(errorCode) {
      const failureClass = classifyFailure(errorCode);
      runStateModule.incrementFailureMetric(failureClass);
      const counts = runStateModule.getFailureMetricCounts();
      try {
        await storageModule.saveState({
          dm_sender_failure_metrics: {
            transient: counts.transient,
            definitive: counts.definitive,
            last_error_code:
              String(errorCode || "")
                .trim()
                .toLowerCase() || null,
            last_failure_class: failureClass,
            updated_at: Date.now(),
          },
        });
      } catch (e) {
        console.warn("[BG] Failed to persist failure metrics:", e?.message || e);
      }
      return failureClass;
    }

    async function buildTaskOutcome(task, payload, result) {
      await storageModule.rememberProcessedTaskResult(task.task_id, {
        lease_proof: payload.leaseProof,
        ok: !!result.success,
        dest_username: payload.username,
        error: result.error || null,
        dry_run: !!payload.dryRun,
      });

      const errorCode = String(result?.error || "")
        .trim()
        .toLowerCase();
      let failureClass = null;
      if (!result.success) {
        try {
          failureClass = await recordFailureMetric(errorCode);
        } catch (e) {
          console.warn("[BG] recordFailureMetric failed:", e?.message || e);
          failureClass = classifyFailure(errorCode);
        }
      }

      await reportingModule.reportResult(
        task.job_id,
        task.task_id,
        payload.leaseProof,
        result.success,
        payload.username,
        result.error,
        payload.dryRun
      );

      return { errorCode, failureClass };
    }

    async function handleThreadIdentityFailure(username, failureClass) {
      const consecutiveThreadIdentityFails = runStateModule.incrementThreadIdentityFails();
      state.currentTask = null;

      if (consecutiveThreadIdentityFails >= 3) {
        console.warn(
          "[BG] Corte preventivo: identidad de thread no verificada de forma consecutiva para",
          maskIdentity(username),
          "- se detiene sender para evitar errores en cascada."
        );
        try {
          await stopSender("thread_identity_not_verified");
        } catch (e) {
          console.error("[BG] Error stopping sender (thread_identity):", e);
        }
        notifyPopupStatusUpdate(
          {
            lastUsername: username,
            success: false,
            sessionCount: state.dmsSentThisSession,
            nextDMTime: 0,
            isRunning: false,
            error: "thread_identity_not_verified",
            failureClass: failureClass || "definitive",
          },
          "thread_identity"
        );
        return;
      }

      const retryAfterMs = 6000;
      state.nextDMTime = Date.now() + retryAfterMs;
      await storageModule.saveState({
        dm_sender_next_time: state.nextDMTime,
      });
      notifyPopupStatusUpdate(
        {
          lastUsername: username,
          success: false,
          sessionCount: state.dmsSentThisSession,
          nextDMTime: state.nextDMTime,
          isRunning: true,
          error: "thread_identity_not_verified",
          failureClass: failureClass || "definitive",
          message: "No se pudo validar el hilo; se salta este contacto y se continúa.",
        },
        "thread_identity_soft"
      );
      if (state.isRunning) {
        scheduleProcessNextTask(retryAfterMs, "thread_identity_skip");
      }
    }

    async function finalizeTaskRun(username, dryRun, result, failureClass) {
      if (
        result.success ||
        String(result?.error || "")
          .trim()
          .toLowerCase() !== "thread_identity_not_verified"
      ) {
        runStateModule.resetThreadIdentityFails();
      }

      if (result.success) {
        state.dmsSentThisSession += 1;
        state.lastDMTime = Date.now();
        state.nextDMTime = dryRun
          ? Date.now() + 5000
          : Date.now() + randomBetween(minDelayBetweenDMs, maxDelayBetweenDMs);
      } else {
        state.nextDMTime = Date.now() + 10000;
      }
      state.currentTask = null;

      await storageModule.saveState({
        dm_sender_session_count: state.dmsSentThisSession,
        dm_sender_last_time: state.lastDMTime,
        dm_sender_next_time: state.nextDMTime,
      });

      notifyPopupStatusUpdate(
        {
          lastUsername: username,
          success: result.success,
          sessionCount: state.dmsSentThisSession,
          nextDMTime: state.nextDMTime,
          failureClass: failureClass || null,
        },
        "dm_status_update"
      );

      if (dryRun) {
        console.log(`[BG] Dry-run OK para ${maskIdentity(username)}. Siguiente usuario en 5 s.`);
      } else if (!result.success) {
        console.log(
          `[BG] DM fallido para ${maskIdentity(username)} (${result.error || "unknown_error"}) [${failureClass || "transient"}]. Reintento de siguiente tarea en 10 s.`
        );
      } else {
        console.log(
          `[BG] DM ${result.success ? "exitoso" : "fallido"} a ${maskIdentity(username)}. Próximo en ${Math.round((state.nextDMTime - Date.now()) / 60000)} minutos`
        );
      }

      if (!state.isRunning) return;
      if (!result.success) {
        scheduleProcessNextTask(10000, "after_send_error");
      } else if (dryRun) {
        scheduleProcessNextTask(5000, "after_dry_run");
      } else if (wsModule.hasPendingWsTasks() || !wsModule.isSendWsConnected()) {
        const delay = Math.max(1000, state.nextDMTime - Date.now());
        scheduleProcessNextTask(delay, "after_send_delay");
      }
    }

    return {
      classifyFailure,
      recordFailureMetric,
      buildTaskOutcome,
      handleThreadIdentityFailure,
      finalizeTaskRun,
    };
  }

  globalScope.createBackgroundJobsOutcomesModule = createBackgroundJobsOutcomesModule;
})(self);
