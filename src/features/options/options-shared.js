export function normalizeBaseUrl(v) {
  const s = (v || "").trim();
  return s.replace(/\/+$/, "");
}

export function toNumOrNull(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export function resolveUsedMonth(messages, planMonth) {
  const direct =
    toNumOrNull(messages?.used_this_month) ??
    toNumOrNull(messages?.used_month) ??
    toNumOrNull(messages?.sent_this_month) ??
    toNumOrNull(messages?.consumed_this_month) ??
    toNumOrNull(messages?.total_this_month);
  if (direct != null) return Math.max(0, direct);
  const remaining = toNumOrNull(messages?.remaining_this_month);
  const limit = toNumOrNull(planMonth);
  if (remaining != null && limit != null && limit > 0) return Math.max(0, limit - remaining);
  return 0;
}

export function isSecureApiBase(base) {
  try {
    return new URL(base).protocol === "https:";
  } catch {
    return false;
  }
}

export function toApiOriginPermission(base) {
  const u = new URL(base);
  const host = u.port ? `${u.hostname}:${u.port}` : u.hostname;
  return `${u.protocol}//${host}/*`;
}

export function permissionsContains(origins) {
  return new Promise((resolve) => {
    chrome.permissions.contains({ origins }, (granted) => resolve(!!granted));
  });
}

export function permissionsRequest(origins) {
  return new Promise((resolve) => {
    chrome.permissions.request({ origins }, (granted) => resolve(!!granted));
  });
}

export async function ensureApiHostPermission(base, requestIfMissing = false) {
  if (!base || !isSecureApiBase(base)) return false;
  const origin = toApiOriginPermission(base);
  const alreadyGranted = await permissionsContains([origin]);
  if (alreadyGranted) return true;
  if (!requestIfMissing) return false;
  return permissionsRequest([origin]);
}

export function classifyLoginFailure(result) {
  const status = Number(result?.status || 0) || 0;
  const code = String(result?.error?.code || "")
    .trim()
    .toUpperCase();
  if (status === 426 || code === "CLIENT_UPDATE_REQUIRED") return "update_required";
  const blockingQuota = String(result?.error?.details?.blocking_quota || "")
    .trim()
    .toLowerCase();
  if (
    status === 403 ||
    code === "PLAN_EXPIRED" ||
    code === "FREE_PLAN_EXPIRED" ||
    blockingQuota === "plan_duration" ||
    blockingQuota === "free_plan_duration"
  ) {
    return "plan_expired";
  }
  if (status === 429 || code === "RATE_LIMIT_EXCEEDED") return "rate_limit";
  if (status === 401 || status === 403 || code === "UNAUTHORIZED" || code === "INVALID_API_KEY") {
    return "auth";
  }
  if (status === 0 || code === "NETWORK_ERROR" || code === "REQUEST_TIMEOUT") return "network";
  return "unknown";
}

export function toVersionBlockDetails(errorDetails) {
  if (!errorDetails || typeof errorDetails !== "object") return {};
  return {
    minRequiredVersion: String(
      errorDetails.minRequiredVersion || errorDetails.min_required_version || ""
    ).trim(),
    latestVersion: String(errorDetails.latestVersion || errorDetails.latest_version || "").trim(),
    updateUrl: String(errorDetails.updateUrl || errorDetails.update_url || "").trim(),
  };
}
