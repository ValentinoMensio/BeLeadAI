/**
 * Controlador TAB Enviar: origen destinatarios, chips, encolar send, start/stop sender, progreso.
 */

import { logApiErrorDiagnostic } from "../../../shared/errors/error-diagnostics.js";
import { sha256Hex } from "../../../shared/utils/idempotency.js";
import { normalizeJobStatus } from "../../../shared/domain/job-contract.js";
import { createSendEnqueueController } from "./send-enqueue-controller.js";
import { createSendProgressController } from "./send-progress-controller.js";
import { createSendRecipientsController } from "./send-recipients-controller.js";
import { createSendSenderController } from "./send-sender-controller.js";
import {
  describeActiveWorkForSend,
  getRetryAfterSec,
  getSenderRuntimeContext,
  isTerminalSendJobStatus,
  normalizeJobId,
  normalizeSendSummary,
  waitMs,
} from "./send-shared.js";

const SEND_PROGRESS_POLL_MS = 6000;
const SENDER_STATUS_POLL_MS = 5000;
const ENQUEUE_CLICK_GUARD_MS = 1200;
const RECIPIENTS_REFRESH_COOLDOWN_MS = 6000;
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
  const {
    getState,
    setState,
    getSelectedRecipientUsernames,
    getSelectedRecipientCount,
    isRecipientSelected,
    setSendRecipientContext,
    clearSendRecipientContext,
  } = store;
  const {
    loadSettings,
    apiFetch,
    fetchPing,
    loadJobSummary,
    loadRecipientsJobsService,
    loadRecipientSourceRecipientsPage,
    cancelJobService,
  } = services;
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

  let refreshRecipientsInFlight = null;
  let lastRecipientsRefreshTs = 0;
  let sendProgressStatusStickyUntil = 0;
  let sendApiBackoffUntil = 0;
  let lastRateLimitRecipientsLogTs = 0;
  const enqueueState = {
    inFlight: false,
    lastAttemptTs: 0,
    lastBlockingQuota: "",
  };
  let cancelableReconcileInFlight = null;
  let lastCancelableReconcileTs = 0;
  const runtimeState = {
    refreshSendProgressInFlight: null,
    startSenderInFlight: false,
    lastStartSenderAttemptTs: 0,
    sendProgressNullTicks: 0,
    lastRateLimitProgressLogTs: 0,
  };

  const recipientsController = createSendRecipientsController({
    store,
    services: { loadSettings, loadRecipientSourceRecipientsPage },
    ui: { setSendStatus, renderRecipients },
    dom,
    helpers: {
      normalizeJobId,
      setRecipientsExpanded,
      updateRecipientsSelectionUI,
      setSendInfoStatus,
      syncRecipientChipsFromState,
    },
  });

  const enqueueController = createSendEnqueueController({
    store,
    services: { loadSettings, apiFetch },
    ui: {
      setSendStatus,
      setEnqueueSendEnabled,
      getLimitsData,
      refreshLimitsWithCache,
      isUnlimited,
    },
    dom,
    config: {
      enqueueClickGuardMs: ENQUEUE_CLICK_GUARD_MS,
    },
    runtime: {
      activeConflictErrorCodes: ACTIVE_CONFLICT_ERROR_CODES,
      noPendingErrorCodes: NO_PENDING_ERROR_CODES,
      onSendRecipientsJobChange: (...args) => recipientsController.onSendRecipientsJobChange(...args),
    },
    helpers: {
      getSelectedRecipients,
      getFromAccountContext,
      buildSendIdempotency,
      setSendInfoStatus,
      refreshRecipients,
      refreshSendProgress,
      startSendProgressPolling,
      normalizeJobId,
    },
    enqueueState,
  });

  let progressController = null;
  let senderController = null;

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

  function applySendApiBackoff(result) {
    const status = Number(result?.status || result?.error?.status || 0) || 0;
    if (status !== 429 && status !== 503) return 0;
    const retryAfterSec = getRetryAfterSec(result);
    const floorSec = status === 429 ? 4 : 2;
    const backoffSec = Math.max(floorSec, retryAfterSec || 0);
    if (backoffSec <= 0) return 0;
    const until = Date.now() + backoffSec * 1000;
    sendApiBackoffUntil = Math.max(sendApiBackoffUntil, until);
    return backoffSec;
  }

  function hasSendApiBackoff(force = false) {
    if (force) return false;
    return sendApiBackoffUntil > Date.now();
  }

  async function cancelJobWithRetry(baseUrl, jobId) {
    const id = String(jobId || "").trim();
    if (!id || !baseUrl || typeof cancelJobService !== "function") {
      return {
        ok: false,
        status: 0,
        errorMessage: "No se pudo cancelar el job en servidor.",
        error: "No se pudo cancelar el job en servidor.",
        attempts: 0,
      };
    }

    let lastResult = {
      ok: false,
      status: 0,
      errorMessage: "No se pudo cancelar el job en servidor.",
      error: "No se pudo cancelar el job en servidor.",
    };
    for (let i = 0; i < CANCEL_JOB_RETRY_DELAYS_MS.length; i++) {
      await waitMs(CANCEL_JOB_RETRY_DELAYS_MS[i]);
      try {
        const result = await cancelJobService(baseUrl, id);
        if (result?.ok) {
          return { ...result, attempts: i + 1 };
        }
        lastResult = {
          ...(result || lastResult),
          errorMessage: result?.errorMessage || lastResult.errorMessage,
          error: result?.errorMessage || result?.error?.code || result?.error || lastResult.error,
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
          errorMessage: String(e?.message || "Error de red al cancelar"),
          error: String(e?.message || "Error de red al cancelar"),
        };
      }
    }

    return { ...lastResult, attempts: CANCEL_JOB_RETRY_DELAYS_MS.length };
  }

  async function reconcilePendingCancelableJobId(status) {
    const running = !!status?.isRunning;
    if (running) return;
    const st = getState();
    const stateCancelableId = normalizeJobId(st.pendingCancelableSendJobId);
    const taskCancelableId = normalizeJobId(status?.currentTask?.job_id);
    if (!stateCancelableId || taskCancelableId) return;

    const now = Date.now();
    if (cancelableReconcileInFlight) {
      await cancelableReconcileInFlight;
      return;
    }
    if (now - lastCancelableReconcileTs < 3500) return;
    lastCancelableReconcileTs = now;

    cancelableReconcileInFlight = (async () => {
      try {
        const cfg = await loadSettings();
        const base = (cfg?.api_base || "").trim().replace(/\/+$/, "");
        if (!base) return;
        const summary = await loadJobSummary(base, stateCancelableId);
        const statusCode = Number(summary?.status || summary?.error?.status || 0) || 0;
        if (statusCode === 404 || statusCode === 422) {
          setState({ pendingCancelableSendJobId: null });
          return;
        }
        if (!summary?.ok) return;
        const jobStatus = normalizeJobStatus(summary?.data?.status);
        if (jobStatus && isTerminalSendJobStatus(jobStatus)) {
          setState({ pendingCancelableSendJobId: null });
        }
      } catch {
        // best-effort reconciliation
      }
    })();

    try {
      await cancelableReconcileInFlight;
    } finally {
      cancelableReconcileInFlight = null;
    }
  }

  async function getFromAccountContext() {
    const cfg = await loadSettings();
    try {
      const senderCtx = await getSenderRuntimeContext();
      if (senderCtx.fromAccount) {
        return {
          sendFromAccount: senderCtx.fromAccount,
        };
      }
    } catch {}
    try {
      const r = await chrome.runtime.sendMessage({ action: "get_logged_in_username" });
      const username = String(r?.username || "")
        .trim()
        .toLowerCase();
      const userId = String(r?.user_id || "").trim();
      if (username || userId) {
        return {
          sendFromAccount: username || userId,
        };
      }
    } catch {}
    try {
      const ping = await fetchPing(cfg);
      const accountUsername = String(ping?.accountUsername || "")
        .trim()
        .toLowerCase();
      return {
        sendFromAccount: accountUsername,
      };
    } catch {
      return { sendFromAccount: "" };
    }
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
    return getSelectedRecipientUsernames();
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
    const hasRecipients = (getState().visibleRecipientUsernames || []).length > 0;
    const open = !!expanded;
    if (toggleEl) toggleEl.setAttribute("aria-expanded", open ? "true" : "false");
    if (listEl) listEl.style.display = open && hasRecipients ? "flex" : "none";
    if (actionsEl) actionsEl.style.display = open && hasRecipients ? "flex" : "none";
  }

  function syncRecipientChipsFromState() {
    const listEl = qs("#send_recipients_list");
    if (!listEl) return;
    qsa(".recipient-chip", listEl).forEach((chip) => {
      const username = String(chip?.dataset?.username || "").trim();
      const on = !!username && isRecipientSelected(username);
      chip.classList.toggle("selected", on);
      chip.classList.toggle("deselected", !on);
    });
  }

  function updateRecipientsSelectionUI() {
    const st = getState();
    const count = getSelectedRecipientCount();
    const total = Number(st.recipientMatchedCount || st.recipientTotalCount || st.visibleRecipientUsernames.length || 0);
    const labelEl = document.getElementById("recipients_toggle_label");
    if (labelEl)
      labelEl.textContent =
        total > 0 ? `Ver destinatarios cargados (${count}/${total})` : "Ver destinatarios";
    updateRecipientsSummaryLabel(
      qs("#send_recipients_summary"),
      total,
      count,
      getRecipientsKindLabel(st),
      {
        matchedCount: st.recipientMatchedCount || st.recipientTotalCount || 0,
        visibleCount: Array.isArray(st.visibleRecipientUsernames) ? st.visibleRecipientUsernames.length : 0,
      }
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
    return progressController?.stopSendProgressPolling();
  }

  function startSendProgressPolling() {
    return progressController?.startSendProgressPolling(refreshSendProgress);
  }

  async function refreshSendProgress(force = false) {
    return progressController?.refreshSendProgress(force) || null;
  }

  async function refreshRecipients(force = false) {
    const now = Date.now();
    if (hasSendApiBackoff(force)) {
      return null;
    }
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
        const loadingOption = document.createElement("option");
        loadingOption.value = "";
        loadingOption.textContent = "— Cargando... —";
        sel.replaceChildren(loadingOption);
        setSendInfoStatus("Cargando...", { source: "activity" });
        const recipientsResult = await loadRecipientsJobsService(base);
        const placeholderOption = document.createElement("option");
        placeholderOption.value = "";
        placeholderOption.textContent = "— Elegí un origen de destinatarios —";
        sel.replaceChildren(placeholderOption);
        sel.disabled = false;
        const st = getState();
        const previousSelectedJobId = normalizeJobId(st.selectedSendJobId);
        const previousSelectedKind = st.selectedSendKind || null;
        const previousVisibleUsernames = Array.isArray(st.visibleRecipientUsernames)
          ? [...st.visibleRecipientUsernames]
          : [];
        const previousSelectedRecipients = getSelectedRecipientUsernames();
        const previousQuery = String(st.recipientQuery || "");
        const previousNextCursor = st.recipientNextCursor || null;
        const previousHasMore = !!st.recipientHasMore;
        const previousTotalCount = Number(st.recipientTotalCount || 0) || 0;
        const previousMatchedCount = Number(st.recipientMatchedCount || 0) || 0;
        const prevCancelableJobId = normalizeJobId(getState().pendingCancelableSendJobId);

        if (!recipientsResult?.ok) {
          const backoffSec = applySendApiBackoff(recipientsResult);
          const status =
            Number(recipientsResult?.status || recipientsResult?.error?.status || 0) || 0;
          const nowTs = Date.now();
          const isRateLimited = status === 429 || status === 503;
          if (!isRateLimited || nowTs - lastRateLimitRecipientsLogTs >= 12000) {
            logApiErrorDiagnostic("send.refresh_recipients.failed", recipientsResult, {
              backoffSec,
            });
            if (isRateLimited) lastRateLimitRecipientsLogTs = nowTs;
          }
          setSendStatus(recipientsResult?.errorMessage || "Error al cargar resultados.", true);
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
            listEl.replaceChildren();
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
          } catch {
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

        const stillHasPreviousSelection =
          !!previousSelectedJobId && jobsWithPending.some((job) => job.id === previousSelectedJobId);
        if (stillHasPreviousSelection) {
          sel.value = previousSelectedJobId;
          setSendRecipientContext({
            jobId: previousSelectedJobId,
            kind: previousSelectedKind,
            visibleUsernames: previousVisibleUsernames,
            selectedUsernames: previousSelectedRecipients,
            query: previousQuery,
            nextCursor: previousNextCursor,
            hasMore: previousHasMore,
            totalCount: previousTotalCount,
            matchedCount: previousMatchedCount,
          });
          setState({ pendingCancelableSendJobId: prevCancelableJobId || null });
        } else {
          clearSendRecipientContext();
          setState({ pendingCancelableSendJobId: prevCancelableJobId || null });
        }

        const infoEl = qs("#send_recipients_info");
        if (infoEl) infoEl.style.display = stillHasPreviousSelection ? "block" : "none";
        if (jobsWithPending.length === 0) {
          sel.disabled = true;
          setSendStatus(
            "Todavía no hay resultados listos para enviar. Esperá a que termine el job/flow de análisis.",
            true
          );
        } else {
          sel.disabled = false;
          if (stillHasPreviousSelection) {
            updateRecipientsSelectionUI();
            setSendInfoStatus(
              `${jobsWithPending.length} origen${jobsWithPending.length === 1 ? "" : "es"} con pendientes. Mantuvimos tu selección.`
            );
          } else {
            setSendInfoStatus(
              `${jobsWithPending.length} origen${jobsWithPending.length === 1 ? "" : "es"} con pendientes. Elegí uno.`
            );
          }
        }
      } finally {
        refreshRecipientsInFlight = null;
      }
    })();
    return refreshRecipientsInFlight;
  }

  progressController = createSendProgressController({
    store,
    services: { loadSettings, loadJobSummary },
    ui: { setEnqueueSendEnabled, updateSendJobProgress },
    helpers: {
      hasSendApiBackoff,
      restoreSendProgressFromCache,
      getLastSendJobId,
      markSendProgressStatusSticky,
      updateSendSyncLabel,
      applySendApiBackoff,
      clearSendProgressCache,
      setSendInfoStatus,
    },
    config: { sendProgressPollMs: SEND_PROGRESS_POLL_MS },
    state: runtimeState,
  });

  const { onSendRecipientsJobChange } = recipientsController;

  const { enqueueSendMessages } = enqueueController;

  async function startSender() {
    return senderController?.startSender();
  }

  async function stopSender() {
    return senderController?.stopSender();
  }

  function stopSenderStatusPolling() {
    return senderController?.stopSenderStatusPolling();
  }

  function startSenderStatusPolling() {
    return senderController?.startSenderStatusPolling(updateSenderStatus);
  }

  async function updateSenderStatus() {
    return senderController?.updateSenderStatus();
  }

  senderController = createSendSenderController({
    store,
    services: { loadSettings },
    ui: { setSendStatus },
    dom,
    config: {
      startSenderClickGuardMs: START_SENDER_CLICK_GUARD_MS,
      senderStatusPollMs: SENDER_STATUS_POLL_MS,
      cancelJobRetryDelaysMs: CANCEL_JOB_RETRY_DELAYS_MS,
    },
    runtime: {
      enqueueSendMessages,
      getLastEnqueueBlockingQuota: () => enqueueController.getLastEnqueueBlockingQuota(),
      waitMs,
      updateSenderStatus,
      getLastSendJobId,
      cancelJobWithRetry,
      refreshSendProgress,
      refreshRecipients,
      onSendRecipientsJobChange: (...args) => recipientsController.onSendRecipientsJobChange(...args),
      reconcilePendingCancelableJobId,
      updateSendSyncLabel,
    },
    state: runtimeState,
    helpers: {
      getSelectedRecipients,
      getFromAccountContext,
      setSendInfoStatus,
    },
  });

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
      const onSelectAll = () => recipientsController.selectAllRecipients();
      selectAllBtn.addEventListener("click", onSelectAll);
      cleanupFns.push(() => selectAllBtn.removeEventListener("click", onSelectAll));
    }
    if (deselectAllBtn) {
      const onDeselectAll = () => recipientsController.deselectAllRecipients();
      deselectAllBtn.addEventListener("click", onDeselectAll);
      cleanupFns.push(() => deselectAllBtn.removeEventListener("click", onDeselectAll));
    }
    const recipientsSearch = qs("#send_recipients_search");
    if (recipientsSearch) {
      const onSearchInput = () => recipientsController.onRecipientsSearchInput();
      recipientsSearch.addEventListener("input", onSearchInput);
      cleanupFns.push(() => recipientsSearch.removeEventListener("input", onSearchInput));
    }
    const loadMoreBtn = qs("#recipients_load_more");
    if (loadMoreBtn) {
      const onLoadMore = () => recipientsController.loadMoreRecipients();
      loadMoreBtn.addEventListener("click", onLoadMore);
      cleanupFns.push(() => loadMoreBtn.removeEventListener("click", onLoadMore));
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
    startSenderStatusPolling,
  };
}
