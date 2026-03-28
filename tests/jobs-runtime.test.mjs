import test from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { loadBackgroundModule } from "./helpers/load-background-module.mjs";

const root = resolve(process.cwd());
const modulePath = resolve(root, "src/platform/background/modules/jobs-runtime.js");

function createChromeMock() {
  const listeners = [];
  const tabs = [
    { id: 1, active: true, url: "https://www.instagram.com/direct/inbox/" },
  ];
  return {
    listeners,
    chrome: {
      tabs: {
        async query() {
          return tabs;
        },
        async sendMessage(tabId, payload) {
          if (payload.action === "get_current_username") {
            return { username: "Alice" };
          }
          if (payload.action === "content_ready") {
            return { ready: true, build: "test" };
          }
          if (payload.action === "send_dm") {
            return { success: true };
          }
          return null;
        },
        async create(createInfo) {
          const tab = { id: 2, url: createInfo.url, active: false };
          tabs.push(tab);
          setTimeout(() => {
            for (const listener of listeners) listener(tab.id, { status: "complete" });
          }, 0);
          return tab;
        },
        async get(tabId) {
          return tabs.find((tab) => tab.id === tabId);
        },
        async update(tabId, updateInfo) {
          const tab = tabs.find((item) => item.id === tabId);
          tab.url = updateInfo.url;
          setTimeout(() => {
            for (const listener of listeners) listener(tab.id, { status: "complete" });
          }, 0);
          return tab;
        },
        async reload(tabId) {
          setTimeout(() => {
            for (const listener of listeners) listener(tabId, { status: "complete" });
          }, 0);
        },
        onUpdated: {
          addListener(listener) {
            listeners.push(listener);
          },
          removeListener(listener) {
            const index = listeners.indexOf(listener);
            if (index >= 0) listeners.splice(index, 1);
          },
        },
      },
      cookies: {
        async get() {
          return { value: "cookie-user-id" };
        },
      },
    },
  };
}

test("jobs-runtime getLoggedInUsername prefers content-script username", async () => {
  const { chrome } = createChromeMock();
  const mod = await loadBackgroundModule(modulePath, { chrome });
  const runtime = mod.createBackgroundJobsRuntimeModule({
    maskIdentity: (value) => value,
    updateProgress() {},
  });

  const username = await runtime.getLoggedInUsername();

  assert.equal(username, "alice");
});

test("jobs-runtime findOrCreateInstagramTab returns existing direct tab", async () => {
  const { chrome } = createChromeMock();
  const mod = await loadBackgroundModule(modulePath, { chrome });
  const runtime = mod.createBackgroundJobsRuntimeModule({
    maskIdentity: (value) => value,
    updateProgress() {},
  });

  const tab = await runtime.findOrCreateInstagramTab();

  assert.equal(tab.id, 1);
});

test("jobs-runtime ensureContentScriptReady succeeds on ready handshake", async () => {
  const { chrome } = createChromeMock();
  const mod = await loadBackgroundModule(modulePath, { chrome });
  const runtime = mod.createBackgroundJobsRuntimeModule({
    maskIdentity: (value) => value,
    updateProgress() {},
  });

  const ok = await runtime.ensureContentScriptReady(1, 1);

  assert.equal(ok, true);
});

test("jobs-runtime sendDMViaContentScript acknowledges successful send", async () => {
  const progress = [];
  const { chrome } = createChromeMock();
  const mod = await loadBackgroundModule(modulePath, { chrome });
  const runtime = mod.createBackgroundJobsRuntimeModule({
    maskIdentity: (value) => value,
    updateProgress: (stage) => progress.push(stage),
  });

  const result = await runtime.sendDMViaContentScript("alice", "hola", true);

  assert.equal(result.success, true);
  assert.deepEqual(progress, ["content_ack"]);
});
