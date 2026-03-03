export const JOB_STATUS = Object.freeze({
  pending: "pending",
  running: "running",
  completed: "completed",
  failed: "failed",
  canceled: "canceled",
});

const STATUS_ALIASES = Object.freeze({
  queued: JOB_STATUS.pending,
  open: JOB_STATUS.pending,
  pending: JOB_STATUS.pending,
  running: JOB_STATUS.running,
  in_progress: JOB_STATUS.running,
  processing: JOB_STATUS.running,
  sent: JOB_STATUS.running,
  completed: JOB_STATUS.completed,
  done: JOB_STATUS.completed,
  success: JOB_STATUS.completed,
  ok: JOB_STATUS.completed,
  failed: JOB_STATUS.failed,
  error: JOB_STATUS.failed,
  canceled: JOB_STATUS.canceled,
  cancelled: JOB_STATUS.canceled,
  stopped: JOB_STATUS.canceled,
  aborted: JOB_STATUS.canceled,
});

const ENTITY_PREFIX_TO_TYPE = Object.freeze({
  flow: "flow",
  job: "job",
  result: "result",
  analyze: "job",
  send: "job",
});

export function normalizeJobStatus(status) {
  const raw = String(status || "").trim().toLowerCase();
  if (!raw) return "";
  return STATUS_ALIASES[raw] || raw;
}

export function isTerminalJobStatus(status) {
  const normalized = normalizeJobStatus(status);
  return (
    normalized === JOB_STATUS.completed ||
    normalized === JOB_STATUS.failed ||
    normalized === JOB_STATUS.canceled
  );
}

export function isActiveJobStatus(status) {
  const normalized = normalizeJobStatus(status);
  return normalized === JOB_STATUS.pending || normalized === JOB_STATUS.running;
}

export function normalizeEntityType(type) {
  const raw = String(type || "").trim().toLowerCase();
  if (!raw) return "job";
  if (raw === "followings_flow" || raw === "flow") return "flow";
  if (raw === "result" || raw === "results") return "result";
  if (ENTITY_PREFIX_TO_TYPE[raw]) return ENTITY_PREFIX_TO_TYPE[raw];
  return "job";
}

export function parseScopedEntityId(value, fallbackType = "job") {
  const raw = String(value || "").trim();
  const fallback = normalizeEntityType(fallbackType);
  if (!raw) {
    return { id: "", type: fallback, raw: "" };
  }
  const sepIndex = raw.indexOf(":");
  if (sepIndex <= 0) {
    return { id: raw, type: fallback, raw };
  }
  const prefix = raw.slice(0, sepIndex).trim().toLowerCase();
  const scopedId = raw.slice(sepIndex + 1).trim();
  if (!scopedId) {
    return { id: raw, type: fallback, raw };
  }
  const mappedType = ENTITY_PREFIX_TO_TYPE[prefix] || fallback;
  return { id: scopedId, type: mappedType, raw };
}

export function toScopedEntityId(type, id) {
  const normalizedType = normalizeEntityType(type);
  const normalizedId = String(id || "").trim();
  if (!normalizedId) return "";
  return `${normalizedType}:${normalizedId}`;
}
