import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(process.cwd());
const dist = resolve(root, "dist");
const manifestPath = resolve(root, "manifest.json");

async function readVersion() {
  const raw = await readFile(manifestPath, "utf8");
  const manifest = JSON.parse(raw);
  const version = String(manifest.version || "").trim();
  if (!version) {
    throw new Error("manifest.json does not define version");
  }
  return version;
}

function zipDistTo(zipFilePath) {
  execFileSync("zip", ["-r", zipFilePath, "."], {
    cwd: dist,
    stdio: "inherit",
  });
}

async function writeSha256(zipPath, shaPath, fileName) {
  const zipBuffer = await readFile(zipPath);
  const digest = createHash("sha256").update(zipBuffer).digest("hex");
  const line = `${digest}  ${fileName}\n`;
  await writeFile(shaPath, line, "utf8");
  return digest;
}

async function pack() {
  const version = await readVersion();
  const zipFileName = `extension-v${version}.zip`;
  const shaFileName = `extension-v${version}.sha256`;
  const zipFilePath = resolve(root, zipFileName);
  const shaFilePath = resolve(root, shaFileName);

  await rm(zipFilePath, { force: true });
  await rm(shaFilePath, { force: true });

  zipDistTo(zipFilePath);
  const digest = await writeSha256(zipFilePath, shaFilePath, zipFileName);

  console.log(`Created ${zipFileName}`);
  console.log(`Created ${shaFileName}`);
  console.log(`SHA256 ${digest}`);
}

pack().catch((error) => {
  console.error("pack:release failed:", error?.message || error);
  process.exit(1);
});
