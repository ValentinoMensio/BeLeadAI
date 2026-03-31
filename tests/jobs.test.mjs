import test from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { loadBackgroundModule } from "./helpers/load-background-module.mjs";

const root = resolve(process.cwd());
const modulePath = resolve(root, "src/platform/background/modules/jobs.js");

function createJobsHarness(overrides = {}) {
  const scheduledTimers = [];
  const popupMessages = [];
  const stopReasons = [];
  const savedStates = [];
  const finalizeCalls = [];
  const buildOutcomeCalls = [];
  const sendDmCalls = [];
  const pullCalls = [];

  const state = {
    isRunning: true,
    isProcessing: false,
    currentTask: null,
    dmsSentThisSession: 0,
    nextDMTime: 0,
    lastDMTime: 0,
    pollAlarmName: "poll",
    ...overrides.state,
  };

  const runState = {
    emptyPullStreak: 0,
    threadIdentityFails: 0,
    failureMetrics: { transient: 0, definitive: 0 },
    buildFailureMetrics() {
      return { ...this.failureMetrics };
    },
    getEmptyPullStreak() {
      return this.emptyPullStreak;
    },
    getConsecutiveThreadIdentityFails() {
      return this.threadIdentityFails;
    },
    incrementEmptyPullStreak() {
      this.emptyPullStreak += 1;
      return this.emptyPullStreak;
    },
    resetEmptyPullStreak() {
      this.emptyPullStreak = 0;
    },
    incrementThreadIdentityFails() {
      this.threadIdentityFails += 1;
      return this.threadIdentityFails;
    },
    resetThreadIdentityFails() {
      this.threadIdentityFails = 0;
    },
    incrementFailureMetric(kind) {
      this.failureMetrics[kind] += 1;
    },
    getFailureMetricCounts() {
      return { ...this.failureMetrics };
    },
    getPinnedSenderAccount() {
      return "sender_account";
    },
    pinSenderAccountForRun(value) {
      return value;
    },
    getFallbackHeartbeatAccount() {
      return "fallback_account";
    },
    getNoTasksRestartCooldownUntil() {
      return 0;
    },
    setNoTasksRestartCooldownUntil() {},
    clearRuntimeState() {
      this.emptyPullStreak = 0;
      this.threadIdentityFails = 0;
      this.failureMetrics = { transient: 0, definitive: 0 };
    },
    getCurrentKnownAccount() {
      return "sender_account";
    },
    getCurrentActiveAccount() {
      return "sender_account";
    },
    restoreKnownAccount() {},
  };

  const watchdog = {
    progressStage: "idle",
    updateProgress(stage) {
      this.progressStage = stage;
    },
    markProgressStage(stage) {
      this.progressStage = stage;
    },
    getProgressStage() {
      return this.progressStage;
    },
    resetRecoveryState() {},
    getLastProgressTs() {
      return 0;
    },
    getWatchdogRecoveryAttempts() {
      return 0;
    },
    getWatchdogState() {
      return { progressStage: this.progressStage };
    },
    runWatchdog: async () => {},
    restoreProgressState() {},
  };

  const reporting = {
    pullTask: async () => {
      pullCalls.push(true);
      return overrides.pullTaskResult || { status: "empty" };
    },
    sendSenderHeartbeat: async () => true,
    flushPendingReports: async () => true,
    reportResult: async () => {},
    sendReportRequest: async () => true,
    sendAutonomousHeartbeat: async () => true,
    resetRuntimeState() {},
  };

  const runtime = {
    getLoggedInUsername: async () => "sender_account",
    ensureInstagramDirectReady: async () => ({ ok: true, tabId: 1 }),
    findOrCreateInstagramTab: async () => ({ id: 1 }),
    waitTabLoadComplete: async () => true,
    ensureContentScriptReady: async () => true,
    sendDMViaContentScript: async () => ({ success: true }),
    sendDMViaContentScriptWithTimeout: async (...args) => {
      sendDmCalls.push(args);
      return overrides.sendDmResult || { success: true, steps: ["sent:composer_cleared"] };
    },
  };

  const outcomes = {
    buildTaskOutcome: async (...args) => {
      buildOutcomeCalls.push(args);
      return overrides.outcomeResult || { errorCode: "", failureClass: null };
    },
    handleThreadIdentityFailure: async () => {},
    finalizeTaskRun: async (...args) => {
      finalizeCalls.push(args);
    },
  };

  const lifecycle = {
    startSender: async () => ({ status: "started" }),
    stopSender: async (reason) => {
      stopReasons.push(reason);
      state.isRunning = false;
      return { status: "stopped", reason };
    },
  };

  const wsModule = {
    isSendWsConnected: () => false,
    hasPendingWsTasks: () => false,
    shiftPendingWsTask: () => null,
    requestSendWsPull: () => false,
    waitForWsTask: async () => null,
    resetSendWsFailures() {},
    disconnectSendWs() {},
    connectSendWs: async () => {},
    ...overrides.wsModule,
  };

  return {
    state,
    scheduledTimers,
    popupMessages,
    stopReasons,
    savedStates,
    finalizeCalls,
    buildOutcomeCalls,
    sendDmCalls,
    pullCalls,
    overrides: {
      setTimeout(fn, delay) {
        scheduledTimers.push({ fn, delay });
        return scheduledTimers.length;
      },
      clearTimeout() {},
      chrome: {
        runtime: {
          id: "ext-id",
          sendMessage: async (payload) => {
            popupMessages.push(payload);
            if (payload?.action === "get_sender_status") {
              return overrides.senderStatus || { isRunning: false };
            }
            return null;
          },
        },
        alarms: {
          create() {},
          clear() {},
        },
      },
      self: {
        createBackgroundJobsRunStateModule: () => runState,
        createBackgroundJobsWatchdogModule: () => watchdog,
        createBackgroundJobsRuntimeModule: () => runtime,
        createBackgroundJobsReportingModule: () => reporting,
        createBackgroundJobsOutcomesModule: () => outcomes,
        createBackgroundJobsLifecycleModule: () => lifecycle,
      },
    },
    deps: {
      state,
      config: {
        minDelayBetweenDMs: 1000,
        maxDelayBetweenDMs: 2000,
        maxDMsPerSession: 5,
        pollIntervalMs: 30000,
      },
      storageModule: {
        loadState: async () => {},
        saveState: async (patch) => {
          savedStates.push(patch);
        },
        getProcessedTaskResult: async () => null,
      },
      authModule: {},
      wsModule,
      processTriggerMinGapMs: 200,
      heartbeatMinGapMs: 20000,
      heartbeatInstanceId: "inst-1",
      wsPullGraceMs: 100,
      pendingReportsMax: 5,
    },
  };
}

test("jobs stops sender when session limit is reached", async () => {
  const harness = createJobsHarness({ state: { dmsSentThisSession: 5 } });
  const mod = await loadBackgroundModule(modulePath, harness.overrides);
  const jobs = mod.createBackgroundJobsModule(harness.deps);

  await jobs.processNextTask();

  assert.deepEqual(harness.stopReasons, ["session_limit"]);
  assert.equal(harness.pullCalls.length, 0);
  assert.equal(harness.state.isProcessing, false);
});

test("jobs schedules retry and popup update when no task is available", async () => {
  const harness = createJobsHarness({ pullTaskResult: { status: "empty" } });
  const mod = await loadBackgroundModule(modulePath, harness.overrides);
  const jobs = mod.createBackgroundJobsModule(harness.deps);

  await jobs.processNextTask();

  assert.equal(harness.pullCalls.length, 1);
  assert.equal(harness.scheduledTimers.length, 1);
  assert.equal(harness.scheduledTimers[0].delay, 1500);
  assert.equal(
    harness.popupMessages.some((msg) => msg?.type === "dm_status_update"),
    true
  );
  assert.equal(harness.stopReasons.length, 0);
});

test("jobs claims task, sends DM and finalizes successful outcome", async () => {
  const task = {
    job_id: "job-1",
    task_id: "task-1",
    lease_proof: "lease-1",
    dest_username: "alice.demo",
    payload: {
      target_username: "alice.demo",
      message_template: "Hola",
      dry_run: true,
    },
  };
  const harness = createJobsHarness({ pullTaskResult: { status: "task", task } });
  const mod = await loadBackgroundModule(modulePath, harness.overrides);
  const jobs = mod.createBackgroundJobsModule(harness.deps);

  await jobs.processNextTask();

  assert.equal(harness.pullCalls.length, 1);
  assert.equal(harness.sendDmCalls.length, 1);
  assert.equal(harness.buildOutcomeCalls.length, 1);
  assert.equal(harness.finalizeCalls.length, 1);
  assert.equal(
    harness.savedStates.some((patch) => patch.dm_current_task?.task_id === "task-1"),
    true
  );
  assert.equal(harness.state.isProcessing, false);
});
