(function initContentObserversModule(globalScope) {
  function createContentObserversModule({ selectorsModule }) {
    const { sleep, isElementVisible } = selectorsModule;

    function createDomMutationObserver(callback, options = null) {
      if (typeof callback !== "function") return { disconnect() {} };
      const target = document.documentElement || document.body;
      if (!target) return { disconnect() {} };
      const observer = new MutationObserver(() => {
        try {
          callback();
        } catch (_) {}
      });
      observer.observe(
        target,
        options || {
          childList: true,
          subtree: true,
          attributes: true,
        }
      );
      return observer;
    }

    function addTemporaryEventListener(target, eventName, handler, options = undefined) {
      if (!target || typeof target.addEventListener !== "function") {
        return () => {};
      }
      target.addEventListener(eventName, handler, options);
      return () => {
        try {
          target.removeEventListener(eventName, handler, options);
        } catch (_) {}
      };
    }

    function normalizeIgUsername(v) {
      return String(v || "")
        .trim()
        .replace(/^@+/, "")
        .toLowerCase();
    }

    function isLikelyIgUsername(v) {
      const token = normalizeIgUsername(v);
      if (!/^[a-z0-9._]{2,30}$/.test(token)) return false;
      if (
        ["direct", "accounts", "explore", "reels", "stories", "message", "mensaje"].includes(token)
      )
        return false;
      return true;
    }

    function extractIgUsernameFromPath(pathname) {
      const clean = String(pathname || "")
        .replace(/[?#].*$/, "")
        .replace(/^\/+|\/+$/g, "");
      const first = (clean.split("/")[0] || "").toLowerCase();
      if (!isLikelyIgUsername(first)) return null;
      return first;
    }

    function extractUsernamesFromText(text) {
      const out = new Set();
      const raw = String(text || "").toLowerCase();
      const re = /(?:^|[^a-z0-9._])@?([a-z0-9._]{2,30})(?=$|[^a-z0-9._])/g;
      let m;
      while ((m = re.exec(raw)) !== null) {
        const u = normalizeIgUsername(m[1]);
        if (isLikelyIgUsername(u)) out.add(u);
      }
      return out;
    }

    function collectThreadIdentityCandidates() {
      const out = new Set();

      const anchors = document.querySelectorAll("header a[href], main a[href]");
      for (const a of anchors) {
        try {
          const href = a.getAttribute("href") || "";
          const pathname = href.startsWith("http") ? new URL(href).pathname : href;
          const u = extractIgUsernameFromPath(pathname);
          if (u) out.add(u);
        } catch (_) {}
      }

      const textNodes = document.querySelectorAll(
        "header h1, header h2, header a, header span, header div"
      );
      for (const el of textNodes) {
        const txt = (el.textContent || "").trim();
        if (!txt) continue;
        for (const u of extractUsernamesFromText(txt)) out.add(u);
      }

      return out;
    }

    function threadHasExactProfileLink(expectedUsername) {
      const expected = normalizeIgUsername(expectedUsername);
      if (!expected) return false;
      const selectors = [
        `header a[href="/${expected}"]`,
        `header a[href="/${expected}/"]`,
        `main a[href="/${expected}"]`,
        `main a[href="/${expected}/"]`,
      ];
      for (const sel of selectors) {
        const el = document.querySelector(sel);
        if (el && isElementVisible(el)) return true;
      }
      return false;
    }

    async function waitForThreadOpened(timeoutMs) {
      const start = Date.now();
      while (Date.now() - start < timeoutMs) {
        if (window.location.pathname && window.location.pathname.includes("/direct/t/")) {
          console.log("[BeLeadAI] Thread abierto (URL /direct/t/)");
          return true;
        }
        const input =
          document.querySelector('div[contenteditable="true"][role="textbox"]') ||
          document.querySelector('div[contenteditable="true"]') ||
          document.querySelector('[aria-label="Message"][contenteditable="true"]') ||
          document.querySelector('[aria-label="Mensaje"][contenteditable="true"]');
        if (input && isElementVisible(input)) {
          console.log("[BeLeadAI] Thread abierto (composer visible)");
          return true;
        }
        const threadHeader = document.querySelector('header h1, header h2, header a[href^="/"]');
        if (threadHeader && isElementVisible(threadHeader)) {
          console.log("[BeLeadAI] Thread abierto (header visible)");
          return true;
        }
        await sleep(300);
      }
      console.warn("[BeLeadAI] Timeout esperando thread abierto");
      return false;
    }

    async function waitForThreadIdentity(
      expectedUsername,
      timeoutMs = 5000,
      selectedRowUsername = null,
      selectedRowConfidence = null
    ) {
      const expected = normalizeIgUsername(expectedUsername);
      if (!expected) return false;
      const selected = normalizeIgUsername(selectedRowUsername);
      const selectedConfidence = String(selectedRowConfidence || "").toLowerCase();
      const start = Date.now();
      let lastDebugTs = 0;
      const selectedRowGraceMs = 2200;
      let selectedRowNoConflictStreak = 0;

      while (Date.now() - start < timeoutMs) {
        const pathname = window.location.pathname || "";
        const isThreadUrl = pathname.includes("/direct/t/");
        const elapsedMs = Date.now() - start;
        const hasExactProfileLink = isThreadUrl ? threadHasExactProfileLink(expected) : false;
        const candidates = isThreadUrl ? collectThreadIdentityCandidates() : new Set();
        const hasCandidate = isThreadUrl && candidates.has(expected);
        const hasConflictCandidate = isThreadUrl && candidates.size > 0 && !hasCandidate;
        const composerEl =
          document.querySelector('div[contenteditable="true"][role="textbox"]') ||
          document.querySelector('div[contenteditable="true"]') ||
          document.querySelector('[aria-label="Message"][contenteditable="true"]') ||
          document.querySelector('[aria-label="Mensaje"][contenteditable="true"]');
        const composerVisible = !!(composerEl && isElementVisible(composerEl));

        if (hasExactProfileLink) {
          console.warn("[BeLeadAI] Thread verificado por link de perfil exacto para @" + expected);
          return true;
        }

        if (hasCandidate) {
          console.warn("[BeLeadAI] Thread verificado por candidatos en header para @" + expected);
          return true;
        }

        const allowSelectedRowFallback =
          selected &&
          selected === expected &&
          selectedConfidence === "strong" &&
          isThreadUrl &&
          elapsedMs >= selectedRowGraceMs &&
          !hasConflictCandidate &&
          composerVisible;
        if (allowSelectedRowFallback) {
          selectedRowNoConflictStreak += 1;
          if (selectedRowNoConflictStreak >= 2) {
            console.warn(
              "[BeLeadAI] Thread verificado por row fuerte + URL thread (sin conflicto visible estable) para @" +
                expected
            );
            return true;
          }
        } else {
          selectedRowNoConflictStreak = 0;
        }

        if (Date.now() - lastDebugTs > 1200) {
          console.log(
            "[BeLeadAI] Verificando identidad thread @" +
              expected +
              " path=" +
              pathname +
              " selectedRow=" +
              (selected || "-") +
              " selectedConfidence=" +
              (selectedConfidence || "-") +
              " hasExactLink=" +
              (hasExactProfileLink ? "1" : "0") +
              " candidates=" +
              (isThreadUrl ? candidates.size : 0) +
              " hasConflict=" +
              (hasConflictCandidate ? "1" : "0")
          );
          lastDebugTs = Date.now();
        }
        await sleep(300);
      }

      console.warn(
        "[BeLeadAI] No se pudo verificar identidad del thread para @" +
          expected +
          " (fail-closed). path=" +
          (window.location.pathname || "") +
          " selectedRow=" +
          (selected || "-") +
          " selectedConfidence=" +
          (selectedConfidence || "-")
      );
      return false;
    }

    function waitForDocumentComplete(
      timeoutMs = 15000,
      requireDirectPath = false,
      intervalMs = 100
    ) {
      return new Promise((resolve) => {
        const timeout = setTimeout(() => {
          clearInterval(check);
          if (!requireDirectPath) {
            resolve(false);
            return;
          }
          const inDirect = !!(
            window.location.pathname && window.location.pathname.startsWith("/direct")
          );
          resolve(inDirect);
        }, timeoutMs);

        const check = setInterval(() => {
          const ready = document.readyState === "complete";
          if (!ready) return;
          if (
            requireDirectPath &&
            !(window.location.pathname && window.location.pathname.startsWith("/direct"))
          )
            return;
          clearTimeout(timeout);
          clearInterval(check);
          resolve(true);
        }, intervalMs);
      });
    }

    return {
      createDomMutationObserver,
      addTemporaryEventListener,
      normalizeIgUsername,
      isLikelyIgUsername,
      extractIgUsernameFromPath,
      extractUsernamesFromText,
      collectThreadIdentityCandidates,
      threadHasExactProfileLink,
      waitForThreadOpened,
      waitForThreadIdentity,
      waitForDocumentComplete,
    };
  }

  globalScope.createContentObserversModule = createContentObserversModule;
})(self);
