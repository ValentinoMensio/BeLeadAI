import test from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { loadBackgroundModule } from "./helpers/load-background-module.mjs";

const root = resolve(process.cwd());
const modulePath = resolve(root, "src/platform/background/modules/jobs-outcomes.js");

function createDeps() {
  const savedStates = [];
  const reported = [];
  const notifications = [];
  const scheduled = [];
  const state = {
    currentTask: { task_id: "t1" },
    dmsSentThisSession: 0,
    lastDMTime: 0,
    nextDMTime: 0,
    isRunning: true,
  };
  const runStateModule = {
    counts: { transient: 0, definitive: 0 },
    threadFails: 0,
    incrementFailureMetric(kind) {
      this.counts[kind] += 1;
    },
    getFailureMetricCounts() {
      return { ...this.counts };
    },
    incrementThreadIdentityFails() {
      this.threadFails += 1;
      return this.threadFails;
    },
    resetThreadIdentityFails() {
      this.threadFails = 0;
    },
  };
  return {
    state,
    savedStates,
    reported,
    notifications,
    scheduled,
    runStateModule,
    deps: {
      state,
      storageModule: {
        rememberProcessedTaskResult: async (...args) => {
          savedStates.push({ type: "processed", args });
        },
        saveState: async (patch) => {
          savedStates.push({ type: "state", patch });
        },
      },
      reportingModule: {
        reportResult: async (...args) => {
          reported.push(args);
        },
      },
      runStateModule,
      wsModule: {
        hasPendingWsTasks: () => false,
        isSendWsConnected: () => false,
      },
      maskIdentity: (value) => `masked:${value}`,
      scheduleProcessNextTask: (delay, reason) => {
        scheduled.push({ delay, reason });
      },
      notifyPopupStatusUpdate: (data, context) => {
        notifications.push({ data, context });
      },
      stopSender: async (reason) => {
        notifications.push({ stopped: reason });
      },
      randomBetween: () => 2000,
      minDelayBetweenDMs: 1000,
      maxDelayBetweenDMs: 5000,
    },
  };
}

test("jobs-outcomes persists failure metrics and report outcome", async () => {
  const mod = await loadBackgroundModule(modulePath);
  const ctx = createDeps();
  const outcomes = mod.createBackgroundJobsOutcomesModule(ctx.deps);

  const outcome = await outcomes.buildTaskOutcome(
    { job_id: "j1", task_id: "t1" },
    { leaseProof: "lease", username: "alice", dryRun: false },
    { success: false, error: "timeout_error" }
  );

  assert.equal(outcome.errorCode, "timeout_error");
  assert.equal(outcome.failureClass, "transient");
  assert.equal(ctx.runStateModule.counts.transient, 1);
  assert.equal(ctx.reported.length, 1);
  assert.equal(
    ctx.savedStates.some((entry) => entry.type === "processed"),
    true
  );
});

test("jobs-outcomes handles thread identity failure with retry scheduling", async () => {
  const mod = await loadBackgroundModule(modulePath);
  const ctx = createDeps();
  const outcomes = mod.createBackgroundJobsOutcomesModule(ctx.deps);

  await outcomes.handleThreadIdentityFailure("alice", "definitive");

  assert.equal(ctx.state.currentTask, null);
  assert.equal(ctx.scheduled.length, 1);
  assert.equal(ctx.scheduled[0].reason, "thread_identity_skip");
  assert.equal(ctx.notifications[0].context, "thread_identity_soft");
});

test("jobs-outcomes finalizes successful task run and schedules next run", async () => {
  const mod = await loadBackgroundModule(modulePath);
  const ctx = createDeps();
  const outcomes = mod.createBackgroundJobsOutcomesModule(ctx.deps);

  await outcomes.finalizeTaskRun("alice", true, { success: true }, null);

  assert.equal(ctx.state.dmsSentThisSession, 1);
  assert.equal(ctx.state.currentTask, null);
  assert.equal(ctx.scheduled[0].reason, "after_dry_run");
  assert.equal(ctx.notifications[0].context, "dm_status_update");
});
