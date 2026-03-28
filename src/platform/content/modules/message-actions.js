(function initContentMessageActionsModule(globalScope) {
  function createContentMessageActionsModule({ selectorsModule, typeHumanLike }) {
    const {
      HUMAN_CONFIG,
      sleep,
      humanDelay,
      waitForCondition,
      waitForElement,
      waitForSendButton,
    } = selectorsModule;

    function normalizeMessageText(value) {
      return String(value || "")
        .replace(/\s+/g, " ")
        .trim()
        .toLowerCase();
    }

    function readComposerText(messageInput, editableEl) {
      const source = editableEl || messageInput;
      if (!source) return "";
      const raw = source.textContent || source.value || "";
      return normalizeMessageText(raw);
    }

    function hasRecentMessageEcho(expectedSnippet) {
      const expected = normalizeMessageText(expectedSnippet);
      if (!expected) return false;

      const messageNodes = document.querySelectorAll(
        'main div[role="listitem"] span[dir="auto"], main div[role="listitem"] div[dir="auto"]'
      );
      if (!messageNodes.length) return false;

      const lowerBound = Math.max(0, messageNodes.length - 10);
      for (let i = messageNodes.length - 1; i >= lowerBound; i -= 1) {
        const nodeText = normalizeMessageText(messageNodes[i]?.textContent || "");
        if (!nodeText) continue;
        if (nodeText.includes(expected) || expected.includes(nodeText)) {
          return true;
        }
      }
      return false;
    }

    async function waitForSendConfirmation(messageInput, editableEl, message, timeoutMs = 7000) {
      const expected = normalizeMessageText(message).slice(0, 24);
      const start = Date.now();

      while (Date.now() - start < timeoutMs) {
        const composerText = readComposerText(messageInput, editableEl);

        if (!composerText) {
          return { ok: true, signal: "composer_cleared" };
        }

        if (expected && !composerText.includes(expected)) {
          return { ok: true, signal: "composer_changed" };
        }

        if (expected && hasRecentMessageEcho(expected)) {
          return { ok: true, signal: "message_echo" };
        }

        await sleep(250);
      }

      return { ok: false, signal: "confirmation_timeout" };
    }

    async function clickMessageButton() {
      console.log('[BeLeadAI] Paso: buscar botón "Message"...');

      const msgBtn = await waitForElement(
        HUMAN_CONFIG.selectors.messageButton,
        8000,
        "botón Message"
      );
      if (!msgBtn) {
        console.error(
          "[BeLeadAI] ERROR: No se encontró el botón de mensaje. Instagram puede haber cambiado el DOM."
        );
        return false;
      }

      await humanDelay(HUMAN_CONFIG.profileViewMin, HUMAN_CONFIG.profileViewMax);

      console.log("[BeLeadAI] Paso: click en botón Message");
      msgBtn.click();

      return !!(await waitForCondition(() => waitForSendButton(500), {
        timeout: 2600,
        pollMs: 180,
        settleMinMs: 140,
        settleMaxMs: 320,
      }));
    }

    async function typeAndSendMessage(message) {
      console.log("[BeLeadAI] Paso: buscar caja de texto del mensaje...");

      const textarea = await waitForElement(
        HUMAN_CONFIG.selectors.messageTextarea,
        8000,
        "textarea mensaje"
      );
      if (!textarea) {
        console.error("[BeLeadAI] ERROR: No se encontró el textarea del mensaje.");
        return false;
      }

      console.log("[BeLeadAI] Paso: escribir mensaje (" + message.length + " caracteres)");
      await typeHumanLike(textarea, message);

      console.log("[BeLeadAI] Paso: buscar botón Enviar...");
      const sendBtn = await waitForSendButton(5000);
      if (!sendBtn) {
        console.error(
          "[BeLeadAI] ERROR: No se encontró el botón de enviar (probado svg[aria-label=Send] y selectores clásicos)."
        );
        return false;
      }

      await humanDelay(800, 1500);

      console.log("[BeLeadAI] Paso: click en Enviar");
      sendBtn.click();

      await humanDelay(HUMAN_CONFIG.afterSendMin, HUMAN_CONFIG.afterSendMax);

      return true;
    }

    return {
      waitForSendConfirmation,
      clickMessageButton,
      typeAndSendMessage,
    };
  }

  globalScope.createContentMessageActionsModule = createContentMessageActionsModule;
})(self);
