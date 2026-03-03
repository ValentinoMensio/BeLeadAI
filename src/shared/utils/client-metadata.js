const DEFAULT_CLIENT_PLATFORM = "chrome-mv3";
const DEFAULT_CLIENT_BUILD = "dev-local";

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
  return {
    ...baseHeaders,
    "X-Client-Version": metadata.version,
    "X-Client-Platform": metadata.platform,
    "X-Client-Build": metadata.build,
  };
}
