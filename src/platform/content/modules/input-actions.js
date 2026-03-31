(function initContentInputActionsModule(globalScope) {
  function createContentInputActionsModule({ selectorsModule }) {
    const { HUMAN_CONFIG, randomBetween, sleep, humanDelay, waitForCondition } = selectorsModule;

    function placeCaretInContentEditable(editable) {
      try {
        editable.focus();
        const sel = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(editable);
        range.collapse(false);
        sel.removeAllRanges();
        sel.addRange(range);
      } catch {
        editable.focus();
      }
    }

    function setNativeInputValue(inputEl, value) {
      if (!inputEl) return;
      const nextValue = String(value ?? "");
      const proto = Object.getPrototypeOf(inputEl);
      const descriptor = proto ? Object.getOwnPropertyDescriptor(proto, "value") : null;
      if (descriptor && typeof descriptor.set === "function") {
        descriptor.set.call(inputEl, nextValue);
      } else {
        inputEl.value = nextValue;
      }
    }

    function dispatchInputLikeEvents(inputEl, data = "") {
      if (!inputEl) return;
      try {
        inputEl.dispatchEvent(
          new InputEvent("beforeinput", {
            bubbles: true,
            cancelable: true,
            inputType: "insertText",
            data: String(data || ""),
          })
        );
      } catch {}
      inputEl.dispatchEvent(new Event("input", { bubbles: true }));
      inputEl.dispatchEvent(new Event("change", { bubbles: true }));
    }

    function normalizeSearchValue(value) {
      return String(value || "")
        .trim()
        .replace(/^@+/, "")
        .toLowerCase();
    }

    async function writeSearchQuery(searchInput, username) {
      const desired = normalizeSearchValue(username);
      if (!desired) return false;
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        searchInput.focus();
        await humanDelay(80, 160);
        setNativeInputValue(searchInput, "");
        dispatchInputLikeEvents(searchInput, "");
        await humanDelay(70, 140);
        setNativeInputValue(searchInput, desired);
        dispatchInputLikeEvents(searchInput, desired);
        await waitForCondition(
          () =>
            normalizeSearchValue(searchInput.value || searchInput.textContent || "") === desired,
          { timeout: 220 + attempt * 120, pollMs: 60, settleMinMs: 40, settleMaxMs: 120 }
        );
        const current = normalizeSearchValue(searchInput.value || searchInput.textContent || "");
        if (current === desired) {
          return true;
        }
      }
      return false;
    }

    async function insertTextContentEditable(editable, text) {
      editable.focus();
      placeCaretInContentEditable(editable);
      await humanDelay(300, 600);

      const target =
        editable.tagName === "P"
          ? editable.closest('[contenteditable="true"]') || editable
          : editable;
      target.textContent = "";
      await sleep(50);
      target.textContent = text;
      target.dispatchEvent(
        new InputEvent("beforeinput", { bubbles: true, inputType: "insertFromPaste", data: text })
      );
      target.dispatchEvent(
        new InputEvent("input", { bubbles: true, inputType: "insertFromPaste", data: text })
      );
    }

    async function typeHumanLike(element, text) {
      const isInputOrTextarea = element.tagName === "TEXTAREA" || element.tagName === "INPUT";
      if (isInputOrTextarea) {
        element.focus();
        await humanDelay(300, 600);
        element.value = "";
        element.dispatchEvent(
          new InputEvent("beforeinput", { bubbles: true, inputType: "deleteContent" })
        );
        element.dispatchEvent(new Event("input", { bubbles: true }));
        for (let i = 0; i < text.length; i += 1) {
          const char = text[i];
          element.value += char;
          element.dispatchEvent(new Event("input", { bubbles: true }));
          element.dispatchEvent(new KeyboardEvent("keydown", { key: char, bubbles: true }));
          element.dispatchEvent(new KeyboardEvent("keyup", { key: char, bubbles: true }));
          const baseDelay = HUMAN_CONFIG.typingBaseMs;
          const jitter = randomBetween(-HUMAN_CONFIG.typingJitterMs, HUMAN_CONFIG.typingJitterMs);
          await sleep(Math.max(20, baseDelay + jitter));
          if (Math.random() < 0.05) {
            await humanDelay(HUMAN_CONFIG.thinkingPauseMin, HUMAN_CONFIG.thinkingPauseMax);
          }
        }
      } else {
        const editable =
          element.getAttribute("contenteditable") === "true"
            ? element
            : element.closest('[contenteditable="true"]') || element;
        await insertTextContentEditable(editable, text);
      }
      await humanDelay(500, 1200);
    }

    return {
      writeSearchQuery,
      typeHumanLike,
      insertTextContentEditable,
      normalizeSearchValue,
    };
  }

  globalScope.createContentInputActionsModule = createContentInputActionsModule;
})(self);
