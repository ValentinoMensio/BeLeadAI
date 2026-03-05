const SAFE_SINGLE_FLIGHT_METHODS = new Set(["GET", "HEAD"]);

const GROUP_POLICIES = {
  sender_critical: { baseMs: 1500, maxMs: 20000 },
  ui_summary: { baseMs: 3000, maxMs: 45000 },
  ui_list: { baseMs: 2500, maxMs: 30000 },
  ui_limits: { baseMs: 5000, maxMs: 45000 },
  ui_recipients: { baseMs: 3500, maxMs: 45000 },
  default: { baseMs: 2500, maxMs: 30000 },
};

const inFlightByKey = new Map();
const circuitStateByGroup = new Map();

function normalizePathForGrouping(pathOrUrl) {
  const raw = String(pathOrUrl || "").trim();
  if (!raw) return "/";
  let pathname = raw;
  try {
    pathname = new URL(raw).pathname || raw;
  } catch {
    pathname = raw;
  }
  const noQuery = pathname.split("?")[0] || pathname;
  const base = noQuery.replace(/\/+$/, "") || "/";
  if (base === "/ext/v2") return "/ext";
  if (base.startsWith("/ext/v2/")) return `/ext${base.slice("/ext/v2".length)}`;
  return base;
}

function parseMethod(method) {
  return String(method || "GET")
    .trim()
    .toUpperCase();
}

export function classifyRequestGroup(method, pathOrUrl) {
  const m = parseMethod(method);
  const path = normalizePathForGrouping(pathOrUrl);
  if (
    m === "POST" &&
    (path === "/api/send/pull" ||
      path === "/api/send/result" ||
      path === "/api/send/heartbeat" ||
      path === "/api/send/ws-ticket")
  ) {
    return "sender_critical";
  }
  if (m === "GET" && path.startsWith("/ext/results/") && path.endsWith("/summary")) {
    return "ui_summary";
  }
  if (m === "GET" && (path === "/ext/results" || path === "/ext/jobs" || path === "/ext/flows")) {
    return "ui_list";
  }
  if (m === "GET" && path === "/ext/limits") {
    return "ui_limits";
  }
  if (m === "GET" && path.startsWith("/ext/recipient-sources")) {
    return "ui_recipients";
  }
  return "default";
}

function policyForGroup(group) {
  return GROUP_POLICIES[group] || GROUP_POLICIES.default;
}

function getGroupState(group) {
  if (!circuitStateByGroup.has(group)) {
    circuitStateByGroup.set(group, {
      openUntilMs: 0,
      rateLimitHits: 0,
      lastStatus: 0,
      lastUpdatedMs: 0,
    });
  }
  return circuitStateByGroup.get(group);
}

function withJitter(ms) {
  const factor = 0.8 + Math.random() * 0.4;
  return Math.round(ms * factor);
}

function computeBackoffMs(group, retryAfterSec, hitCount) {
  const { baseMs, maxMs } = policyForGroup(group);
  const cappedHits = Math.max(1, Math.min(8, Number(hitCount || 1)));
  const expMs = Math.min(maxMs, baseMs * 2 ** (cappedHits - 1));
  const retryMs =
    Number.isFinite(Number(retryAfterSec)) && Number(retryAfterSec) > 0
      ? Math.ceil(Number(retryAfterSec)) * 1000
      : 0;
  const candidateMs = Math.max(expMs, retryMs);
  return Math.max(baseMs, Math.min(maxMs, withJitter(candidateMs)));
}

export function getCircuitBlock(method, pathOrUrl) {
  const group = classifyRequestGroup(method, pathOrUrl);
  const state = getGroupState(group);
  const now = Date.now();
  if (state.openUntilMs <= now) {
    if (state.openUntilMs > 0) {
      state.openUntilMs = 0;
    }
    return { blocked: false, retryAfterSec: 0, status: 0, group };
  }
  const retryAfterSec = Math.max(1, Math.ceil((state.openUntilMs - now) / 1000));
  return {
    blocked: true,
    retryAfterSec,
    status: state.lastStatus || 429,
    group,
  };
}

export function markRateLimited(method, pathOrUrl, status, retryAfterSec = 0) {
  const group = classifyRequestGroup(method, pathOrUrl);
  const state = getGroupState(group);
  state.rateLimitHits = Math.max(0, Number(state.rateLimitHits || 0)) + 1;
  state.lastStatus = Number(status || 0) || 429;
  const backoffMs = computeBackoffMs(group, retryAfterSec, state.rateLimitHits);
  state.openUntilMs = Math.max(state.openUntilMs || 0, Date.now() + backoffMs);
  state.lastUpdatedMs = Date.now();
  return { group, backoffMs, retryAfterSec: Math.ceil(backoffMs / 1000) };
}

export function markRequestSuccess(method, pathOrUrl) {
  const group = classifyRequestGroup(method, pathOrUrl);
  const state = getGroupState(group);
  state.rateLimitHits = 0;
  state.openUntilMs = 0;
  state.lastStatus = 0;
  state.lastUpdatedMs = Date.now();
}

function normalizeBodyKey(body) {
  if (body == null) return "";
  const raw = String(body);
  if (raw.length <= 160) return raw;
  return `${raw.slice(0, 80)}::${raw.length}::${raw.slice(-40)}`;
}

export function buildSingleFlightKey(method, url, body = null) {
  const m = parseMethod(method);
  const target = String(url || "").trim();
  return `${m}::${target}::${normalizeBodyKey(body)}`;
}

export function runSingleFlight(method, url, body, run) {
  const m = parseMethod(method);
  if (!SAFE_SINGLE_FLIGHT_METHODS.has(m)) {
    return run();
  }
  const key = buildSingleFlightKey(m, url, body);
  if (inFlightByKey.has(key)) {
    return inFlightByKey.get(key);
  }
  const promise = (async () => run())();
  inFlightByKey.set(key, promise);
  promise.finally(() => {
    if (inFlightByKey.get(key) === promise) {
      inFlightByKey.delete(key);
    }
  });
  return promise;
}
