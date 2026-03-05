/**
 * WebSocket jobs: el popup no abre WS; el background lo hace. Solo pedimos conexión y escuchamos mensajes.
 */

import { logApiErrorDiagnostic } from "../shared/errors/error-diagnostics.js";

/** Pide al background que mantenga la conexión WS de jobs. */
export function ensureJobsWsConnected() {
  chrome.runtime.sendMessage({ action: "ensureJobsWsConnected" }).catch((e) => {
    logApiErrorDiagnostic("popup.ensure_jobs_ws_connected", e);
  });
}

/**
 * Suscribe a eventos jobs_updated (enviados por el background).
 * @param {(payload?: any) => void} onJobsUpdated
 * @returns {() => void} función para dejar de escuchar
 */
export function subscribeJobsUpdated(onJobsUpdated) {
  const listener = (msg) => {
    const type = String(msg?.type || "")
      .trim()
      .toLowerCase();
    if (type === "jobs_updated" || type === "jobs.updated" || type === "job.updated") {
      onJobsUpdated(msg?.payload ?? msg);
    }
  };
  chrome.runtime.onMessage.addListener(listener);
  return () => chrome.runtime.onMessage.removeListener(listener);
}
