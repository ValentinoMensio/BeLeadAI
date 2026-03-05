(function initContentSelectorsModule(globalScope) {
  function createContentSelectorsModule() {
    const HUMAN_CONFIG = {
      typingBaseMs: 50,
      typingJitterMs: 30,
      thinkingPauseMin: 800,
      thinkingPauseMax: 2500,
      profileViewMin: 2000,
      profileViewMax: 5000,
      afterSendMin: 1500,
      afterSendMax: 3000,
      selectors: {
        messageButton: [
          'div[role="button"]:has-text("Message")',
          'div[role="button"]:has-text("Mensaje")',
          'button:has-text("Message")',
          '[aria-label="Message"]',
          '[aria-label="Mensaje"]',
        ],
        messageTextarea: [
          'textarea[placeholder*="Message"]',
          'textarea[placeholder*="Mensaje"]',
          'div[role="textbox"][contenteditable="true"]',
          'div[contenteditable="true"]',
          'div[aria-label*="Message"]',
        ],
        sendButton: [
          'button[type="submit"]',
          'div[role="button"]:has-text("Send")',
          'div[role="button"]:has-text("Enviar")',
          '[aria-label="Send"]',
          '[aria-label="Enviar"]',
        ],
        directSearchInput: [
          'input[placeholder="Search"]',
          'input[placeholder="Buscar"]',
          'input[name="searchInput"]',
          'input[aria-label*="Search"]',
          'input[aria-label*="Buscar"]',
        ],
        directMessageInput: [
          'div[contenteditable="true"][role="textbox"]',
          'div[contenteditable="true"]',
          '[aria-label="Message"][contenteditable="true"]',
          '[aria-label="Mensaje"][contenteditable="true"]',
          'div[role="textbox"]',
          'p[dir="auto"]',
        ],
      },
    };

    function randomBetween(min, max) {
      return Math.floor(Math.random() * (max - min + 1)) + min;
    }

    function sleep(ms) {
      return new Promise((resolve) => setTimeout(resolve, ms));
    }

    function isElementVisible(el) {
      if (!el || !el.isConnected) return false;
      try {
        const rects = el.getClientRects();
        if (!rects || rects.length === 0) return false;
        const style = window.getComputedStyle(el);
        if (style.visibility === "hidden" || style.display === "none" || style.opacity === "0")
          return false;
        return true;
      } catch {
        return false;
      }
    }

    async function humanDelay(minMs, maxMs) {
      const delay = randomBetween(minMs, maxMs);
      await sleep(delay);
      return delay;
    }

    async function waitForElement(selectors, timeout = 10000, logLabel = "element") {
      const selectorList = Array.isArray(selectors) ? selectors : [selectors];
      const startTime = Date.now();
      let lastLog = 0;

      while (Date.now() - startTime < timeout) {
        for (let i = 0; i < selectorList.length; i++) {
          const selector = selectorList[i];
          try {
            if (!selector.includes(":has-text")) {
              const element = document.querySelector(selector);
              if (element && isElementVisible(element)) {
                console.log(
                  `[BeLeadAI] ${logLabel} encontrado con selector [${i}]:`,
                  selector.substring(0, 60)
                );
                return element;
              }
            } else {
              const match = selector.match(/:has-text\("([^"]+)"\)/);
              if (match) {
                const text = match[1];
                const baseSelector = selector.replace(/:has-text\("[^"]+"\)/, "").trim();
                const scopeSelector = baseSelector || 'button, div[role="button"], a, span';
                const root = document.querySelectorAll(scopeSelector);
                const elements = Array.from(root);
                for (const el of elements) {
                  if (el.textContent && el.textContent.trim().includes(text)) {
                    if (isElementVisible(el)) {
                      console.log(
                        `[BeLeadAI] ${logLabel} encontrado con :has-text("${text}") [${i}]`
                      );
                      return el;
                    }
                  }
                }
              }
            }
          } catch (e) {
            console.debug(`[BeLeadAI] selector [${i}] error:`, e.message);
          }
        }
        const elapsed = Date.now() - startTime;
        if (elapsed - lastLog > 3000) {
          console.log(
            `[BeLeadAI] Esperando ${logLabel}... ${Math.round(elapsed / 1000)}s (selectores: ${selectorList.length})`
          );
          lastLog = elapsed;
        }
        await sleep(200);
      }
      console.error(
        `[BeLeadAI] TIMEOUT: no se encontró ${logLabel} después de ${timeout}ms. Selectores probados:`,
        selectorList
      );
      return null;
    }

    function findSendButton() {
      const labels = ["Send", "Enviar"];
      for (const label of labels) {
        const svg = document.querySelector(`svg[aria-label="${label}"]`);
        if (svg) {
          const btn = svg.closest('[role="button"]') || svg.closest("button") || svg.parentElement;
          if (btn) {
            console.log('[BeLeadAI] Botón Send encontrado por svg[aria-label="' + label + '"]');
            return btn;
          }
        }
      }
      const byAria = document.querySelector('[aria-label="Send"], [aria-label="Enviar"]');
      if (byAria) return byAria;
      return null;
    }

    async function waitForSendButton(timeout = 8000) {
      const start = Date.now();
      while (Date.now() - start < timeout) {
        const btn = findSendButton();
        if (btn && isElementVisible(btn)) return btn;
        await sleep(300);
      }
      return waitForElement(HUMAN_CONFIG.selectors.sendButton, 3000, "botón Send");
    }

    return {
      HUMAN_CONFIG,
      randomBetween,
      sleep,
      isElementVisible,
      humanDelay,
      waitForElement,
      findSendButton,
      waitForSendButton,
    };
  }

  globalScope.createContentSelectorsModule = createContentSelectorsModule;
})(self);
