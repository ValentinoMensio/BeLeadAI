import { API_PATHS } from "../../../config/endpoints.js";
import { logApiErrorDiagnostic } from "../../../shared/errors/error-diagnostics.js";

export function createSendEnqueueController(deps) {
  const {
    store,
    services,
    ui,
    dom,
    config,
    runtime,
    helpers,
    enqueueState,
  } = deps;
  const { getState, getSelectedRecipientUsernames } = store;
  const { loadSettings, apiFetch } = services;
  const { setSendStatus, setEnqueueSendEnabled, getLimitsData, refreshLimitsWithCache, isUnlimited } = ui;
  const { qs } = dom;
  const {
    getSelectedRecipients,
    getFromAccountContext,
    buildSendIdempotency,
    setSendInfoStatus,
    refreshRecipients,
    refreshSendProgress,
    startSendProgressPolling,
    normalizeJobId,
  } = helpers;

  function setBlockingQuota(value) {
    enqueueState.lastBlockingQuota = String(value || "")
      .trim()
      .toLowerCase();
  }

  function setConfirmModalOpen(open) {
    const modal = qs("#send_confirm_modal");
    if (!modal) return;
    modal.classList.toggle("is-hidden", !open);
    modal.setAttribute("aria-hidden", open ? "false" : "true");
  }

  async function confirmRealSend({ fromAccount, selectedCount, useChatgpt }) {
    const modal = qs("#send_confirm_modal");
    const bodyEl = qs("#send_confirm_body");
    const acceptBtn = qs("#send_confirm_accept");
    const cancelBtn = qs("#send_confirm_cancel");
    if (!modal || !bodyEl || !acceptBtn || !cancelBtn) return false;

    bodyEl.textContent = `Vas a enviar ${selectedCount} mensaje${selectedCount === 1 ? "" : "s"} real${selectedCount === 1 ? "" : "es"} desde @${fromAccount}${useChatgpt ? " usando IA" : ""}. Esta acción consume cuota y no es simulada.`;
    return await new Promise((resolve) => {
      const close = (accepted) => {
        setConfirmModalOpen(false);
        acceptBtn.removeEventListener("click", onAccept);
        cancelBtn.removeEventListener("click", onCancel);
        modal.removeEventListener("click", onBackdrop);
        document.removeEventListener("keydown", onKeyDown);
        resolve(accepted);
      };
      const onAccept = () => close(true);
      const onCancel = () => close(false);
      const onBackdrop = (event) => {
        if (event.target?.dataset?.action === "close-send-confirm") close(false);
      };
      const onKeyDown = (event) => {
        if (event.key === "Escape") close(false);
      };
      acceptBtn.addEventListener("click", onAccept);
      cancelBtn.addEventListener("click", onCancel);
      modal.addEventListener("click", onBackdrop);
      document.addEventListener("keydown", onKeyDown);
      setConfirmModalOpen(true);
      acceptBtn.focus();
    });
  }

  async function enqueueSendMessages(options = {}) {
    const force = !!options.force;
    const fromAccountOverride = String(options.fromAccountOverride || "")
      .trim()
      .toLowerCase();
    const nowTs = Date.now();
    setBlockingQuota("");
    if (enqueueState.inFlight) {
      setSendStatus("Ya hay una solicitud de encolado en curso. Esperá un momento.", true);
      return false;
    }
    if (!force && nowTs - enqueueState.lastAttemptTs < config.enqueueClickGuardMs) {
      setSendStatus("Esperá un instante antes de volver a encolar.", true);
      return false;
    }
    enqueueState.inFlight = true;
    enqueueState.lastAttemptTs = nowTs;
    try {
      const cfg = await loadSettings();
      if (!cfg.api_base) {
        setSendStatus("Configura la API en Opciones.", true);
        return false;
      }
      const accountCtx = await getFromAccountContext();
      const fromAccount = String(fromAccountOverride || accountCtx.sendFromAccount || "")
        .trim()
        .toLowerCase();
      if (!fromAccount) {
        setSendStatus(
          "Abrí Instagram en una pestaña e iniciá sesión para detectar la cuenta.",
          true
        );
        return false;
      }
      const st = getState();
      const toSend = getSelectedRecipientUsernames();
      if (!st.selectedSendJobId || toSend.length === 0) {
        setSendStatus("Elegí un origen de destinatarios y marcá al menos uno.", true);
        return false;
      }
      const limitsData = getLimitsData();
      const remainingMonth = limitsData?.messages?.remaining_this_month;
      if (remainingMonth != null && !isUnlimited(remainingMonth) && toSend.length > remainingMonth) {
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
      const dryRun = qs("#dry_run") ? qs("#dry_run").checked : true;
      if (
        !dryRun &&
        !(await confirmRealSend({ fromAccount, selectedCount: toSend.length, useChatgpt }))
      ) {
        setSendInfoStatus("Envío real cancelado.", { force: true });
        return false;
      }

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
      if (!result.ok) {
        const errorCode = String(result?.error?.code || result?.data?.error?.code || "")
          .trim()
          .toUpperCase();
        const blockingQuota =
          result?.error?.details?.blocking_quota || result?.data?.error?.details?.blocking_quota || "";
        setBlockingQuota(blockingQuota || errorCode || "");
        const isActiveConflict =
          result.status === 409 &&
          (runtime.activeConflictErrorCodes.has(errorCode) ||
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
          (runtime.noPendingErrorCodes.has(errorCode) || blockingQuota === "already_messaged");
        if (noPendingRecipients) {
          setSendInfoStatus("No hay pendientes: ya fueron enviados o están en cola.", {
            force: true,
          });
          setEnqueueSendEnabled(false, "No hay pendientes para encolar.");
        } else {
          logApiErrorDiagnostic("send.enqueue_messages.failed", result, {
            blockingQuota,
            errorCode,
          });
          setEnqueueSendEnabled(getSelectedRecipients().length > 0);
          setSendStatus(result?.errorMessage || "Error", true);
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
      setBlockingQuota("");
      chrome.storage.local.set({ last_send_job_id: jobId });
      if (typeof refreshLimitsWithCache === "function") refreshLimitsWithCache(true);
      setSendInfoStatus(`Encolados ${total} mensajes`, { force: true });
      const section = qs("#send_job_progress_section");
      if (section) section.style.display = "block";
      await runtime.onSendRecipientsJobChange(st.selectedSendJobId, st.selectedSendKind);
      const stats = await refreshSendProgress(true);
      if (stats && (stats.queued || 0) + (stats.sent || 0) > 0) startSendProgressPolling();
      return true;
    } finally {
      enqueueState.inFlight = false;
    }
  }

  return {
    enqueueSendMessages,
    getLastEnqueueBlockingQuota: () => enqueueState.lastBlockingQuota,
    clearLastEnqueueBlockingQuota: () => setBlockingQuota(""),
  };
}
