import test from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { loadBackgroundModule } from "./helpers/load-background-module.mjs";

const root = resolve(process.cwd());
const modulePath = resolve(root, "src/platform/content/modules/account-identity.js");

test("account identity prefers current_user API username", async () => {
  const fetchCalls = [];
  const mod = await loadBackgroundModule(modulePath, {
    document: {
      cookie: "csrftoken=test-csrf; ds_user_id=12345",
      querySelector() {
        return null;
      },
    },
    window: {
      location: { origin: "https://www.instagram.com" },
    },
    fetch: async (path, options) => {
      fetchCalls.push({ path, options });
      return {
        ok: true,
        async json() {
          return { user: { username: "Test.User", id: "42" } };
        },
      };
    },
    URL,
  });

  const accountIdentity = mod.createContentAccountIdentityModule({
    observersModule: { isLikelyIgUsername: (value) => /^[a-z0-9._]{1,30}$/.test(value) },
  });

  const result = await accountIdentity.getCurrentInstagramUsername();

  assert.equal(result.username, "test.user");
  assert.equal(result.user_id, "42");
  assert.equal(result.source, "api_current_user");
  assert.equal(fetchCalls[0].options.headers["x-csrftoken"], "test-csrf");
});

test("account identity falls back to DOM metadata and cookie id", async () => {
  const metaTag = { content: "@Fallback.User • Instagram" };
  const mod = await loadBackgroundModule(modulePath, {
    document: {
      cookie: "ds_user_id=9999",
      querySelector(selector) {
        if (selector === 'meta[property="og:title"]') return metaTag;
        if (selector === 'link[rel="canonical"]') return null;
        return null;
      },
    },
    window: {
      location: { origin: "https://www.instagram.com" },
    },
    fetch: async () => ({ ok: false }),
    URL,
  });

  const accountIdentity = mod.createContentAccountIdentityModule({
    observersModule: { isLikelyIgUsername: (value) => /^[a-z0-9._]{1,30}$/.test(value) },
  });

  const result = await accountIdentity.getCurrentInstagramUsername();

  assert.equal(result.username, "fallback.user");
  assert.equal(result.user_id, null);
  assert.equal(result.source, "dom");
});
