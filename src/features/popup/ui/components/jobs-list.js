/**
 * Lista de jobs (select) en la pestaña Analizar.
 */

import { formatJobOptionLabel } from "../../../../shared/utils/format.js";

/**
 * @param {HTMLSelectElement} container - select#last_jobs_select
 * @param {Array<{id, kind, created_at, status, _hasAnalyze?}>} jobs
 * @param {{ selectedJobId: string|null }} options
 */
export function renderJobsList(container, jobs, { selectedJobId }) {
  if (!container) return;
  container.innerHTML = '<option value="">— Elegí un resultado —</option>';
  for (const j of jobs) {
    const hasAnalyze = j._hasAnalyze === true;
    const opt = document.createElement("option");
    opt.value = j.id;
    opt.textContent = formatJobOptionLabel(j, hasAnalyze);
    opt.dataset.kind = j.kind || "";
    container.appendChild(opt);
  }
  if (selectedJobId && jobs.some((j) => j.id === selectedJobId)) {
    container.value = selectedJobId;
  }
}
