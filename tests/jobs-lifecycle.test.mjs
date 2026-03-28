import test from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { loadBackgroundModule } from "./helpers/load-background-module.mjs";

const root = resolve(process.cwd());
const modulePath = resolve(root, "src/platform/background/modules/jobs-lifecycle.js");

test("jobs-lifecycle blocks start during cooldown", async () => {
  const chrome = { alarms: { create() {}, clear() {} } };
  const mod = await loadBackgroundModule(modulePath, { chrome });
  const state = { isRunning: false, pollAlarmName: "poll" };
  const lifecycle = mod.createBackgroundJobsLifecycleModule({
    state,
    config: { pollIntervalMs: 30000 },
    storageModule: { saveState: async () => {} },
    authModule: { loadSettings: async () => ({}) },
    wsModule: { resetSendWsFailures() {}, connectSendWs: async () => {}, disconnectSendWs() {} },
    reportingModule: {
      pullTask: async () => ({ status: "empty" }),
      sendSenderHeartbeat: async () => true,
      flushPendingReports: async () => true,
      resetRuntimeState() {},
    },
    watchdogModule: { resetRecoveryState() {}, updateProgress() {} },
    normalizeAccount: (v) => String(v || "").trim().toLowerCase(),
    getPinnedSenderAccount: () => "",
    pinSenderAccountForRun: () => "",
    clearPendingProcessNextTimer() {},
    clearPendingProcessTriggerTimer() {},
    notifyPopupStatusUpdate() {},
    getActiveProcessToken: () => null,
    getStartSenderInFlight: () => false,
    setStartSenderInFlight() {},
    getSenderRunVersion: () => 0,
    setSenderRunVersion() {},
    getNoTasksRestartCooldownUntil: () => Date.now() + 5000,
    setNoTasksRestartCooldownUntil() {},
    resetRuntimeCounters() {},
    getCurrentKnownAccount: () => "foo",
    processNextTask: async () => {},
  });

  const result = await lifecycle.startSender();
  assert.equal(result.status, "no_tasks_cooldown");
  assert.equal(result.from_account, "foo");
});

test("jobs-lifecycle stopSender clears running state and returns stopped", async () => {
  let alarmCleared = false;
  const chrome = {
    alarms: {
      create() {},
      clear() {
        alarmCleared = true;
      },
    },
  };
  const mod = await loadBackgroundModule(modulePath, { chrome });
  const state = {
    isRunning: true,
    isProcessing: false,
    currentTask: null,
    dmsSentThisSession: 3,
    nextDMTime: 123,
    pollAlarmName: "poll",
  };
  const saved = [];
  const lifecycle = mod.createBackgroundJobsLifecycleModule({
    state,
    config: { pollIntervalMs: 30000 },
    storageModule: { saveState: async (patch) => saved.push(patch) },
    authModule: { loadSettings: async () => ({}) },
    wsModule: { resetSendWsFailures() {}, connectSendWs: async () => {}, disconnectSendWs() {} },
    reportingModule: {
      pullTask: async () => ({ status: "empty" }),
      sendSenderHeartbeat: async () => true,
      flushPendingReports: async () => true,
      resetRuntimeState() {},
    },
    watchdogModule: { resetRecoveryState() {}, updateProgress() {} },
    normalizeAccount: (v) => String(v || "").trim().toLowerCase(),
    getPinnedSenderAccount: () => "",
    pinSenderAccountForRun: () => "",
    clearPendingProcessNextTimer() {},
    clearPendingProcessTriggerTimer() {},
    notifyPopupStatusUpdate() {},
    getActiveProcessToken: () => null,
    getStartSenderInFlight: () => false,
    setStartSenderInFlight() {},
    getSenderRunVersion: () => 0,
    setSenderRunVersion() {},
    getNoTasksRestartCooldownUntil: () => 0,
    setNoTasksRestartCooldownUntil() {},
    resetRuntimeCounters() {},
    getCurrentKnownAccount: () => "foo",
    processNextTask: async () => {},
  });

  const result = await lifecycle.stopSender("manual");
  assert.equal(result.status, "stopped");
  assert.equal(state.isRunning, false);
  assert.equal(alarmCleared, true);
  assert.equal(saved.length > 0, true);
});
