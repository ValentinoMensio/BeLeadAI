import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(process.cwd());

test("manifest and package versions are aligned", async () => {
  const [manifestRaw, pkgRaw] = await Promise.all([
    readFile(resolve(root, "manifest.json"), "utf8"),
    readFile(resolve(root, "package.json"), "utf8"),
  ]);
  const manifest = JSON.parse(manifestRaw);
  const pkg = JSON.parse(pkgRaw);
  assert.equal(String(manifest.version || ""), String(pkg.version || ""));
});

test("release scripts are defined", async () => {
  const pkgRaw = await readFile(resolve(root, "package.json"), "utf8");
  const pkg = JSON.parse(pkgRaw);
  assert.ok(pkg.scripts["build:release"]);
  assert.ok(pkg.scripts["pack:release"]);
});
