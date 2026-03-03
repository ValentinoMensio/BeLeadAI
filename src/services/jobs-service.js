/**
 * Servicio de jobs/flows: carga lista, resumen y destinatarios. Solo datos, no DOM.
 */

import { getAuthHeaders } from "./api-client.js";
import { apiFetch } from "./api-client.js";
import { API_PATHS } from "../config/endpoints.js";
import {
  isTerminalJobStatus,
  normalizeEntityType,
  normalizeJobStatus,
  parseScopedEntityId,
} from "../shared/domain/job-contract.js";

function unwrapApiData(payload) {
  if (!payload || typeof payload !== "object") return {};
  const inner = payload.data;
  if (inner && typeof inner === "object" && !Array.isArray(inner)) return inner;
  return payload;
}

function buildServiceError(
  result,
  fallbackCode = "API_ERROR",
  fallbackMessage = "Error de la API."
) {
  const status = Number(result?.status || 0) || 0;
  const code =
    String(result?.error?.code || fallbackCode)
      .trim()
      .toUpperCase() || fallbackCode;
  const message = String(result?.error?.message || fallbackMessage).trim() || fallbackMessage;
  return {
    code,
    message,
    status,
    details: result?.error?.details || null,
    traceId: result?.error?.traceId || null,
    retryAfterSec: Number(result?.error?.retryAfterSec || 0) || null,
  };
}

function normalizeEntityId(value) {
  return parseScopedEntityId(value).id.toLowerCase();
}

function toCanonicalResultId(value, kindHint = "job") {
  const raw = String(value || "").trim();
  if (!raw) return "";
  if (raw.includes(":")) return raw;
  const kind = normalizeEntityType(kindHint);
  if (kind === "flow") return `flow:${raw}`;
  return raw;
}

function toCanonicalSourceId(value, kindHint = "job") {
  const raw = String(value || "").trim();
  if (!raw) return "";
  if (raw.includes(":")) return raw;
  const kind = normalizeEntityType(kindHint);
  if (kind === "flow") return `flow:${raw}`;
  return raw;
}

function toCanonicalJobId(value, kindHint = "job") {
  const raw = String(value || "").trim();
  if (!raw) return "";
  if (raw.includes(":")) return raw;
  const kind = normalizeEntityType(kindHint);
  if (kind === "flow") return `flow:${raw}`;
  return raw;
}

function getFlowIdFromExtra(job) {
  try {
    let extra = job?.extra_json;
    if (typeof extra === "string") extra = JSON.parse(extra);
    const flowId = extra?.flow_id;
    return flowId ? String(flowId).trim() : "";
  } catch {
    return "";
  }
}

function buildJobsIndex(allJobs) {
  const byExact = new Map();
  const byNormalized = new Map();
  for (const row of Array.isArray(allJobs) ? allJobs : []) {
    const idRaw = String(row?.id || "").trim();
    if (!idRaw) continue;
    byExact.set(idRaw.toLowerCase(), row);
    const normalized = normalizeEntityId(idRaw);
    if (normalized && !byNormalized.has(normalized)) {
      byNormalized.set(normalized, row);
    }
  }
  return { byExact, byNormalized };
}

function getJobRowById(jobId, jobsIndex) {
  const raw = String(jobId || "")
    .trim()
    .toLowerCase();
  if (!raw) return null;
  if (jobsIndex?.byExact?.has(raw)) return jobsIndex.byExact.get(raw) || null;
  const normalized = normalizeEntityId(raw);
  if (normalized && jobsIndex?.byNormalized?.has(normalized)) {
    return jobsIndex.byNormalized.get(normalized) || null;
  }
  return null;
}

function getLineageKey(source, jobsIndex = null) {
  const kind = String(source?.kind || "")
    .trim()
    .toLowerCase();
  if (kind === "followings_flow") {
    return `flow:${normalizeEntityId(source?.id || "")}`;
  }

  const row = getJobRowById(source?.id, jobsIndex);
  const linkedFlowId = getFlowIdFromExtra(row || source);
  if (linkedFlowId) {
    return `flow:${normalizeEntityId(linkedFlowId)}`;
  }
  return `job:${normalizeEntityId(source?.id || "")}`;
}

function sourcePriority(kind) {
  const k = String(kind || "")
    .trim()
    .toLowerCase();
  if (k === "followings_flow") return 3;
  if (k === "analyze_profile") return 2;
  if (k === "fetch_followings") return 1;
  return 0;
}

function mergeRecipientSources(sources, jobsIndex = null) {
  const chosenByLineage = new Map();
  for (const source of Array.isArray(sources) ? sources : []) {
    const lineageKey = getLineageKey(source, jobsIndex);
    if (!lineageKey || lineageKey.endsWith(":")) continue;
    const current = chosenByLineage.get(lineageKey);
    if (!current) {
      chosenByLineage.set(lineageKey, source);
      continue;
    }
    const nextPriority = sourcePriority(source?.kind);
    const curPriority = sourcePriority(current?.kind);
    if (nextPriority > curPriority) {
      chosenByLineage.set(lineageKey, source);
      continue;
    }
    if (nextPriority === curPriority) {
      const nextTs = new Date(source?.created_at || 0).getTime();
      const curTs = new Date(current?.created_at || 0).getTime();
      if (nextTs > curTs) chosenByLineage.set(lineageKey, source);
    }
  }
  return [...chosenByLineage.values()].sort(
    (a, b) => new Date(b?.created_at || 0).getTime() - new Date(a?.created_at || 0).getTime()
  );
}

function isSecureApiBase(baseUrl) {
  try {
    return new URL((baseUrl || "").trim()).protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Lista de resultados para la pestaña Analizar.
 * Prioriza resultados/flows; complementa con jobs cuando hace falta.
 */
export async function loadLastJobs(baseUrl, limit = 5) {
  if (!isSecureApiBase(baseUrl)) {
    return {
      ok: false,
      error: {
        code: "HTTPS_REQUIRED",
        message: "La API debe usar HTTPS.",
        status: 0,
      },
    };
  }
  const resultsPath = `${API_PATHS.results}?limit=${Math.max(limit, 5)}`;
  const resultsResp = await apiFetch(baseUrl, resultsPath);
  if (resultsResp.ok) {
    const resultsData = unwrapApiData(resultsResp.data);
    const rows = (Array.isArray(resultsData?.items) ? resultsData.items : []).filter((r) => {
      const kind = String(r?.result_kind || "").toLowerCase();
      return kind === "analyze_profile" || kind === "followings_flow";
    });
    const extractJobs = rows
      .map((r) => ({
        id: toCanonicalResultId(
          r?.result_id || "",
          normalizeEntityType(r?.result_kind || "result")
        ),
        entity_type: normalizeEntityType(r?.result_kind || "result"),
        kind: String(r?.result_kind || ""),
        status: normalizeJobStatus(r?.status || "completed"),
        created_at: String(r?.created_at || ""),
        target_username: String(r?.meta?.target_username || ""),
        lead_target: Number(r?.meta?.lead_target || 0) || 0,
        scan_cap: Number(r?.meta?.scan_cap || 0) || 0,
        scanned_total: Number(r?.meta?.scanned_total || 0) || 0,
        matched_total: Number(r?.meta?.matched_total || 0) || 0,
        rounds_done: Number(r?.meta?.rounds_done || 0) || 0,
        stop_reason: r?.meta?.stop_reason || null,
      }))
      .filter((r) => !!r.id);
    const saved = await new Promise((r) =>
      chrome.storage.local.get({ last_flow_id: null, last_job_id: null }, (d) =>
        r(d.last_flow_id || d.last_job_id)
      )
    );
    const savedId = toCanonicalResultId(saved, "result");
    return { ok: true, data: { extractJobs, savedJobId: savedId } };
  }

  const flowResult = await apiFetch(baseUrl, `${API_PATHS.flows}?limit=${Math.max(limit, 5)}`);
  const listLimit = Math.max(limit * 2, 20);
  const jobsResult = await apiFetch(baseUrl, `${API_PATHS.jobs}?limit=${listLimit}`);
  const jobsData = jobsResult.ok ? unwrapApiData(jobsResult.data) : {};
  const allJobs = jobsResult.ok ? jobsData?.jobs || [] : [];

  const jobsIndex = buildJobsIndex(allJobs);

  if (flowResult.ok) {
    const flowData = unwrapApiData(flowResult.data);
    const flows = (flowData?.flows || []).slice().sort((a, b) => {
      const ta = new Date(a.created_at || 0).getTime();
      const tb = new Date(b.created_at || 0).getTime();
      return tb - ta;
    });
    const flowJobs = flows.map((f) => ({
      id: toCanonicalResultId(f.id, "flow"),
      entity_type: "flow",
      kind: "followings_flow",
      status: normalizeJobStatus(f.status),
      created_at: f.created_at,
      target_username: f.target_username,
      lead_target: f.lead_target,
      scan_cap: f.scan_cap,
      scanned_total: f.scanned_total,
      matched_total: f.matched_total,
      rounds_done: f.rounds_done,
      stop_reason: f.stop_reason,
    }));

    const standaloneAnalyzeJobs = allJobs
      .filter((j) => String(j?.kind || "").toLowerCase() === "analyze_profile")
      .filter((j) => isTerminalJobStatus(j?.status))
      .filter((j) => !getFlowIdFromExtra(j))
      .map((j) => ({
        id: toCanonicalResultId(j.id, "job"),
        entity_type: "job",
        kind: "analyze_profile",
        status: normalizeJobStatus(j.status),
        created_at: j.created_at,
      }));

    const extractJobs = mergeRecipientSources(
      [...flowJobs, ...standaloneAnalyzeJobs],
      jobsIndex
    ).slice(0, limit);

    const saved = await new Promise((r) =>
      chrome.storage.local.get({ last_flow_id: null, last_job_id: null }, (d) =>
        r(d.last_flow_id || d.last_job_id)
      )
    );
    const savedId = toCanonicalResultId(saved, "result");
    return { ok: true, data: { extractJobs, savedJobId: savedId } };
  }

  if (!jobsResult.ok) {
    return {
      ok: false,
      error: buildServiceError(jobsResult, "JOBS_LIST_FAILED", "No se pudieron cargar los jobs."),
    };
  }
  const sortedJobs = (allJobs || []).slice().sort((a, b) => {
    const ta = new Date(a.created_at || 0).getTime();
    const tb = new Date(b.created_at || 0).getTime();
    return tb - ta;
  });
  const fetchJobs = sortedJobs.filter((j) => (j.kind || "").toLowerCase() === "fetch_followings");
  const analyzeJobs = sortedJobs.filter((j) => (j.kind || "").toLowerCase() === "analyze_profile");
  const fetchIds = new Set(fetchJobs.map((j) => parseScopedEntityId(j.id, "job").id));

  const extractJobs = [];
  for (const j of fetchJobs) {
    const fetchId = parseScopedEntityId(j.id, "job").id;
    const hasAnalyze = analyzeJobs.some((a) => parseScopedEntityId(a.id, "job").id === fetchId);
    extractJobs.push({
      ...j,
      id: fetchId,
      entity_type: "job",
      status: normalizeJobStatus(j.status),
      _hasAnalyze: hasAnalyze,
    });
  }
  for (const a of analyzeJobs) {
    const baseId = parseScopedEntityId(a.id, "job").id;
    const normalizedAnalyze = {
      ...a,
      id: baseId,
      entity_type: "job",
      status: normalizeJobStatus(a.status),
    };
    if (!baseId) {
      extractJobs.push(normalizedAnalyze);
      continue;
    }
    if (fetchIds.has(baseId)) continue;
    extractJobs.push(normalizedAnalyze);
  }
  const dedupedExtractJobs = mergeRecipientSources(extractJobs, jobsIndex);

  const saved = await new Promise((r) =>
    chrome.storage.local.get({ last_job_id: null }, (d) => r(d.last_job_id))
  );
  const savedId = toCanonicalResultId(saved, "result");
  return { ok: true, data: { extractJobs: dedupedExtractJobs, savedJobId: savedId } };
}

/**
 * Resumen de un job o flow.
 */
export async function loadJobSummary(baseUrl, jobOrFlowId) {
  if (!isSecureApiBase(baseUrl)) {
    return {
      ok: false,
      error: {
        code: "HTTPS_REQUIRED",
        message: "La API debe usar HTTPS.",
        status: 0,
      },
    };
  }
  const rawId = String(jobOrFlowId || "").trim();
  const resultId = toCanonicalResultId(rawId, "result");
  if (!resultId) {
    return {
      ok: false,
      error: {
        code: "RESULT_ID_REQUIRED",
        message: "Falta result_id para consultar el resumen.",
        status: 404,
      },
    };
  }
  const result = await apiFetch(baseUrl, API_PATHS.resultSummary(resultId));
  if (!result.ok) {
    return {
      ok: false,
      error: buildServiceError(
        result,
        "RESULT_SUMMARY_FAILED",
        "No se pudo cargar el resumen del resultado."
      ),
    };
  }
  const summary = unwrapApiData(result.data);
  if (!summary || typeof summary !== "object") {
    return {
      ok: false,
      error: {
        code: "INVALID_RESPONSE_SCHEMA",
        message: "El resumen no cumple el contrato esperado.",
        status: 500,
      },
    };
  }
  return {
    ok: true,
    data: {
      ...summary,
      id: toCanonicalResultId(
        summary.id || resultId,
        normalizeEntityType(summary.kind || "result")
      ),
      status: normalizeJobStatus(summary.status),
      kind: String(summary.kind || "")
        .trim()
        .toLowerCase(),
    },
  };
}

/**
 * Cancela un job preservando historial (no revierte envíos ok).
 */
export async function cancelJob(baseUrl, jobId) {
  if (!isSecureApiBase(baseUrl)) {
    return {
      ok: false,
      status: 0,
      error: {
        code: "HTTPS_REQUIRED",
        message: "La API debe usar HTTPS.",
      },
    };
  }
  const id = toCanonicalJobId(jobId, "job");
  if (!id) {
    return {
      ok: false,
      status: 400,
      error: {
        code: "JOB_ID_REQUIRED",
        message: "job_id inválido",
      },
    };
  }
  const path = API_PATHS.jobCancel(id);
  const result = await apiFetch(baseUrl, path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
  });
  if (!result.ok) {
    return {
      ok: false,
      status: result.status,
      error: buildServiceError(result, "JOB_CANCEL_FAILED", "No se pudo cancelar el job."),
    };
  }
  return { ok: true, data: result.data, status: result.status };
}

/**
 * Flows/jobs con destinatarios pendientes para la pestaña Enviar.
 */
export async function loadRecipientsJobsForSend(baseUrl, fromAccount = "") {
  const base = (baseUrl || "").trim().replace(/\/$/, "");
  if (!base) {
    return {
      ok: false,
      error: {
        code: "API_BASE_REQUIRED",
        message: "Configurá la conexión en Opciones.",
        status: 0,
      },
    };
  }
  if (!isSecureApiBase(base)) {
    return {
      ok: false,
      error: {
        code: "HTTPS_REQUIRED",
        message: "La API debe usar HTTPS.",
        status: 0,
      },
    };
  }

  const headers = await getAuthHeaders();
  if (!headers.Authorization) {
    return {
      ok: false,
      error: {
        code: "AUTH_REQUIRED",
        message: "Falta autenticación. Probá la conexión en Opciones.",
        status: 401,
      },
    };
  }

  const params = new URLSearchParams({ limit: "50" });
  const from = String(fromAccount || "").trim();
  if (from) params.set("from_account", from);
  const path = `${API_PATHS.recipientSources}?${params.toString()}`;

  try {
    const result = await apiFetch(base, path);
    if (!result.ok) {
      return {
        ok: false,
        error: buildServiceError(result, "RECIPIENT_SOURCES_FAILED", "Error al cargar resultados."),
      };
    }

    const data = unwrapApiData(result.data);

    const hasActiveWork = !!data?.has_active_work;
    if (hasActiveWork) {
      return {
        ok: true,
        data: {
          jobsWithPending: [],
          hasActiveWork: true,
          activeWork: {
            id: toCanonicalResultId(
              data?.active_work?.id || "",
              normalizeEntityType(data?.active_work?.kind || "job")
            ),
            kind: String(data?.active_work?.kind || "followings_flow"),
            status: normalizeJobStatus(data?.active_work?.status || "running"),
          },
        },
      };
    }

    const items = Array.isArray(data?.items) ? data.items : [];
    const jobsWithPending = items
      .map((item) => ({
        id: toCanonicalSourceId(
          item?.source_id || "",
          normalizeEntityType(item?.source_kind || "job")
        ),
        entity_type: normalizeEntityType(item?.source_kind || "job"),
        kind: String(item?.source_kind || ""),
        created_at: String(item?.created_at || ""),
        label: String(item?.label || "Origen"),
        pending: Number(item?.pending_count || 0) || 0,
        total: Number(item?.total_count || 0) || 0,
        status: normalizeJobStatus(item?.status || "completed"),
      }))
      .filter(
        (j) =>
          !!j.id &&
          j.pending > 0 &&
          ["followings_flow", "analyze_profile"].includes(String(j.kind || "").toLowerCase())
      );

    return {
      ok: true,
      data: {
        jobsWithPending,
      },
    };
  } catch {
    return {
      ok: false,
      error: {
        code: "NETWORK_ERROR",
        message: "Error de red al cargar resultados.",
        status: 0,
      },
    };
  }
}
