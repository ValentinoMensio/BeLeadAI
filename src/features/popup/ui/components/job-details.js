/**
 * Detalle de progreso del job seleccionado (barra + texto).
 */

import { normalizeJobStatus } from "../../../../shared/domain/job-contract.js";

function formatFlowStopReason(stopReason) {
  const code = String(stopReason || "")
    .trim()
    .toLowerCase();
  if (!code) return "";
  const map = {
    target_reached: "objetivo alcanzado",
    scan_cap_reached: "limite de escaneo alcanzado",
    no_new_followings: "sin nuevos perfiles para continuar",
    next_fetch_round_failed: "fallo al crear la siguiente ronda",
    analyze_round_create_failed: "fallo al crear ronda de analisis",
    quota_blocked: "bloqueado por cuota",
    flow_link_failed: "fallo al enlazar jobs del flow",
  };
  return map[code] || code.replaceAll("_", " ");
}

/**
 * @param {HTMLElement} container - contenedor que incluye #progress_fill y #job_progress
 * @param {object} stats - { queued, sent, ok, error, hasAnalyzeJob, kind, mainQueued, mainSent }
 * @param {string} jobKind - dataset.kind del option seleccionado
 */
export function renderJobDetails(container, stats, jobKind = "") {
  if (!stats) return;
  const doc = container?.ownerDocument || document;
  const queued = stats.queued || 0;
  const sent = stats.sent || 0;
  const ok = stats.ok || 0;
  const error = stats.error || 0;
  const total = queued + sent + ok + error;
  const completed = ok + error;
  const hasAnalyze = stats.hasAnalyzeJob;
  const isFlow = (jobKind || "") === "followings_flow" || (stats.kind || "") === "followings_flow";
  const isAnalyzeJob =
    (jobKind || "") === "analyze_profile" || (stats.kind || "") === "analyze_profile";
  const normalizedStatus = normalizeJobStatus(stats.status);
  const isFailed = normalizedStatus === "failed";
  const isCanceled = normalizedStatus === "canceled";
  const mainQueued = stats.mainQueued || 0;
  const mainSent = stats.mainSent || 0;
  const fetchInProgress =
    jobKind === "fetch_followings" && hasAnalyze && (mainQueued > 0 || mainSent > 0);

  const isFinished = queued === 0 && sent === 0 && total > 0 && hasAnalyze;

  setText(doc.getElementById("stat_queued"), queued);
  setText(doc.getElementById("stat_sent"), sent);
  setText(doc.getElementById("stat_ok"), ok);
  setText(doc.getElementById("stat_error"), error);

  const progressFill = doc.getElementById("progress_fill");
  const progressBar = progressFill?.closest?.(".progress");

  const inProgress = fetchInProgress || (total > 0 && (queued > 0 || sent > 0));
  if (progressFill) {
    if (fetchInProgress) {
      progressFill.style.width = "";
      progressFill.classList.add("progress-indeterminate");
      if (progressBar) progressBar.classList.add("progress-busy");
    } else {
      progressFill.classList.remove("progress-indeterminate");
      if (progressBar) progressBar.classList.toggle("progress-busy", !!inProgress);
      const percent = total > 0 ? Math.round((completed / total) * 100) : 0;
      progressFill.style.width = `${percent}%`;
    }
  }

  let statusText = "";
  let statusIsErr = false;
  if (isFlow) {
    const matched = Number(stats.matchedTotal || 0);
    const target = Math.max(0, Number(stats.leadTarget || 0));
    const totalProfiles = target > 0 ? target : Math.max(total, matched, completed);
    const doneProfiles =
      target > 0
        ? Math.min(matched, totalProfiles)
        : Math.min(Math.max(matched, completed), totalProfiles);
    const stopReasonLabel = formatFlowStopReason(stats.stopReason);
    if (isFailed) {
      statusText = stopReasonLabel
        ? `Fallido: ${stopReasonLabel} (${doneProfiles}/${Math.max(totalProfiles, 1)})`
        : `Fallido: ${doneProfiles}/${Math.max(totalProfiles, 1)} perfiles`;
      statusIsErr = true;
    } else if (isCanceled) {
      statusText = `Detenido: ${doneProfiles}/${Math.max(totalProfiles, 1)} perfiles`;
    } else if (inProgress) {
      statusText = `Analizando perfiles: ${doneProfiles}/${Math.max(totalProfiles, 1)}`;
    } else if (
      String(stats.stopReason || "")
        .trim()
        .toLowerCase() === "target_reached"
    ) {
      statusText = `Objetivo alcanzado: ${doneProfiles}/${Math.max(totalProfiles, 1)} perfiles`;
    } else if (
      String(stats.stopReason || "")
        .trim()
        .toLowerCase() === "scan_cap_reached"
    ) {
      statusText = `Finalizado por limite de escaneo: ${doneProfiles}/${Math.max(totalProfiles, 1)} perfiles`;
    } else {
      statusText = `Analisis completado: ${doneProfiles}/${Math.max(totalProfiles, 1)} perfiles`;
    }
  } else if (fetchInProgress) {
    statusText = "Preparando analisis de perfiles";
  } else if (isAnalyzeJob) {
    const totalProfiles = Math.max(total, completed, queued, 1);
    if (isFailed) {
      statusText = `Analisis fallido: ${completed}/${totalProfiles} perfiles`;
      statusIsErr = true;
    } else if (isCanceled) {
      statusText = `Analisis detenido: ${completed}/${totalProfiles} perfiles`;
    } else if (inProgress || queued > 0 || sent > 0) {
      statusText = `Analizando perfiles: ${completed}/${totalProfiles}`;
    } else {
      statusText = `Analisis completado: ${completed}/${totalProfiles} perfiles`;
    }
  } else if (isFailed) {
    statusText = "Fallido";
    statusIsErr = true;
  } else if (isCanceled) {
    statusText = "Detenido";
  } else if (isFinished || (!hasAnalyze && queued === 0 && sent === 0 && (ok > 0 || error > 0))) {
    statusText = `Completado: ${ok} enviados`;
  } else if (!hasAnalyze && queued === 0 && sent === 0) {
    statusText = "Esperando analisis";
  } else {
    const totalItems = Math.max(total, completed, queued + sent, 1);
    statusText = `Procesando: ${completed}/${totalItems}`;
  }

  const progressText = doc.getElementById("progress_text");
  if (progressText && progressText.textContent !== statusText) {
    progressText.textContent = statusText;
  }
  const statusLine = doc.getElementById("status");
  if (statusLine && statusText) {
    const nextClass = statusIsErr ? "status-line err" : "status-line ok";
    if (statusLine.textContent !== statusText || statusLine.className !== nextClass) {
      statusLine.textContent = statusText;
      statusLine.className = nextClass;
    }
  }
  const jobProgress = doc.getElementById("job_progress");
  if (jobProgress) jobProgress.style.display = "block";
}

function setText(el, text) {
  if (el) el.textContent = text ?? "";
}
