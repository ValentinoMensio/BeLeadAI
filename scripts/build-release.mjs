import { cp, mkdir, rm, access, readFile, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

const root = resolve(process.cwd());
const dist = resolve(root, "dist");

const releaseFiles = ["manifest.json", "popup.html", "options.html", "icons", "src"];

async function ensureExists(path) {
  await access(path, constants.R_OK);
}

function detectBuildSha() {
  const fromCi = String(process.env.GITHUB_SHA || "").trim();
  if (fromCi) return fromCi.slice(0, 12);
  try {
    const fromGit = execFileSync("git", ["rev-parse", "--short=12", "HEAD"], {
      cwd: root,
      encoding: "utf8",
    });
    const normalized = String(fromGit || "").trim();
    if (normalized) return normalized;
  } catch {}
  return "devlocal";
}

async function injectManifestVersionName() {
  const manifestPath = resolve(dist, "manifest.json");
  const raw = await readFile(manifestPath, "utf8");
  const manifest = JSON.parse(raw);
  const version = String(manifest.version || "0.0.0").trim() || "0.0.0";
  const buildSha = detectBuildSha();
  manifest.version_name = `${version}+${buildSha}`;
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

async function build() {
  await rm(dist, { recursive: true, force: true });
  await mkdir(dist, { recursive: true });

  for (const rel of releaseFiles) {
    const src = resolve(root, rel);
    await ensureExists(src);
    await cp(src, resolve(dist, rel), { recursive: true });
  }

  await injectManifestVersionName();

  console.log("Release build ready at dist/");
}

build().catch((err) => {
  console.error("build:release failed:", err?.message || err);
  process.exit(1);
});
