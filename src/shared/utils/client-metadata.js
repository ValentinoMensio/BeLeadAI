const DEFAULT_CLIENT_PLATFORM = "chrome-mv3";
const DEFAULT_CLIENT_BUILD = "dev-local";

function generateTraceId() {
  try {
    if (globalThis.crypto?.randomUUID) {
      return globalThis.crypto.randomUUID().replace(/-/g, "");
    }
  } catch {}
  return `${Date.now().toString(16)}${Math.random().toString(16).slice(2, 18)}`.padEnd(32, "0").slice(0, 32);
}

function getManifest() {
  try {
    return chrome?.runtime?.getManifest?.() || {};
  } catch {
    return {};
  }
}

function normalizeText(value) {
  const raw = String(value || "").trim();
  return raw;
}

function extractBuildFromVersionName(versionName) {
  const raw = normalizeText(versionName);
  if (!raw) return "";
  const plusIdx = raw.indexOf("+");
  if (plusIdx >= 0 && plusIdx < raw.length - 1) {
    return raw.slice(plusIdx + 1).trim();
  }
  return "";
}

export function getClientMetadata() {
  const manifest = getManifest();
  const version = normalizeText(manifest.version) || "0.0.0";
  const versionName = normalizeText(manifest.version_name);
  const build = extractBuildFromVersionName(versionName) || DEFAULT_CLIENT_BUILD;
  return {
    version,
    platform: DEFAULT_CLIENT_PLATFORM,
    build,
  };
}

export function buildClientHeaders(baseHeaders = {}) {
  const metadata = getClientMetadata();
  const traceId = String(baseHeaders["X-Trace-ID"] || baseHeaders["x-trace-id"] || "").trim() || generateTraceId();
  return {
    ...baseHeaders,
    "X-Client-Version": metadata.version,
    "X-Client-Platform": metadata.platform,
    "X-Client-Build": metadata.build,
    "X-Trace-ID": traceId,
  };
}
