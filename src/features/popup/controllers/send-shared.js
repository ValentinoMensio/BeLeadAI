import { isTerminalJobStatus, normalizeEntityType, normalizeJobStatus } from "../../../shared/domain/job-contract.js";

export async function waitMs(ms) {
  const delay = Math.max(0, Number(ms || 0));
  if (delay <= 0) return;
  await new Promise((resolve) => setTimeout(resolve, delay));
}

export async function getSenderRuntimeContext() {
  try {
    const status = await chrome.runtime.sendMessage({ action: "get_sender_status" });
    const fromAccount = String(status?.fromAccount || "")
      .trim()
      .toLowerCase();
    return { status, fromAccount };
  } catch {
    return { status: null, fromAccount: "" };
  }
}

export async function waitForSenderAccountReady(expectedFromAccount = "", timeoutMs = 3200) {
  const expected = String(expectedFromAccount || "")
    .trim()
    .toLowerCase();
  const deadline = Date.now() + Math.max(1000, Number(timeoutMs || 0));
  while (Date.now() < deadline) {
    const { status, fromAccount } = await getSenderRuntimeContext();
    if (status?.isRunning && fromAccount) {
      return fromAccount;
    }
    if (status?.isRunning && expected) {
      return expected;
    }
    await waitMs(250);
  }
  return expected;
}

export function getRetryAfterSec(result) {
  const retry = Number(
    result?.error?.retryAfterSec ??
      result?.error?.details?.retry_after ??
      result?.error?.details?.retry_after_sec ??
      result?.error?.details?.retryAfter
  );
  if (!Number.isFinite(retry) || retry <= 0) return 0;
  return Math.ceil(retry);
}

export function describeSenderActivity(status) {
  if (!status?.isRunning) return "";
  const stage = String(status.progressStage || "").toLowerCase();
  if (stage === "cooldown_wait") {
    return `Esperando próximo envío (${status.timeUntilNextFormatted || "--:--"})`;
  }
  if (stage === "task_claimed") return "Tarea tomada. Preparando envío...";
  if (stage === "ws_tasks") return "Recibiendo tareas en tiempo real...";
  if (stage === "pull_ok") return "Buscando nuevas tareas en el servidor...";
  if (stage === "no_tasks_retry") return "No hay tareas por ahora. Reintentando automaticamente...";
  if (stage === "content_ack") return "Instagram respondió. Confirmando resultado...";
  if (stage === "thread_identity_skip") {
    return "No se pudo validar un hilo. Saltando ese contacto y continuando...";
  }
  if (stage === "recovery") return "Recuperando conexión y pestaña de Instagram...";
  if (stage === "result_reported") return "Resultado reportado. Continuando...";
  if (stage === "started") return "Sender iniciado. Preparando primer envío...";
  return "Sender en ejecución...";
}

export function describeActiveWorkForSend(activeWork) {
  const kind = String(activeWork?.kind || "").toLowerCase();
  const status = String(activeWork?.status || "running").toLowerCase();
  if (kind.includes("send")) {
    const statusLabel = status === "pending" ? "pendiente" : "en curso";
    return `Hay un envio ${statusLabel}. Podes cancelarlo con "Detener envio".`;
  }
  const kindLabel = kind.includes("send")
    ? "envio"
    : kind.includes("analyze")
      ? "analisis"
      : "extraccion";
  const statusLabel = status === "pending" ? "pendiente" : "en curso";
  return `Hay un ${kindLabel} ${statusLabel}. Cuando termine, vas a poder elegir destinatarios.`;
}

export function normalizeCounter(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

export function normalizeSendSummary(raw) {
  if (!raw || typeof raw !== "object") return null;
  const queued = normalizeCounter(raw.queued ?? raw.pending ?? raw.pending_count ?? raw.queued_count);
  const sent = normalizeCounter(raw.running ?? raw.sent ?? raw.running_count ?? raw.sent_count);
  const ok = normalizeCounter(raw.completed ?? raw.ok ?? raw.completed_count ?? raw.ok_count);
  const error = normalizeCounter(raw.failed ?? raw.error ?? raw.failed_count ?? raw.error_count);
  return {
    ...raw,
    status: normalizeJobStatus(raw.status),
    queued,
    sent,
    ok,
    error,
  };
}

export function normalizeJobId(value, kindHint = "job") {
  const raw = String(value || "").trim();
  if (!raw) return "";
  if (raw.includes(":")) return raw;
  const kind = normalizeEntityType(kindHint);
  if (kind === "flow") return `flow:${raw}`;
  return raw;
}

export function isTerminalSendJobStatus(status) {
  return isTerminalJobStatus(status);
}
