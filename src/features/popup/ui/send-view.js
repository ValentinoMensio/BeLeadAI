/**
 * UI de la pestaña Enviar: estado, progreso del job de envío, botón encolar.
 */

import { qs } from "../../../shared/utils/dom.js";

let lastErrorTimestamp = 0;
const ERROR_PERSIST_MS = 3000; // Los errores persisten por 3 segundos

export function setSendStatus(msg, isErr = false) {
  const el = qs("#send_status");
  if (!el) return;

  // Si hay un error visible y el nuevo mensaje no es error, no sobrescribir
  const isCurrentError = el.classList.contains("err");
  const now = Date.now();

  if (isCurrentError && !isErr) {
    // Solo sobrescribir errores si han pasado más de ERROR_PERSIST_MS
    if (now - lastErrorTimestamp < ERROR_PERSIST_MS) {
      return; // Preservar el error
    }
  }

  if (isErr) {
    lastErrorTimestamp = now;
  }

  const nextText = String(msg || "");
  const nextClass = isErr ? "status-line err" : "status-line ok";
  if (el.textContent === nextText && el.className === nextClass) {
    return;
  }
  el.textContent = nextText;
  el.className = nextClass;
}

export function setEnqueueSendEnabled(enabled, reason = "") {
  const btn = qs("#start_sender");
  if (!btn) return;
  btn.disabled = !enabled;
  btn.title = !enabled && reason ? reason : "";
}

export function updateSendJobProgress(stats) {
  if (!stats) return;
  const queued = stats.queued || 0;
  const sent = stats.sent || 0;
  const ok = stats.ok || 0;
  const error = stats.error || 0;
  const total = queued + sent + ok + error;
  const completed = ok + error;
  const isFinished = queued === 0 && sent === 0 && total > 0;
  const percent = total > 0 ? Math.round((completed / total) * 100) : 0;
  const canceled = !!stats.canceled;
  const cancelMeta = stats.cancel && typeof stats.cancel === "object" ? stats.cancel : null;

  const section = qs("#send_job_progress_section");
  const fillEl = qs("#send_progress_fill");
  if (section) section.style.display = "block";
  if (fillEl) fillEl.style.width = percent + "%";

  let statusText = "";
  if (canceled) {
    const sentConfirmed = Number(cancelMeta?.sent_confirmed ?? ok) || 0;
    statusText = `Envio detenido: ${sentConfirmed} enviados`;
  } else if (isFinished) {
    const totalItems = Math.max(total, completed, 1);
    statusText = `Envio finalizado: ${ok}/${totalItems} enviados`;
  } else if (total > 0) {
    const totalItems = Math.max(total, completed, queued + sent, 1);
    statusText = `Envio en curso: ${completed}/${totalItems}`;
  } else {
    statusText = "Sin tareas pendientes";
  }
  if (statusText) setSendStatus(statusText, false);
}
