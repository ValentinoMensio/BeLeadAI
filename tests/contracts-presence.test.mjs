import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(process.cwd());
const contractsDir = resolve(root, "contracts/v1");

test("published contracts directory is populated", async () => {
  const entries = await readdir(contractsDir, { withFileTypes: true });
  assert.ok(entries.length > 0);
});

test("published contract schemas are valid JSON", async () => {
  const files = [
    "auth-login.response.schema.json",
    "config.response.schema.json",
    "jobs-ws-jobs-updated.event.schema.json",
    "jobs-ws-ping.event.schema.json",
    "limits.response.schema.json",
    "recipient-sources.response.schema.json",
    "recipient-source-recipients.response.schema.json",
    "followings-enqueue.request.schema.json",
    "analyze-enqueue.request.schema.json",
    "send-enqueue.request.schema.json",
    "send-ws-tasks.event.schema.json",
    "send-pull.request.schema.json",
    "send-pull.response.schema.json",
    "send-result.request.schema.json",
    "send-heartbeat.request.schema.json"
  ];

  await Promise.all(
    files.map(async (file) => {
      const raw = await readFile(resolve(contractsDir, file), "utf8");
      const parsed = JSON.parse(raw);
      assert.equal(typeof parsed, "object");
      assert.ok(parsed.$schema);
      assert.ok(parsed.$id);
    })
  );
});

test("published contract examples reference existing schemas", async () => {
  const examplesDir = resolve(root, "contracts/v1/examples");
  const entries = await readdir(examplesDir, { withFileTypes: true });
  assert.ok(entries.length > 0);
  await Promise.all(
    entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map(async (entry) => {
        const examplePath = resolve(examplesDir, entry.name);
        const raw = await readFile(examplePath, "utf8");
        const parsed = JSON.parse(raw);
        assert.ok(parsed.schema);
        assert.ok(parsed.payload);
        const schemaPath = resolve(examplesDir, parsed.schema);
        const schemaRaw = await readFile(schemaPath, "utf8");
        const schema = JSON.parse(schemaRaw);
        assert.ok(schema.$id);
      })
  );
});
