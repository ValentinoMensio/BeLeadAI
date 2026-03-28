(function initBackgroundJobsRunStateModule(globalScope) {
  function createBackgroundJobsRunStateModule({
    state,
    storageModule,
    normalizeAccount,
    maskIdentity,
    accountFallbackLivenessGraceMs = 120000,
  }) {
    let noTasksRestartCooldownUntil = 0;
    let emptyPullStreak = 0;
    let consecutiveThreadIdentityFails = 0;
    let activeRunFromAccount = "";
    let lastKnownFromAccount = "";
    let lastKnownFromAccountTs = 0;
    let transientFailureCount = 0;
    let definitiveFailureCount = 0;

    function getPinnedSenderAccount() {
      if (!state.isRunning) return "";
      const active = normalizeAccount(activeRunFromAccount);
      if (active) return active;
      const known = normalizeAccount(lastKnownFromAccount);
      if (known) {
        activeRunFromAccount = known;
      }
      return known;
    }

    function rememberKnownAccount(account) {
      const normalized = normalizeAccount(account);
      if (!normalized) return;
      lastKnownFromAccount = normalized;
      lastKnownFromAccountTs = Date.now();
      storageModule
        .saveState({
          dm_sender_last_account: lastKnownFromAccount,
          dm_sender_last_account_ts: lastKnownFromAccountTs,
        })
        .catch((e) => {
          console.warn("[BG] Failed to persist last known account:", e?.message || e);
        });
    }

    function pinSenderAccountForRun(account) {
      const normalized = normalizeAccount(account);
      if (!normalized) return "";
      if (state.isRunning) {
        const pinned = getPinnedSenderAccount();
        if (pinned && pinned !== normalized) {
          console.warn(
            "[BG] Ignorando cambio de cuenta durante corrida activa:",
            maskIdentity(pinned),
            "<-",
            maskIdentity(normalized)
          );
          return pinned;
        }
        activeRunFromAccount = normalized;
      }
      rememberKnownAccount(normalized);
      return normalized;
    }

    function getFallbackHeartbeatAccount() {
      if (!state.currentTask) return "";
      const ageMs = Date.now() - Number(lastKnownFromAccountTs || 0);
      if (ageMs < 0 || ageMs > accountFallbackLivenessGraceMs) return "";
      return normalizeAccount(lastKnownFromAccount);
    }

    function incrementEmptyPullStreak() {
      emptyPullStreak += 1;
      return emptyPullStreak;
    }

    function resetEmptyPullStreak() {
      emptyPullStreak = 0;
    }

    function incrementThreadIdentityFails() {
      consecutiveThreadIdentityFails += 1;
      return consecutiveThreadIdentityFails;
    }

    function resetThreadIdentityFails() {
      consecutiveThreadIdentityFails = 0;
    }

    function incrementFailureMetric(kind) {
      if (kind === "definitive") {
        definitiveFailureCount += 1;
      } else {
        transientFailureCount += 1;
      }
    }

    function resetFailureMetrics() {
      transientFailureCount = 0;
      definitiveFailureCount = 0;
    }

    function buildFailureMetrics() {
      return {
        transient: transientFailureCount,
        definitive: definitiveFailureCount,
      };
    }

    function getFailureMetricCounts() {
      return {
        transient: transientFailureCount,
        definitive: definitiveFailureCount,
      };
    }

    function getNoTasksRestartCooldownUntil() {
      return noTasksRestartCooldownUntil;
    }

    function setNoTasksRestartCooldownUntil(value) {
      noTasksRestartCooldownUntil = Number(value || 0);
    }

    function getEmptyPullStreak() {
      return emptyPullStreak;
    }

    function getConsecutiveThreadIdentityFails() {
      return consecutiveThreadIdentityFails;
    }

    function getCurrentKnownAccount() {
      return lastKnownFromAccount;
    }

    function getCurrentActiveAccount() {
      return activeRunFromAccount;
    }

    function clearRuntimeState() {
      activeRunFromAccount = "";
      emptyPullStreak = 0;
      consecutiveThreadIdentityFails = 0;
      transientFailureCount = 0;
      definitiveFailureCount = 0;
    }

    function restoreKnownAccount(account, accountTs = 0) {
      const normalized = normalizeAccount(account);
      if (!normalized) {
        lastKnownFromAccount = "";
        lastKnownFromAccountTs = 0;
        return;
      }
      lastKnownFromAccount = normalized;
      lastKnownFromAccountTs = Number(accountTs || 0) || Date.now();
    }

    return {
      getPinnedSenderAccount,
      rememberKnownAccount,
      pinSenderAccountForRun,
      getFallbackHeartbeatAccount,
      incrementEmptyPullStreak,
      resetEmptyPullStreak,
      incrementThreadIdentityFails,
      resetThreadIdentityFails,
      incrementFailureMetric,
      resetFailureMetrics,
      buildFailureMetrics,
      getFailureMetricCounts,
      getNoTasksRestartCooldownUntil,
      setNoTasksRestartCooldownUntil,
      getEmptyPullStreak,
      getConsecutiveThreadIdentityFails,
      getCurrentKnownAccount,
      getCurrentActiveAccount,
      clearRuntimeState,
      restoreKnownAccount,
    };
  }

  globalScope.createBackgroundJobsRunStateModule = createBackgroundJobsRunStateModule;
})(self);
