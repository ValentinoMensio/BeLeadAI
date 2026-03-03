/**
 * Controlador TAB Enviar: origen destinatarios, chips, encolar send, start/stop sender, progreso.
 */

import { API_PATHS } from "../../../config/endpoints.js";
import {
  isTerminalJobStatus,
  normalizeEntityType,
  normalizeJobStatus,
} from "../../../shared/domain/job-contract.js";

const SEND_PROGRESS_POLL_MS = 4000;
const SENDER_STATUS_POLL_MS = 3000;
const ENQUEUE_CLICK_GUARD_MS = 1200;
const RECIPIENTS_REFRESH_COOLDOWN_MS = 2500;
const CANCEL_JOB_RETRY_DELAYS_MS = [0, 1200, 3000];
const START_SENDER_CLICK_GUARD_MS = 1500;
const SEND_PROGRESS_STATUS_STICKY_MS = 7000;
const CANCEL_JOB_NON_RETRYABLE_CODES = new Set([
  "JOB_ID_REQUIRED",
  "AUTH_REQUIRED",
  "UNAUTHORIZED",
  "FORBIDDEN",
  "JOB_NOT_FOUND",
  "RESULT_ID_REQUIRED",
]);
const ACTIVE_CONFLICT_ERROR_CODES = new Set([
  "ACTIVE_JOB_BY_CLIENT",
  "ENQUEUE_LOCK_BUSY",
  "ACTIVE_SEND_JOB",
  "CONFLICT",
]);
const NO_PENDING_ERROR_CODES = new Set(["NO_PENDING_RECIPIENTS", "RECIPIENTS_ALREADY_MESSAGED"]);

/**
 * @param {{ store, services, ui, dom }} deps
 * @returns {{ restoreSendProgressFromCache, refreshRecipients, refreshSendProgress, getSelectedRecipients, bindSendEvents, startSender, stopSender, updateSenderStatus, stopSenderStatusPolling, stopSendProgressPolling, startSendProgressPolling }}
 */
export function initSendTab(deps) {
  const { store, services, ui, dom } = deps;
  const { getState, setState } = store;
  const { loadSettings, apiFetch, loadJobSummary, loadRecipientsJobsService, cancelJobService } =
    services;
  const {
    setSendStatus,
    setEnqueueSendEnabled,
    updateSendJobProgress,
    renderRecipients,
    updateRecipientsSummaryLabel,
    getLimitsData,
    refreshLimitsWithCache,
    formatJobDate,
    formatJobStatusLabel,
    isUnlimited,
  } = ui;
  const { qs, qsa } = dom;

  let refreshSendProgressInFlight = null;
  let refreshRecipientsInFlight = null;
  let lastRecipientsRefreshTs = 0;
  let enqueueSendInFlight = false;
  let lastEnqueueAttemptTs = 0;
  let startSenderInFlight = false;
  let lastStartSenderAttemptTs = 0;
  let sendProgressNullTicks = 0;
  let sendProgressStatusStickyUntil = 0;

  function markSendProgressStatusSticky(stats) {
    const queued = Number(stats?.queued || 0) || 0;
    const sent = Number(stats?.sent || 0) || 0;
    const ok = Number(stats?.ok || 0) || 0;
    const error = Number(stats?.error || 0) || 0;
    const total = queued + sent + ok + error;
    if (total > 0) {
      sendProgressStatusStickyUntil = Date.now() + SEND_PROGRESS_STATUS_STICKY_MS;
    }
  }

  function shouldKeepSendProgressMessage() {
    return Date.now() < sendProgressStatusStickyUntil;
  }

  function hasSendErrorVisible() {
    const el = qs("#send_status");
    return !!(el && el.classList.contains("err"));
  }

  function setSendInfoStatus(msg, { force = false, source = "generic" } = {}) {
    if (!msg) return;
    if (!force && source === "activity" && shouldKeepSendProgressMessage()) return;
    if (!force && hasSendErrorVisible()) return;
    setSendStatus(msg, false);
  }

  function updateSendSyncLabel() {
    const syncEl = qs("#send_last_sync");
    if (!syncEl) return;
    syncEl.textContent = `Ultima sincronizacion: ${new Date().toLocaleTimeString()}`;
  }

  async function waitMs(ms) {
    const delay = Math.max(0, Number(ms || 0));
    if (delay <= 0) return;
    await new Promise((resolve) => setTimeout(resolve, delay));
  }

  async function cancelJobWithRetry(baseUrl, jobId) {
    const id = String(jobId || "").trim();
    if (!id || !baseUrl || typeof cancelJobService !== "function") {
      return {
        ok: false,
        status: 0,
        error: "No se pudo cancelar el job en servidor.",
        attempts: 0,
      };
    }

    let lastResult = { ok: false, status: 0, error: "No se pudo cancelar el job en servidor." };
    for (let i = 0; i < CANCEL_JOB_RETRY_DELAYS_MS.length; i++) {
      await waitMs(CANCEL_JOB_RETRY_DELAYS_MS[i]);
      try {
        const result = await cancelJobService(baseUrl, id);
        if (result?.ok) {
          return { ...result, attempts: i + 1 };
        }
        lastResult = {
          ...(result || lastResult),
          error: result?.error?.message || result?.error || lastResult.error,
        };

        const errorCode = String(result?.error?.code || "")
          .trim()
          .toUpperCase();
        const status = Number(result?.status || 0);
        if (
          CANCEL_JOB_NON_RETRYABLE_CODES.has(errorCode) ||
          status === 401 ||
          status === 403 ||
          status === 404
        ) {
          return { ...lastResult, attempts: i + 1 };
        }
      } catch (e) {
        lastResult = {
          ok: false,
          status: 0,
          error: String(e?.message || "Error de red al cancelar"),
        };
      }
    }

    return { ...lastResult, attempts: CANCEL_JOB_RETRY_DELAYS_MS.length };
  }

  function describeSenderActivity(status) {
    if (!status?.isRunning) return "";
    const stage = String(status.progressStage || "").toLowerCase();
    if (stage === "cooldown_wait") {
      return `Esperando próximo envío (${status.timeUntilNextFormatted || "--:--"})`;
    }
    if (stage === "task_claimed") return "Tarea tomada. Preparando envío...";
    if (stage === "ws_tasks") return "Recibiendo tareas en tiempo real...";
    if (stage === "pull_ok") return "Buscando nuevas tareas en el servidor...";
    if (stage === "no_tasks_retry")
      return "No hay tareas por ahora. Reintentando automaticamente...";
    if (stage === "content_ack") return "Instagram respondió. Confirmando resultado...";
    if (stage === "thread_identity_skip")
      return "No se pudo validar un hilo. Saltando ese contacto y continuando...";
    if (stage === "recovery") return "Recuperando conexión y pestaña de Instagram...";
    if (stage === "result_reported") return "Resultado reportado. Continuando...";
    if (stage === "started") return "Sender iniciado. Preparando primer envío...";
    return "Sender en ejecución...";
  }

  function describeActiveWorkForSend(activeWork) {
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

  async function getFromAccountContext() {
    try {
      const r = await chrome.runtime.sendMessage({ action: "get_logged_in_username" });
      const username = String(r?.username || "").trim();
      const userId = r?.user_id != null ? String(r.user_id).trim() : "";
      return {
        sendFromAccount: userId || username,
      };
    } catch {
      return { sendFromAccount: "" };
    }
  }

  async function sha256Hex(text) {
    const input = String(text || "");
    if (globalThis.crypto?.subtle && globalThis.TextEncoder) {
      const bytes = new TextEncoder().encode(input);
      const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
      return Array.from(new Uint8Array(digest))
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
    }
    let hash = 2166136261;
    for (let i = 0; i < input.length; i++) {
      hash ^= input.charCodeAt(i);
      hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
    }
    return (hash >>> 0).toString(16).padStart(8, "0");
  }

  async function buildSendIdempotency(
    fromAccount,
    usernames,
    messageTemplate,
    sourceJobId,
    dryRun,
    useAi
  ) {
    const normalizedRecipients = [
      ...new Set(
        (usernames || [])
          .map((u) =>
            String(u || "")
              .trim()
              .toLowerCase()
          )
          .filter(Boolean)
      ),
    ].sort();
    const messageHash = await sha256Hex(String(messageTemplate || "").trim());
    const recipientIdempotencyKeys = {};
    for (const recipient of normalizedRecipients) {
      const perRecipientPayload = [
        String(fromAccount || "")
          .trim()
          .toLowerCase(),
        recipient,
        messageHash,
        dryRun ? "1" : "0",
        useAi ? "1" : "0",
      ].join("|");
      recipientIdempotencyKeys[recipient] = await sha256Hex(perRecipientPayload);
    }
    const keyPayload = [
      String(fromAccount || "")
        .trim()
        .toLowerCase(),
      String(sourceJobId || "").trim(),
      dryRun ? "1" : "0",
      useAi ? "1" : "0",
      messageHash,
      normalizedRecipients.join(","),
      String(Date.now()),
      Math.random().toString(36).slice(2),
    ].join("|");
    const idempotencyKey = await sha256Hex(keyPayload);
    return { idempotencyKey, messageHash, recipientIdempotencyKeys };
  }

  function normalizeCounter(value) {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? n : 0;
  }

  function normalizeSendSummary(raw) {
    if (!raw || typeof raw !== "object") return null;
    const queued = normalizeCounter(
      raw.queued ?? raw.pending ?? raw.pending_count ?? raw.queued_count
    );
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

  async function getLastSendJobId() {
    const data = await new Promise((r) =>
      chrome.storage.local.get({ last_send_job_id: null, dm_sender_current_job_id: null }, (d) =>
        r(d)
      )
    );
    const jobIdRaw = data.last_send_job_id || data.dm_sender_current_job_id || null;
    const jobId = normalizeJobId(jobIdRaw);
    if (jobId && jobId !== data.last_send_job_id) {
      chrome.storage.local.set({ last_send_job_id: jobId });
    }
    return jobId;
  }

  function normalizeJobId(value, kindHint = "job") {
    const raw = String(value || "").trim();
    if (!raw) return "";
    if (raw.includes(":")) return raw;
    const kind = normalizeEntityType(kindHint);
    if (kind === "flow") return `flow:${raw}`;
    return raw;
  }

  function isTerminalSendJobStatus(status) {
    return isTerminalJobStatus(status);
  }

  async function restoreSendProgressFromCache() {
    const data = await new Promise((r) =>
      chrome.storage.local.get({ last_send_job_id: null, last_send_job_stats: null }, (d) => r(d))
    );
    if (!data.last_send_job_id || !data.last_send_job_stats) return null;
    const stats = normalizeSendSummary(data.last_send_job_stats);
    if (!stats) return null;
    updateSendJobProgress(stats);
    return stats;
  }

  async function clearSendProgressCache() {
    await new Promise((resolve) => {
      chrome.storage.local.remove(["last_send_job_id", "last_send_job_stats"], () => resolve());
    });
  }

  function getSelectedRecipients() {
    return [...getState().selectedRecipientSet];
  }

  function getRecipientsKindLabel(st = getState()) {
    const kindLower = (st.selectedSendKind || "").toLowerCase();
    if (kindLower.includes("flow")) return "prospectos";
    if (kindLower.includes("analyze")) return "perfiles";
    return "followings";
  }

  function setRecipientsExpanded(expanded) {
    const listEl = qs("#send_recipients_list");
    const toggleEl = qs("#recipients_toggle");
    const actionsEl = document.getElementById("recipients_actions");
    const hasRecipients = (getState().selectedSendUsernames || []).length > 0;
    const open = !!expanded;
    if (toggleEl) toggleEl.setAttribute("aria-expanded", open ? "true" : "false");
    if (listEl) listEl.style.display = open && hasRecipients ? "flex" : "none";
    if (actionsEl) actionsEl.style.display = open && hasRecipients ? "flex" : "none";
  }

  function syncRecipientChipsFromState() {
    const listEl = qs("#send_recipients_list");
    if (!listEl) return;
    const selected = getState().selectedRecipientSet;
    qsa(".recipient-chip", listEl).forEach((chip) => {
      const username = String(chip?.dataset?.username || "").trim();
      const on = !!username && selected.has(username);
      chip.classList.toggle("selected", on);
      chip.classList.toggle("deselected", !on);
    });
  }

  function updateRecipientsSelectionUI() {
    const st = getState();
    const count = st.selectedRecipientSet.size;
    const total = st.selectedSendUsernames.length;
    const labelEl = document.getElementById("recipients_toggle_label");
    if (labelEl)
      labelEl.textContent =
        total > 0 ? `Ver y elegir destinatarios (${count}/${total})` : "Ver destinatarios";
    updateRecipientsSummaryLabel(
      qs("#send_recipients_summary"),
      total,
      count,
      getRecipientsKindLabel(st)
    );
    if (count > 0) {
      setSendInfoStatus(
        `${count} ${count === 1 ? "destinatario" : "destinatarios"} seleccionado${count === 1 ? "" : "s"}`
      );
      setEnqueueSendEnabled(true);
    } else {
      setSendInfoStatus("Marcá al menos un destinatario para enviar.");
      setEnqueueSendEnabled(false, "Sin destinatarios seleccionados.");
    }
  }

  function stopSendProgressPolling() {
    const s = getState();
    if (s.sendProgressInterval) {
      clearInterval(s.sendProgressInterval);
      setState({ sendProgressInterval: null });
    }
    sendProgressNullTicks = 0;
  }

  function startSendProgressPolling() {
    stopSendProgressPolling();
    const id = setInterval(async () => {
      const stats = await refreshSendProgress();
      if (!stats) {
        sendProgressNullTicks += 1;
        if (sendProgressNullTicks >= 2) {
          stopSendProgressPolling();
        }
        return;
      }
      sendProgressNullTicks = 0;
      if ((stats.queued || 0) + (stats.sent || 0) === 0) stopSendProgressPolling();
    }, SEND_PROGRESS_POLL_MS);
    setState({ sendProgressInterval: id });
  }

  async function refreshSendProgress() {
    if (refreshSendProgressInFlight) return refreshSendProgressInFlight;
    refreshSendProgressInFlight = (async () => {
      try {
        const jobId = await getLastSendJobId();
        if (!jobId) {
          setState({ pendingCancelableSendJobId: null });
          return null;
        }
        const cfg = await loadSettings();
        const base = (cfg.api_base || "").trim().replace(/\/+$/, "");
        if (!base) return null;
        const summary = await loadJobSummary(base, jobId);
        if (summary?.ok && summary?.data) {
          const stats = normalizeSendSummary(summary.data);
          updateSendJobProgress(stats);
          markSendProgressStatusSticky(stats);
          chrome.storage.local.set({ last_send_job_id: jobId, last_send_job_stats: stats });
          const st = getState();
          const queued = Number(stats.queued || 0) || 0;
          const sent = Number(stats.sent || 0) || 0;
          const inFlight = queued + sent > 0;
          const isTerminal = isTerminalSendJobStatus(stats.status);
          if (!inFlight && isTerminal) {
            setState({ pendingCancelableSendJobId: null });
          }
          let senderRunning = false;
          if (inFlight) {
            try {
              const senderStatus = await chrome.runtime.sendMessage({
                action: "get_sender_status",
              });
              senderRunning = !!senderStatus?.isRunning;
            } catch {
              senderRunning = false;
            }
          }

          if (inFlight && senderRunning) {
            setEnqueueSendEnabled(false, "Esperá a que termine el envío.");
          } else if (inFlight && !senderRunning) {
            setEnqueueSendEnabled(true);
            if (sent > 0 && queued === 0) {
              setSendInfoStatus("Hay envios pendientes de confirmacion.");
            }
          } else if ([...st.selectedRecipientSet].length > 0) {
            setEnqueueSendEnabled(true);
          } else {
            setEnqueueSendEnabled(false, "Sin destinatarios seleccionados.");
          }
          updateSendSyncLabel();
          return stats;
        }
        const summaryStatus = Number(summary?.error?.status || 0) || 0;
        const summaryCode = String(summary?.error?.code || "UNKNOWN")
          .trim()
          .toUpperCase();
        try {
          const restored = await restoreSendProgressFromCache();
          if (
            summaryStatus === 404 ||
            summaryStatus === 422 ||
            summaryCode === "RESULT_ID_REQUIRED"
          ) {
            await clearSendProgressCache();
            setState({ pendingCancelableSendJobId: null });
            updateSendSyncLabel();
            return restored || null;
          }
          if (!restored) {
            console.warn(
              "[send] No se pudo obtener summary de job:",
              jobId,
              summaryCode || summaryStatus || "UNKNOWN"
            );
          }
          updateSendSyncLabel();
          return restored;
        } catch (e) {
          console.warn("[send] No se pudo restaurar progreso desde cache:", e?.message || e);
          updateSendSyncLabel();
          return null;
        }
      } finally {
        refreshSendProgressInFlight = null;
      }
    })();
    return refreshSendProgressInFlight;
  }

  async function refreshRecipients(force = false) {
    const now = Date.now();
    if (!force && now - lastRecipientsRefreshTs < RECIPIENTS_REFRESH_COOLDOWN_MS) {
      return null;
    }
    if (refreshRecipientsInFlight) return refreshRecipientsInFlight;
    lastRecipientsRefreshTs = now;
    refreshRecipientsInFlight = (async () => {
      try {
        const cfg = await loadSettings();
        const base = (cfg.api_base || "").trim().replace(/\/+$/, "");
        if (!base) {
          setSendStatus("Configurá la conexión en Opciones.", true);
          return;
        }
        const sel = qs("#send_recipients_job_select");
        if (!sel) return;
        sel.innerHTML = '<option value="">— Cargando... —</option>';
        setSendInfoStatus("Cargando...", { source: "activity" });
        const recipientsResult = await loadRecipientsJobsService(base);
        sel.innerHTML = '<option value="">— Elegí un origen de destinatarios —</option>';
        sel.disabled = false;
        const prevCancelableJobId = normalizeJobId(getState().pendingCancelableSendJobId);
        setState({
          selectedSendJobId: null,
          selectedSendKind: null,
          selectedSendUsernames: [],
          selectedRecipientSet: new Set(),
          pendingCancelableSendJobId: prevCancelableJobId || null,
        });

        if (!recipientsResult?.ok) {
          setSendStatus(recipientsResult?.error?.message || "Error al cargar resultados.", true);
          sel.disabled = true;
          return;
        }

        const jobsWithPending = Array.isArray(recipientsResult?.data?.jobsWithPending)
          ? recipientsResult.data.jobsWithPending
          : [];
        const hasActiveWork = !!recipientsResult?.data?.hasActiveWork;
        const activeWork = recipientsResult?.data?.activeWork || null;

        if (hasActiveWork) {
          sel.disabled = true;
          const activeKind = String(activeWork?.kind || "").toLowerCase();
          const activeId = normalizeJobId(activeWork?.id, activeWork?.kind || "job");
          const cachedJobId = normalizeJobId(await getLastSendJobId());
          const pendingCancelableSendJobId = activeKind.includes("send")
            ? activeId || prevCancelableJobId || cachedJobId || null
            : prevCancelableJobId || cachedJobId || null;
          setState({ pendingCancelableSendJobId });
          setEnqueueSendEnabled(false, "Esperá a que termine el trabajo en curso.");
          setSendInfoStatus(describeActiveWorkForSend(activeWork), {
            force: true,
            source: "activity",
          });
          updateSenderStatus();
          const infoEl = qs("#send_recipients_info");
          if (infoEl) infoEl.style.display = "none";
          const listEl = qs("#send_recipients_list");
          if (listEl) {
            listEl.style.display = "none";
            listEl.innerHTML = "";
          }
          const actionsEl = document.getElementById("recipients_actions");
          if (actionsEl) actionsEl.style.display = "none";
          return;
        }

        if (prevCancelableJobId) {
          let keepCancelable = true;
          try {
            const prevSummary = await loadJobSummary(base, prevCancelableJobId);
            const prevStatus = prevSummary?.ok
              ? String(prevSummary?.data?.status || "")
                  .trim()
                  .toLowerCase()
              : "";
            if (prevStatus && isTerminalSendJobStatus(prevStatus)) {
              keepCancelable = false;
            }
          } catch (_) {
            keepCancelable = true;
          }
          if (!keepCancelable) {
            setState({ pendingCancelableSendJobId: null });
          }
        } else {
          setState({ pendingCancelableSendJobId: null });
        }

        jobsWithPending.forEach((j) => {
          const opt = document.createElement("option");
          opt.value = j.id;
          const resultadoUtil =
            j.pending != null ? `${j.pending} prospecto${j.pending === 1 ? "" : "s"}` : j.label;
          opt.textContent = [
            resultadoUtil,
            formatJobDate(j.created_at),
            formatJobStatusLabel((j.status || "").toLowerCase()),
          ]
            .filter(Boolean)
            .join(" · ");
          opt.dataset.kind = j.kind || "";
          sel.appendChild(opt);
        });

        const infoEl = qs("#send_recipients_info");
        if (infoEl) infoEl.style.display = "none";
        if (jobsWithPending.length === 0) {
          sel.disabled = true;
          setSendStatus(
            "Todavía no hay resultados listos para enviar. Esperá a que termine el job/flow de análisis.",
            true
          );
        } else {
          sel.disabled = false;
          setSendInfoStatus(
            `${jobsWithPending.length} origen${jobsWithPending.length === 1 ? "" : "es"} con pendientes. Elegí uno.`
          );
        }
      } finally {
        refreshRecipientsInFlight = null;
      }
    })();
    return refreshRecipientsInFlight;
  }

  async function onSendRecipientsJobChange(jobIdOrNull, kindOrNull) {
    const sel = qs("#send_recipients_job_select");
    const jobId = normalizeJobId(jobIdOrNull || (sel && sel.value) || null);
    const kind = kindOrNull || sel?.selectedOptions?.[0]?.dataset?.kind || null;
    if (!jobId) {
      setState({
        selectedSendJobId: null,
        selectedSendKind: null,
        selectedSendUsernames: [],
        selectedRecipientSet: new Set(),
      });
      const infoEl = qs("#send_recipients_info");
      if (infoEl) infoEl.style.display = "none";
      const listEl = qs("#send_recipients_list");
      if (listEl) {
        listEl.style.display = "none";
        listEl.innerHTML = "";
      }
      const actionsEl = document.getElementById("recipients_actions");
      if (actionsEl) actionsEl.style.display = "none";
      setRecipientsExpanded(false);
      updateRecipientsSelectionUI();
      return;
    }
    const cfg = await loadSettings();
    const base = (cfg.api_base || "").trim().replace(/\/+$/, "");
    if (!base) return;
    const path = API_PATHS.recipientSourceRecipients(jobId);
    const query = new URLSearchParams({ limit: "1000" }).toString();
    setSendInfoStatus("Cargando destinatarios...", { source: "activity" });
    try {
      const result = await apiFetch(base, `${path}?${query}`);
      if (!result.ok) {
        setSendStatus(result?.error?.message || "Error al cargar destinatarios.", true);
        return;
      }
      const data =
        result.data?.data && typeof result.data.data === "object" ? result.data.data : result.data;
      const usernames = data.usernames || [];
      console.log("[SEND] Recipients loaded", {
        jobId,
        usernamesCount: usernames.length,
        pending_count: data.pending_count,
        total: data.total,
      });
      setState({
        selectedSendJobId: normalizeJobId(jobId, kind || "job"),
        selectedSendKind: kind || "followings_flow",
        selectedSendUsernames: usernames,
        selectedRecipientSet: new Set(usernames),
      });
      console.log("[SEND] State after loading recipients", {
        selectedRecipientSetSize: getState().selectedRecipientSet.size,
      });
      const infoEl = qs("#send_recipients_info");
      if (infoEl) infoEl.style.display = "block";
      const listEl = qs("#send_recipients_list");
      const toggleEl = qs("#recipients_toggle");
      const actionsEl = document.getElementById("recipients_actions");
      const summaryEl = qs("#send_recipients_summary");
      const kindLower = (kind || "").toLowerCase();
      const kindLabel = kindLower.includes("flow")
        ? "prospectos"
        : kindLower.includes("analyze")
          ? "perfiles"
          : "followings";
      renderRecipients(
        { listEl, toggleEl, actionsEl, summaryEl },
        usernames,
        getState().selectedRecipientSet,
        () => {
          updateRecipientsSelectionUI();
        },
        kindLabel
      );
      setRecipientsExpanded(false);
      updateRecipientsSelectionUI();
    } catch (e) {
      setSendStatus("Error al cargar destinatarios", true);
    }
  }

  async function enqueueSendMessages() {
    console.log("[SEND] enqueueSendMessages START");
    const nowTs = Date.now();
    if (enqueueSendInFlight) {
      console.log("[SEND] enqueueSendInFlight blocked");
      setSendStatus("Ya hay una solicitud de encolado en curso. Esperá un momento.", true);
      return false;
    }
    if (nowTs - lastEnqueueAttemptTs < ENQUEUE_CLICK_GUARD_MS) {
      console.log("[SEND] click guard blocked");
      setSendStatus("Esperá un instante antes de volver a encolar.", true);
      return false;
    }
    enqueueSendInFlight = true;
    lastEnqueueAttemptTs = nowTs;
    console.log("[SEND] enqueueSendMessages proceeding");

    try {
      const cfg = await loadSettings();
      console.log("[SEND] settings loaded", { hasApiBase: !!cfg.api_base });
      if (!cfg.api_base) {
        setSendStatus("Configura la API en Opciones.", true);
        enqueueSendInFlight = false;
        return false;
      }
      const accountCtx = await getFromAccountContext();
      const fromAccount = String(accountCtx.sendFromAccount || "").trim();
      console.log("[SEND] fromAccount detected", { detected: !!fromAccount });
      if (!fromAccount) {
        setSendStatus(
          "Abrí Instagram en una pestaña e iniciá sesión para detectar la cuenta.",
          true
        );
        enqueueSendInFlight = false;
        return false;
      }
      const st = getState();
      const toSend = [...st.selectedRecipientSet];
      console.log("[SEND] toSend", {
        toSendCount: toSend.length,
        selectedSendJobId: st.selectedSendJobId,
      });
      if (!st.selectedSendJobId || toSend.length === 0) {
        setSendStatus("Elegí un origen de destinatarios y marcá al menos uno.", true);
        enqueueSendInFlight = false;
        return false;
      }
      const limitsData = getLimitsData();
      const remainingMonth = limitsData?.messages?.remaining_this_month;
      if (
        remainingMonth != null &&
        !isUnlimited(remainingMonth) &&
        toSend.length > remainingMonth
      ) {
        setSendStatus(
          `Tu plan permite ${remainingMonth} mensaje${remainingMonth === 1 ? "" : "s"} este mes. No podés encolar ${toSend.length}.`,
          true
        );
        return false;
      }
      const apiLimits = getState().apiLimits;
      const useChatgpt = qs("#use_chatgpt") ? qs("#use_chatgpt").checked : false;
      const message = (qs("#send_message") && qs("#send_message").value) || "";
      if (!useChatgpt) {
        if (!message.trim()) {
          setSendStatus("Escribe un mensaje o activá la IA.", true);
          return false;
        }
        if (message.length < apiLimits.min_message_length) {
          setSendStatus(
            `El mensaje es muy corto (mínimo ${apiLimits.min_message_length} caracteres).`,
            true
          );
          return false;
        }
        if (message.length > apiLimits.max_message_length) {
          setSendStatus(
            `El mensaje es muy largo (máximo ${apiLimits.max_message_length} caracteres).`,
            true
          );
          return false;
        }
      } else {
        const prompt = (cfg.chatgpt_prompt || "").trim();
        if (!prompt) {
          setSendStatus("Configurá el prompt de IA en Opciones.", true);
          return false;
        }
        if (prompt.length > apiLimits.max_client_prompt_length) {
          setSendStatus(
            `El prompt de IA es muy largo (máximo ${apiLimits.max_client_prompt_length} caracteres). Configuralo en Opciones.`,
            true
          );
          return false;
        }
      }
      console.log("[SEND] Validations passed", { useChatgpt, messageLength: message.length });
      const dryRun = qs("#dry_run") ? qs("#dry_run").checked : true;
      if (!dryRun && !confirm("Vas a enviar mensajes realmente. ¿Continuar?")) return false;

      const base = (cfg.api_base || "").trim().replace(/\/+$/, "");
      const dedupeMessageTemplate = useChatgpt ? (cfg.chatgpt_prompt || "").trim() : message;
      const { idempotencyKey, messageHash, recipientIdempotencyKeys } = await buildSendIdempotency(
        fromAccount,
        toSend,
        dedupeMessageTemplate,
        st.selectedSendJobId,
        dryRun,
        useChatgpt
      );
      setSendInfoStatus(useChatgpt ? "Encolando con IA..." : "Encolando mensajes...", {
        force: true,
      });
      setEnqueueSendEnabled(false, "Encolando...");
      console.log("[SEND] About to call send enqueue", {
        base,
        toSendCount: toSend.length,
        useChatgpt,
      });
      const result = await apiFetch(base, API_PATHS.sendEnqueue, {
        method: "POST",
        headers: {
          "Idempotency-Key": idempotencyKey,
        },
        body: {
          from_account: fromAccount,
          usernames: toSend,
          message_template: message || "",
          message_template_hash: messageHash,
          idempotency_key: idempotencyKey,
          idempotency_version: 2,
          recipient_idempotency_keys: recipientIdempotencyKeys,
          source_job_id: st.selectedSendJobId,
          dry_run: dryRun,
          use_ai: useChatgpt,
          client_prompt: useChatgpt ? (cfg.chatgpt_prompt || "").trim() : undefined,
        },
      });
      const payload =
        result.data?.data && typeof result.data.data === "object" ? result.data.data : result.data;
      console.log("[SEND] send enqueue result", {
        ok: result.ok,
        status: result.status,
        errorCode: result?.error?.code || null,
        jobId: payload?.job_id,
      });
      if (!result.ok) {
        const errorCode = String(result?.error?.code || result?.data?.error?.code || "")
          .trim()
          .toUpperCase();
        const blockingQuota =
          result?.error?.details?.blocking_quota ||
          result?.data?.error?.details?.blocking_quota ||
          "";
        const isActiveConflict =
          result.status === 409 &&
          (ACTIVE_CONFLICT_ERROR_CODES.has(errorCode) ||
            blockingQuota === "active_job_by_client" ||
            blockingQuota === "enqueue_lock_busy");
        if (isActiveConflict) {
          setEnqueueSendEnabled(false, "Esperá a que termine el trabajo en curso.");
          setSendInfoStatus(
            "Hay un trabajo en curso. Cuando termine, vas a poder encolar mensajes.",
            { force: true }
          );
          await refreshRecipients(true);
          return false;
        }
        const noPendingRecipients =
          result.status === 400 &&
          (NO_PENDING_ERROR_CODES.has(errorCode) || blockingQuota === "already_messaged");
        if (noPendingRecipients) {
          setSendInfoStatus("No hay pendientes: ya fueron enviados o están en cola.", {
            force: true,
          });
          setEnqueueSendEnabled(false, "No hay pendientes para encolar.");
        } else {
          setEnqueueSendEnabled(getSelectedRecipients().length > 0);
          setSendStatus(result?.error?.message || "Error", true);
        }
        return false;
      }
      const jobId = normalizeJobId(payload?.job_id || "");
      const total = payload?.total_items || 0;
      if (!jobId || total <= 0) {
        const deduped = Number(payload?.deduped_count || 0);
        if (deduped > 0) {
          setSendStatus(
            `No se encolaron mensajes: ${deduped} destinatario(s) ya estaban dedupeados para esta configuración.`,
            true
          );
        } else {
          setSendStatus("No se encolaron mensajes para los destinatarios seleccionados.", true);
        }
        setEnqueueSendEnabled(getSelectedRecipients().length > 0);
        return false;
      }
      chrome.storage.local.set({ last_send_job_id: jobId });
      if (typeof refreshLimitsWithCache === "function") refreshLimitsWithCache(true);
      setSendInfoStatus(`Encolados ${total} mensajes`, { force: true });
      const section = qs("#send_job_progress_section");
      if (section) section.style.display = "block";
      await onSendRecipientsJobChange(st.selectedSendJobId, st.selectedSendKind);
      const stats = await refreshSendProgress();
      if (stats && (stats.queued || 0) + (stats.sent || 0) > 0) startSendProgressPolling();
      return true;
    } finally {
      enqueueSendInFlight = false;
    }
  }

  async function startSender() {
    const now = Date.now();
    if (now - lastStartSenderAttemptTs < START_SENDER_CLICK_GUARD_MS) {
      setSendStatus("Esperá un momento antes de volver a iniciar.", true);
      return;
    }
    lastStartSenderAttemptTs = now;

    if (startSenderInFlight) {
      setSendStatus("El sender ya se está iniciando. Esperá un momento.", true);
      return;
    }
    startSenderInFlight = true;
    let senderStartedByThisCall = false;
    try {
      const selectedRecipients = getSelectedRecipients();
      const hasSelectedRecipients = selectedRecipients.length > 0;
      console.log("[SEND] startSender called", {
        hasSelectedRecipients,
        selectedRecipientsCount: selectedRecipients.length,
      });
      const startBtn = qs("#start_sender");
      if (startBtn) startBtn.disabled = true;

      if (hasSelectedRecipients) {
        setSendInfoStatus("Encolando mensajes...", { force: true });
        const ok = await enqueueSendMessages();
        if (!ok) {
          updateSenderStatus();
          return;
        }
      }

      setSendInfoStatus("Iniciando sender...", { force: true });
      const result = await chrome.runtime.sendMessage({
        action: "start_sender",
        defer_first_pull: false,
        allow_idle_start: hasSelectedRecipients,
      });
      console.log("[SEND] start_sender result", result);
      if (result?.status !== "started") {
        if (result?.status === "already_running" || result?.status === "starting") {
          setSendInfoStatus("El sender ya está en ejecución.", { force: true });
          if (hasSelectedRecipients) {
            try {
              await chrome.runtime.sendMessage({ action: "process_now" });
            } catch (_) {
              // best-effort trigger
            }
          }
          updateSenderStatus();
          return;
        }
        if (result?.status === "no_tasks") {
          setSendInfoStatus("Sin tareas pendientes", { force: true, source: "activity" });
          updateSenderStatus();
          return;
        }
        if (result?.status === "no_tasks_cooldown") {
          setSendInfoStatus("Sin tareas pendientes", { force: true, source: "activity" });
          updateSenderStatus();
          return;
        }
        if (result?.reason === "sender_offline") {
          setSendStatus(
            "No hay sender activo para esta cuenta. Abrí Instagram e iniciá sesión.",
            true
          );
        } else {
          setSendStatus("No se pudo iniciar el envío.", true);
        }
        return;
      }
      senderStartedByThisCall = true;

      if (!result?.prefetched_task) {
        try {
          await chrome.runtime.sendMessage({ action: "process_now" });
        } catch (_) {
          // best-effort trigger
        }
      }

      setSendInfoStatus("Envío iniciado", { force: true });
      updateSenderStatus();
    } catch (e) {
      setSendStatus("Error al iniciar el envío.", true);
      if (senderStartedByThisCall) {
        try {
          await chrome.runtime.sendMessage({ action: "stop_sender" });
        } catch (_) {}
      }
      updateSenderStatus();
    } finally {
      startSenderInFlight = false;
      updateSenderStatus();
    }
  }

  async function stopSender() {
    try {
      setSendInfoStatus("Deteniendo envío...", { force: true });
      let result = null;
      try {
        result = await chrome.runtime.sendMessage({ action: "stop_sender" });
      } catch (_) {
        result = null;
      }
      let canceledInfo = null;
      let canceledJobId = "";
      try {
        const stateJobId = String(getState().pendingCancelableSendJobId || "").trim();
        const cachedJobId = await getLastSendJobId();
        const jobId = stateJobId || cachedJobId;
        canceledJobId = jobId;
        if (jobId) {
          const cfg = await loadSettings();
          const base = (cfg.api_base || "").trim().replace(/\/+$/, "");
          if (base) {
            canceledInfo = await cancelJobWithRetry(base, jobId);
          }
        }
      } catch (e) {
        canceledInfo = {
          ok: false,
          status: 0,
          error: String(e?.message || "Error de red al cancelar"),
          attempts: 0,
        };
      }

      if (canceledInfo?.ok && canceledInfo?.data?.cancel) {
        const sentConfirmed = Number(canceledInfo.data.cancel.sent_confirmed || 0);
        setSendInfoStatus(`Envío detenido. Job cancelado (ya enviados: ${sentConfirmed}).`, {
          force: true,
        });
        setState({ pendingCancelableSendJobId: null });
      } else if (canceledJobId) {
        const attempts = Number(canceledInfo?.attempts || CANCEL_JOB_RETRY_DELAYS_MS.length);
        const reason = String(
          canceledInfo?.error || "No se pudo cancelar el job en el servidor."
        ).trim();
        setState({ pendingCancelableSendJobId: canceledJobId });
        setSendStatus(
          `Envío detenido en la extensión, pero falló la cancelación remota tras ${attempts} intento(s): ${reason}. Reintentá "Detener envío".`,
          true
        );
      } else if (result?.status === "stopped") {
        setSendInfoStatus("Listo", { force: true });
      } else {
        setSendInfoStatus("Envío detenido en la extensión.", { force: true });
      }

      updateSenderStatus();
      const st = getState();
      await refreshSendProgress();
      await refreshRecipients();
      const sel = qs("#send_recipients_job_select");
      if (st.selectedSendJobId && sel) {
        sel.value = st.selectedSendJobId;
        await onSendRecipientsJobChange(st.selectedSendJobId, st.selectedSendKind);
      }
    } catch (e) {
      setSendStatus("Error al detener el envío.", true);
    }
  }

  function stopSenderStatusPolling() {
    const s = getState();
    if (s.senderStatusInterval) {
      clearInterval(s.senderStatusInterval);
      setState({ senderStatusInterval: null });
    }
  }

  function startSenderStatusPolling() {
    const s = getState();
    if (s.senderStatusInterval) return;
    const intervalId = setInterval(() => {
      updateSenderStatus();
    }, SENDER_STATUS_POLL_MS);
    setState({ senderStatusInterval: intervalId });
  }

  async function updateSenderStatus() {
    try {
      const status = await chrome.runtime.sendMessage({ action: "get_sender_status" });
      const startBtn = qs("#start_sender");
      const stopBtn = qs("#stop_sender");

      const st = getState();
      const stateCancelableId = normalizeJobId(st.pendingCancelableSendJobId);
      const taskCancelableId = normalizeJobId(status?.currentTask?.job_id);
      const resolvedCancelableId = stateCancelableId || taskCancelableId;
      const hasCancelablePending = !!resolvedCancelableId;

      if (resolvedCancelableId && resolvedCancelableId !== stateCancelableId) {
        setState({ pendingCancelableSendJobId: resolvedCancelableId });
      }

      if (!status) {
        if (startBtn) startBtn.disabled = false;
        if (stopBtn) stopBtn.disabled = !hasCancelablePending;
        return;
      }
      updateSendSyncLabel();
      if (status.isRunning) {
        if (startBtn) startBtn.disabled = true;
        if (stopBtn) stopBtn.disabled = false;
        startSenderStatusPolling();
        const activity = describeSenderActivity(status);
        if (activity) {
          setSendInfoStatus(activity, { source: "activity" });
        }
      } else {
        const cooldownMs = Math.max(0, Number(status?.noTasksRestartCooldownMs || 0));
        if (startBtn) startBtn.disabled = cooldownMs > 0;
        if (stopBtn) stopBtn.disabled = !hasCancelablePending;
        if (cooldownMs > 0) {
          startSenderStatusPolling();
        } else {
          stopSenderStatusPolling();
        }
        setSendInfoStatus("Sin tareas pendientes", { source: "activity" });
      }
    } catch {
      stopSenderStatusPolling();
      const st = getState();
      const hasCancelablePending = !!String(st.pendingCancelableSendJobId || "").trim();
      const startBtn = qs("#start_sender");
      const stopBtn = qs("#stop_sender");
      if (startBtn) startBtn.disabled = false;
      if (stopBtn) stopBtn.disabled = !hasCancelablePending;
    }
  }

  function bindSendEvents() {
    const cleanupFns = [];

    const sendMessageInput = qs("#send_message");
    const useChatgptCheckbox = qs("#use_chatgpt");
    const sendMessageHint = qs("#send_message_hint");
    const apiLimits = getState().apiLimits;

    function updateMessageHint() {
      const useChatgpt = useChatgptCheckbox ? useChatgptCheckbox.checked : false;
      const count = sendMessageInput ? sendMessageInput.value.length : 0;
      const maxMsg = apiLimits.max_message_length;
      const countEl = qs("#message_char_count");
      if (countEl) countEl.textContent = count;
      if (sendMessageInput) {
        sendMessageInput.placeholder = useChatgpt
          ? "Opcional: agregá contexto o indicaciones adicionales para que la IA genere el mensaje."
          : "Escribe el mensaje que querés enviar...";
      }
      if (sendMessageHint) sendMessageHint.textContent = `Caracteres: ${count}/${maxMsg}`;
    }

    if (sendMessageInput) {
      sendMessageInput.maxLength = apiLimits.max_message_length;
      sendMessageInput.addEventListener("input", updateMessageHint);
      cleanupFns.push(() => sendMessageInput.removeEventListener("input", updateMessageHint));
    }
    if (useChatgptCheckbox) {
      useChatgptCheckbox.addEventListener("change", updateMessageHint);
      cleanupFns.push(() => useChatgptCheckbox.removeEventListener("change", updateMessageHint));
    }
    updateMessageHint();

    const sendRecipientsSelect = qs("#send_recipients_job_select");
    if (sendRecipientsSelect) {
      const onRecipientsChange = () => {
        const opt = sendRecipientsSelect.options[sendRecipientsSelect.selectedIndex];
        onSendRecipientsJobChange(sendRecipientsSelect.value, opt?.dataset?.kind);
      };
      sendRecipientsSelect.addEventListener("change", onRecipientsChange);
      cleanupFns.push(() => sendRecipientsSelect.removeEventListener("change", onRecipientsChange));
    }

    const recipientsToggle = qs("#recipients_toggle");
    if (recipientsToggle) {
      const onToggleClick = () => {
        const expanded = recipientsToggle.getAttribute("aria-expanded") === "true";
        setRecipientsExpanded(!expanded);
      };
      recipientsToggle.addEventListener("click", onToggleClick);
      cleanupFns.push(() => recipientsToggle.removeEventListener("click", onToggleClick));
    }

    const selectAllBtn = document.querySelector("[data-action=select-all]");
    const deselectAllBtn = document.querySelector("[data-action=deselect-all]");
    if (selectAllBtn) {
      const onSelectAll = () => {
        const st = getState();
        st.selectedRecipientSet.clear();
        st.selectedSendUsernames.forEach((u) => st.selectedRecipientSet.add(u));
        syncRecipientChipsFromState();
        updateRecipientsSelectionUI();
      };
      selectAllBtn.addEventListener("click", onSelectAll);
      cleanupFns.push(() => selectAllBtn.removeEventListener("click", onSelectAll));
    }
    if (deselectAllBtn) {
      const onDeselectAll = () => {
        const st = getState();
        st.selectedRecipientSet.clear();
        syncRecipientChipsFromState();
        updateRecipientsSelectionUI();
      };
      deselectAllBtn.addEventListener("click", onDeselectAll);
      cleanupFns.push(() => deselectAllBtn.removeEventListener("click", onDeselectAll));
    }

    const startSenderBtn = qs("#start_sender");
    if (startSenderBtn) {
      startSenderBtn.addEventListener("click", startSender);
      cleanupFns.push(() => startSenderBtn.removeEventListener("click", startSender));
    }

    const stopSenderBtn = qs("#stop_sender");
    if (stopSenderBtn) {
      stopSenderBtn.addEventListener("click", stopSender);
      cleanupFns.push(() => stopSenderBtn.removeEventListener("click", stopSender));
    }

    function cleanup() {
      stopSendProgressPolling();
      stopSenderStatusPolling();
      cleanupFns.forEach((fn) => fn());
    }
    return cleanup;
  }

  return {
    restoreSendProgressFromCache,
    refreshRecipients,
    refreshSendProgress,
    getSelectedRecipients,
    bindSendEvents,
    startSender,
    stopSender,
    updateSenderStatus,
    stopSenderStatusPolling,
    stopSendProgressPolling,
    startSendProgressPolling,
    onSendRecipientsJobChange,
  };
}
