(function initContentActionsModule(globalScope) {
  function createContentActionsModule({
    selectorsModule,
    observersModule,
    inputActionsModule,
    directSearchModule,
    messageActionsModule,
    accountIdentityModule,
  }) {
    const { HUMAN_CONFIG, humanDelay, waitForCondition, waitForElement, waitForSendButton } =
      selectorsModule;
    const {
      normalizeIgUsername,
      isLikelyIgUsername,
      waitForThreadOpened,
      waitForThreadIdentity,
      waitForDocumentComplete,
    } = observersModule;
    const { typeHumanLike } = inputActionsModule;
    const { directSearchAndOpenThread: openDirectThread } = directSearchModule;
    const { waitForSendConfirmation, clickMessageButton, typeAndSendMessage } =
      messageActionsModule;
    const { getCurrentInstagramUsername } = accountIdentityModule;

    let lastDirectThreadCandidateUsername = null;
    let lastDirectThreadCandidateConfidence = null;

    function maskUsername(value) {
      const raw = String(value || "").trim();
      if (!raw) return "unknown";
      if (raw.length <= 2) return "*".repeat(raw.length);
      return `${raw.slice(0, 2)}***`;
    }

    async function navigateToProfile(username) {
      const profileUrl = `https://www.instagram.com/${username}/`;

      if (
        window.location.href.includes(`/${username}/`) ||
        window.location.href.includes(`/${username}`)
      ) {
        console.log("[BeLeadAI] Ya estamos en el perfil:", username);
        return true;
      }

      console.log("[BeLeadAI] Navegando a perfil:", profileUrl);
      window.location.href = profileUrl;
      return waitForDocumentComplete(15000, false, 100);
    }

    async function navigateToDirect() {
      const directUrl = "https://www.instagram.com/direct/";
      if (
        window.location.href.startsWith(directUrl) ||
        (window.location.pathname && window.location.pathname.startsWith("/direct"))
      ) {
        console.log("[BeLeadAI] Ya estamos en /direct (inbox o conversación)");
        return true;
      }
      console.log("[BeLeadAI] Navegando a /direct");
      window.location.href = directUrl;

      const ok = await waitForDocumentComplete(12000, true, 200);
      if (!ok) {
        console.warn(
          "[BeLeadAI] Timeout navegando a /direct; seguimos fuera de /direct:",
          window.location.pathname
        );
      }
      return ok;
    }

    async function sendDMViaDirect(username, message, dryRun) {
      console.log("[BeLeadAI] ========== sendDMViaDirect INICIO ==========");
      lastDirectThreadCandidateUsername = null;
      lastDirectThreadCandidateConfidence = null;
      const result = { success: false, username, error: null, dryRun, steps: [] };
      try {
        result.steps.push("navigate_direct");
        const okNav = await navigateToDirect();
        if (!okNav) {
          result.error = "navigation_direct_failed";
          return result;
        }
        await waitForCondition(() => document.querySelector('main, [role="main"]'), {
          timeout: 3500,
          pollMs: 180,
          settleMinMs: 260,
          settleMaxMs: 700,
        });
        result.steps.push("search_user");
        const searchResult = await openDirectThread(username);
        lastDirectThreadCandidateUsername = searchResult?.candidateUsername || null;
        lastDirectThreadCandidateConfidence = searchResult?.candidateConfidence || null;
        if (!searchResult?.ok) {
          result.error = "search_or_open_thread_failed";
          return result;
        }
        result.steps.push("verify_thread_identity");
        let identityOk = await waitForThreadIdentity(
          username,
          7000,
          lastDirectThreadCandidateUsername,
          lastDirectThreadCandidateConfidence
        );
        if (!identityOk) {
          await humanDelay(350, 850);
          identityOk = await waitForThreadIdentity(
            username,
            4500,
            lastDirectThreadCandidateUsername,
            lastDirectThreadCandidateConfidence
          );
        }
        if (!identityOk) {
          result.error = "thread_identity_not_verified";
          return result;
        }
        await humanDelay(1500, 2500);
        result.steps.push("type_message");
        const messageInput = await waitForElement(
          HUMAN_CONFIG.selectors.directMessageInput,
          8000,
          "message input /direct"
        );
        if (!messageInput) {
          result.error = "message_input_not_found";
          return result;
        }
        messageInput.focus();
        await humanDelay(400, 700);
        const editableEl =
          messageInput.tagName === "P" || messageInput.getAttribute("contenteditable") !== "true"
            ? messageInput.closest('[contenteditable="true"]') ||
              document.querySelector('div[contenteditable="true"]')
            : messageInput;
        if (editableEl) {
          editableEl.focus();
          editableEl.textContent = "";
          editableEl.dispatchEvent(
            new InputEvent("input", { bubbles: true, inputType: "deleteContent" })
          );
          await humanDelay(200, 400);
        }
        if (editableEl) {
          await typeHumanLike(editableEl, message);
        } else {
          await typeHumanLike(messageInput, message);
        }
        await humanDelay(300, 500);
        const writtenText = (
          (editableEl || messageInput).textContent ||
          (editableEl || messageInput).value ||
          ""
        )
          .replace(/\s+/g, " ")
          .trim();
        const expectedPrefix = message
          .replace(/\s+/g, " ")
          .trim()
          .substring(0, Math.min(30, message.length));
        if (!writtenText.includes(expectedPrefix)) {
          console.error("[BeLeadAI] Mensaje no escrito correctamente en la caja de texto.");
          result.error = "write_failed";
          result.steps.push("write_verification_failed");
          return result;
        }
        console.log("[BeLeadAI] Mensaje verificado en input.");
        if (dryRun) {
          result.steps.push("dry_run_skip_send");
          result.success = true;
          result.dryRunMessage = `Dry-run: texto escrito en la caja para ${username}, sin enviar. Pasando al siguiente.`;
          return result;
        }
        result.steps.push("send");
        const sendBtn = await waitForSendButton(5000);
        if (!sendBtn) {
          result.error = "send_button_not_found";
          return result;
        }
        await humanDelay(600, 1200);
        sendBtn.click();
        await humanDelay(HUMAN_CONFIG.afterSendMin, HUMAN_CONFIG.afterSendMax);

        const sendConfirmation = await waitForSendConfirmation(
          messageInput,
          editableEl,
          message,
          7000
        );
        if (!sendConfirmation.ok) {
          result.error = "send_not_confirmed";
          result.steps.push("send_not_confirmed");
          return result;
        }

        result.success = true;
        result.steps.push("sent:" + sendConfirmation.signal);
      } catch (err) {
        console.error("[BeLeadAI] sendDMViaDirect error:", err);
        result.error = err.message || "unknown_error";
      }
      console.log(
        "[BeLeadAI] ========== sendDMViaDirect FIN ========== success:",
        result.success,
        "error:",
        result.error
      );
      return result;
    }

    async function sendDM(username, message, dryRun = true) {
      const normalizedUsername = normalizeIgUsername(username);
      if (!isLikelyIgUsername(normalizedUsername)) {
        return {
          success: false,
          username: null,
          error: "invalid_username",
          dryRun,
          steps: ["validate_username"],
        };
      }
      console.log(`[BeLeadAI] ========== sendDM INICIO ==========`);
      console.log(`[BeLeadAI] username: ${maskUsername(normalizedUsername)}, dryRun: ${dryRun}`);

      const host = (window.location.hostname || "").toLowerCase();
      const isInstagramHost = /(^|\.)instagram\.com$/.test(host);
      if (isInstagramHost) {
        const directResult = await sendDMViaDirect(normalizedUsername, message, dryRun);
        console.log(
          "[BeLeadAI] ========== sendDM FIN ========== success:",
          directResult.success,
          "error:",
          directResult.error,
          "steps:",
          directResult.steps
        );
        return directResult;
      }

      const result = { success: false, username, error: null, dryRun, steps: [] };
      try {
        result.steps.push("navigate_start");
        const navigated = await navigateToProfile(normalizedUsername);
        if (!navigated) {
          result.error = "navigation_failed";
          return result;
        }
        result.steps.push("navigate_done");
        await humanDelay(2000, 4000);
        result.steps.push("message_button_start");
        const clickedMsg = await clickMessageButton();
        if (!clickedMsg) {
          result.error = "message_button_not_found";
          return result;
        }
        result.steps.push("message_button_done");
        if (dryRun) {
          result.steps.push("dry_run_skip_send");
          result.success = true;
          result.dryRunMessage = `Mensaje simulado para ${normalizedUsername}: "${message.substring(0, 50)}..."`;
          return result;
        }
        result.steps.push("type_and_send_start");
        const sent = await typeAndSendMessage(message);
        if (!sent) {
          result.error = "send_failed";
          return result;
        }
        result.steps.push("type_and_send_done");
        result.success = true;
      } catch (err) {
        console.error("[BeLeadAI] Error en sendDM:", err);
        result.error = err.message || "unknown_error";
        result.steps.push("error: " + result.error);
      }
      console.log(
        "[BeLeadAI] ========== sendDM FIN ========== success:",
        result.success,
        "error:",
        result.error,
        "steps:",
        result.steps
      );
      return result;
    }

    return {
      sendDM,
      getCurrentInstagramUsername,
      maskUsername,
      normalizeIgUsername,
      isLikelyIgUsername,
      navigateToProfile,
      navigateToDirect,
      directSearchAndOpenThread: openDirectThread,
      sendDMViaDirect,
      clickMessageButton,
      typeAndSendMessage,
      typeHumanLike,
      waitForThreadOpened,
      waitForThreadIdentity,
    };
  }

  globalScope.createContentActionsModule = createContentActionsModule;
})(self);
