import test from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { loadBackgroundModule } from "./helpers/load-background-module.mjs";

const root = resolve(process.cwd());
const modulePath = resolve(root, "src/platform/background/modules/jobs-reporting.js");

function createResponse({
  ok = true,
  status = 200,
  jsonData = {},
  textData = "",
  retryAfter = null,
}) {
  return {
    ok,
    status,
    headers: {
      get(name) {
        if (String(name).toLowerCase() === "retry-after") return retryAfter;
        return null;
      },
    },
    async json() {
      return jsonData;
    },
    async text() {
      return textData;
    },
  };
}

function createDeps(overrides = {}) {
  const saved = [];
  const enqueued = [];
  const progress = [];
  const fetchCalls = [];
  const fetchImpl = overrides.fetchImpl || (async () => createResponse({}));
  const authModule = {
    loadSettings: async () => ({ api_base: "https://api.example.com", refresh_token: "rt" }),
    isSecureApiBase: () => true,
    getAuthHeaders: async () => ({
      Authorization: "Bearer token",
      "Content-Type": "application/json",
    }),
    refreshJwtSingleFlight: async () => true,
    ...overrides.authModule,
  };
  const storageModule = {
    saveState: async (patch) => {
      saved.push(patch);
    },
    getPendingReports: async () => [],
    enqueuePendingReport: async (report) => {
      enqueued.push(report);
    },
    ...overrides.storageModule,
  };
  return {
    saved,
    enqueued,
    progress,
    fetchCalls,
    deps: {
      state: { isRunning: true },
      storageModule,
      authModule,
      pendingReportsMax: 5,
      heartbeatMinGapMs: 20000,
      heartbeatInstanceId: "inst-1",
      authErrorBackoffMs: 60000,
      networkFetchTimeoutMs: 500,
      maskIdentity: (value) => `masked:${value}`,
      normalizeAccount: (value) =>
        String(value || "")
          .trim()
          .toLowerCase(),
      getPinnedSenderAccount: () => overrides.pinnedAccount || "",
      pinSenderAccountForRun: (value) =>
        String(value || "")
          .trim()
          .toLowerCase(),
      getFallbackHeartbeatAccount: () => overrides.fallbackAccount || "fallback_user",
      getLoggedInUsername: async () => overrides.loggedInUsername || "logged_user",
      updateProgress: (stage) => progress.push(stage),
    },
    overrides: {
      fetch: async (url, options) => {
        fetchCalls.push({ url, options });
        return fetchImpl(url, options);
      },
      AbortController,
      URL,
    },
  };
}

test("jobs-reporting pullTask returns task and updates progress", async () => {
  const ctx = createDeps({
    fetchImpl: async () =>
      createResponse({
        jsonData: { data: { items: [{ task_id: "t1", job_id: "j1" }] } },
      }),
  });
  const mod = await loadBackgroundModule(modulePath, ctx.overrides);
  const reporting = mod.createBackgroundJobsReportingModule(ctx.deps);

  const result = await reporting.pullTask();

  assert.equal(result.status, "task");
  assert.equal(result.task.task_id, "t1");
  assert.deepEqual(ctx.progress, ["pull_ok"]);
  assert.equal(ctx.fetchCalls.length, 1);
});

test("jobs-reporting sendReportRequest discards stale lease conflicts", async () => {
  const ctx = createDeps({
    fetchImpl: async () =>
      createResponse({
        ok: false,
        status: 403,
        textData: JSON.stringify({ error: { code: "LEASE_NOT_ACTIVE" } }),
      }),
  });
  const mod = await loadBackgroundModule(modulePath, ctx.overrides);
  const reporting = mod.createBackgroundJobsReportingModule(ctx.deps);

  const ok = await reporting.sendReportRequest({
    job_id: "j1",
    task_id: "t1",
    lease_proof: "lease",
    ok: false,
  });

  assert.equal(ok, true);
});

test("jobs-reporting reportResult enqueues and clears current task after flush", async () => {
  const ctx = createDeps({
    storageModule: {
      getPendingReports: async () => [
        { job_id: "j1", task_id: "t1", lease_proof: "lease", ok: true, dry_run: false },
      ],
    },
    fetchImpl: async () => createResponse({ ok: true, status: 200 }),
  });
  const mod = await loadBackgroundModule(modulePath, ctx.overrides);
  const reporting = mod.createBackgroundJobsReportingModule(ctx.deps);

  await reporting.reportResult("j1", "t1", "lease", true, "alice", null, false);

  assert.equal(ctx.enqueued.length, 1);
  assert.equal(ctx.progress.includes("result_reported"), true);
  assert.equal(ctx.progress.includes("flush_ok"), true);
  assert.equal(
    ctx.saved.some((patch) => patch.dm_current_task === null),
    true
  );
});

test("jobs-reporting sendSenderHeartbeat falls back to detected account and succeeds", async () => {
  const ctx = createDeps({
    fetchImpl: async () => createResponse({ ok: true, status: 200 }),
    pinnedAccount: "",
    loggedInUsername: "IGUser",
  });
  const mod = await loadBackgroundModule(modulePath, ctx.overrides);
  const reporting = mod.createBackgroundJobsReportingModule(ctx.deps);

  const ok = await reporting.sendSenderHeartbeat(true);

  assert.equal(ok, true);
  assert.equal(ctx.fetchCalls.length, 1);
  assert.equal(JSON.parse(ctx.fetchCalls[0].options.body).from_account, "iguser");
});
