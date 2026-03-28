import test from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { loadBackgroundModule } from "./helpers/load-background-module.mjs";

const root = resolve(process.cwd());
const modulePath = resolve(root, "src/platform/background/modules/jobs-run-state.js");

function normalizeAccount(value) {
  return String(value || "")
    .trim()
    .toLowerCase();
}

function maskIdentity(value) {
  return `masked:${value}`;
}

test("jobs-run-state pins and restores account state", async () => {
  const mod = await loadBackgroundModule(modulePath);
  const saved = [];
  const state = { isRunning: true, currentTask: { id: 1 } };
  const runState = mod.createBackgroundJobsRunStateModule({
    state,
    storageModule: {
      saveState: async (patch) => {
        saved.push(patch);
      },
    },
    normalizeAccount,
    maskIdentity,
  });

  assert.equal(runState.pinSenderAccountForRun("  FooBar "), "foobar");
  assert.equal(runState.getPinnedSenderAccount(), "foobar");
  assert.equal(runState.getCurrentKnownAccount(), "foobar");
  assert.equal(saved.length, 1);
  assert.equal(saved[0].dm_sender_last_account, "foobar");

  runState.restoreKnownAccount("Baz", 123);
  assert.equal(runState.getCurrentKnownAccount(), "baz");
});

test("jobs-run-state tracks counters and cooldowns", async () => {
  const mod = await loadBackgroundModule(modulePath);
  const runState = mod.createBackgroundJobsRunStateModule({
    state: { isRunning: false, currentTask: {} },
    storageModule: { saveState: async () => {} },
    normalizeAccount,
    maskIdentity,
    accountFallbackLivenessGraceMs: 999999,
  });

  assert.equal(runState.incrementEmptyPullStreak(), 1);
  assert.equal(runState.incrementEmptyPullStreak(), 2);
  runState.resetEmptyPullStreak();
  assert.equal(runState.getEmptyPullStreak(), 0);

  assert.equal(runState.incrementThreadIdentityFails(), 1);
  runState.resetThreadIdentityFails();
  assert.equal(runState.getConsecutiveThreadIdentityFails(), 0);

  runState.incrementFailureMetric("transient");
  runState.incrementFailureMetric("definitive");
  const metrics = runState.buildFailureMetrics();
  assert.equal(metrics.transient, 1);
  assert.equal(metrics.definitive, 1);

  runState.setNoTasksRestartCooldownUntil(4321);
  assert.equal(runState.getNoTasksRestartCooldownUntil(), 4321);
});
