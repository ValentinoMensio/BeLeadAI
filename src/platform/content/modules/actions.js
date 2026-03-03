(function initContentActionsModule(globalScope) {
  function createContentActionsModule({ selectorsModule, observersModule }) {
    const {
      HUMAN_CONFIG,
      randomBetween,
      sleep,
      isElementVisible,
      humanDelay,
      waitForElement,
      waitForSendButton,
    } = selectorsModule;
    const {
      normalizeIgUsername,
      isLikelyIgUsername,
      waitForThreadOpened,
      waitForThreadIdentity,
      waitForDocumentComplete,
    } = observersModule;

    let lastDirectThreadCandidateUsername = null;
    let lastDirectThreadCandidateConfidence = null;

    function maskUsername(value) {
      const raw = String(value || "").trim();
      if (!raw) return "unknown";
      if (raw.length <= 2) return "*".repeat(raw.length);
      return `${raw.slice(0, 2)}***`;
    }

    function placeCaretInContentEditable(editable) {
      try {
        editable.focus();
        const sel = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(editable);
        range.collapse(false);
        sel.removeAllRanges();
        sel.addRange(range);
      } catch (e) {
        editable.focus();
      }
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
        for (let i = 0; i < text.length; i++) {
          const char = text[i];
          element.value += char;
          element.dispatchEvent(new Event("input", { bubbles: true }));
          element.dispatchEvent(new KeyboardEvent("keydown", { key: char, bubbles: true }));
          element.dispatchEvent(new KeyboardEvent("keyup", { key: char, bubbles: true }));
          const baseDelay = HUMAN_CONFIG.typingBaseMs;
          const jitter = randomBetween(-HUMAN_CONFIG.typingJitterMs, HUMAN_CONFIG.typingJitterMs);
          await sleep(Math.max(20, baseDelay + jitter));
          if (Math.random() < 0.05)
            await humanDelay(HUMAN_CONFIG.thinkingPauseMin, HUMAN_CONFIG.thinkingPauseMax);
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

    async function directSearchAndOpenThread(username) {
      console.log("[BeLeadAI] ========== INICIO directSearchAndOpenThread ==========");
      console.log("[BeLeadAI] Target username:", maskUsername(username));
      console.log("[BeLeadAI] Paso: buscar input de búsqueda en /direct");
      console.log("[BeLeadAI] Selectores intentados:", HUMAN_CONFIG.selectors.directSearchInput);
      const searchInput = await waitForElement(
        HUMAN_CONFIG.selectors.directSearchInput,
        10000,
        "search input"
      );
      if (!searchInput) {
        console.error("[BeLeadAI] ERROR: No se encontró el input de búsqueda en /direct");
        console.error("[BeLeadAI] Selectores fallidos:", HUMAN_CONFIG.selectors.directSearchInput);
        return false;
      }
      console.log(
        "[BeLeadAI] Input de búsqueda encontrado:",
        searchInput.placeholder || searchInput.getAttribute("aria-label") || "sin placeholder"
      );
      searchInput.focus();
      await humanDelay(300, 600);
      searchInput.value = "";
      searchInput.dispatchEvent(new Event("input", { bubbles: true }));
      await sleep(300);
      for (const c of username) {
        searchInput.value += c;
        searchInput.dispatchEvent(new Event("input", { bubbles: true }));
        searchInput.dispatchEvent(new KeyboardEvent("keydown", { key: c, bubbles: true }));
        searchInput.dispatchEvent(new KeyboardEvent("keyup", { key: c, bubbles: true }));
        await sleep(80 + randomBetween(-20, 40));
      }
      searchInput.dispatchEvent(new Event("input", { bubbles: true }));
      console.log("[BeLeadAI] Username ingresado en input:", maskUsername(username));
      const uname = String(username || "")
        .trim()
        .replace(/^@+/, "")
        .toLowerCase();
      console.log("[BeLeadAI] Username normalizado para matching:", uname);
      lastDirectThreadCandidateUsername = null;
      lastDirectThreadCandidateConfidence = null;

      function escapeRegex(v) {
        return String(v).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      }

      function normalizeUsernameToken(v) {
        const raw = String(v || "")
          .trim()
          .replace(/^@+/, "")
          .toLowerCase();
        return raw;
      }

      function isLikelyUsernameToken(v) {
        const t = normalizeUsernameToken(v);
        if (!/^[a-z0-9._]{2,30}$/i.test(t)) return false;
        if (["more", "accounts", "moreaccounts", "mas", "cuentas"].includes(t)) return false;
        return true;
      }

      function rowTextUsernameCandidates(row) {
        const users = [];
        const seen = new Set();
        const spans = row.querySelectorAll('span[dir="auto"]');
        for (const span of spans) {
          const token = normalizeUsernameToken(span.textContent || "");
          if (!isLikelyUsernameToken(token)) continue;
          if (seen.has(token)) continue;
          seen.add(token);
          users.push(token);
        }
        return users;
      }

      function findDropdownScopeByHeading() {
        const headings = document.querySelectorAll("h2");
        for (const h of headings) {
          const t = (h.textContent || "").trim().toLowerCase();
          if (!(t.includes("more accounts") || t.includes("más cuentas") || t === "accounts"))
            continue;

          let scope =
            h.closest('div[style*="--x-minHeight"]') ||
            h.closest('div[role="dialog"]') ||
            h.closest("section") ||
            h.parentElement;

          for (let i = 0; i < 6 && scope; i++) {
            const count = scope.querySelectorAll('div[role="button"]').length;
            if (count >= 2) return scope;
            scope = scope.parentElement;
          }
        }
        return document.body;
      }

      function findResultRows() {
        const scope = findDropdownScopeByHeading();
        const rows = [];
        const seen = new Set();

        function pushRow(el) {
          if (!el || seen.has(el)) return;
          if (!isElementVisible(el)) return;
          if (rowTextUsernameCandidates(el).length === 0) return;
          seen.add(el);
          rows.push(el);
        }

        const candidates = scope.querySelectorAll('div[role="button"][tabindex]');
        for (const el of candidates) pushRow(el);

        if (rows.length === 0) {
          const fallbackCandidates = scope.querySelectorAll('div[role="button"]');
          for (const el of fallbackCandidates) pushRow(el);
        }

        return rows;
      }

      async function attemptKeyboardOpenFirstResult() {
        try {
          console.warn("[BeLeadAI] Fallback teclado: Enter sobre búsqueda");
          searchInput.focus();
          searchInput.dispatchEvent(
            new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true })
          );
          searchInput.dispatchEvent(
            new KeyboardEvent("keyup", { key: "Enter", code: "Enter", bubbles: true })
          );
          await sleep(1600);
          if (await waitForThreadOpened(3000)) return true;

          console.warn("[BeLeadAI] Fallback teclado: ArrowDown + Enter");
          searchInput.dispatchEvent(
            new KeyboardEvent("keydown", { key: "ArrowDown", code: "ArrowDown", bubbles: true })
          );
          searchInput.dispatchEvent(
            new KeyboardEvent("keyup", { key: "ArrowDown", code: "ArrowDown", bubbles: true })
          );
          await sleep(250);
          searchInput.dispatchEvent(
            new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true })
          );
          searchInput.dispatchEvent(
            new KeyboardEvent("keyup", { key: "Enter", code: "Enter", bubbles: true })
          );
          await sleep(1800);
          return await waitForThreadOpened(3000);
        } catch (_) {
          return false;
        }
      }

      function normalizeHrefPath(href) {
        if (!href) return "";
        let path = href.trim().toLowerCase();
        if (path.startsWith("http://") || path.startsWith("https://")) {
          try {
            path = new URL(path).pathname || "";
          } catch (_) {
            return "";
          }
        }
        if (!path.startsWith("/")) path = "/" + path;
        path = path.replace(/[?#].*$/, "");
        path = path.replace(/\/+/g, "/");
        return path;
      }

      function isValidIgUsername(v) {
        return /^[a-z0-9._]{1,30}$/.test(v);
      }

      function extractUsernameFromPath(path) {
        if (!path || !path.startsWith("/")) return null;
        const clean = path.replace(/^\/+|\/+$/g, "");
        if (!clean) return null;
        const first = (clean.split("/")[0] || "").toLowerCase();
        if (!first) return null;
        if (["direct", "accounts", "explore", "reels", "stories", "p"].includes(first)) return null;
        return isValidIgUsername(first) ? first : null;
      }

      function rowCandidateUsernames(row) {
        const anchors = row.querySelectorAll("a[href]");
        const users = new Set();
        for (const a of anchors) {
          const path = normalizeHrefPath(a.getAttribute("href") || "");
          const pathUsername = extractUsernameFromPath(path);
          if (pathUsername) users.add(pathUsername);
        }
        return users;
      }

      function pickBestRowUsername(row, targetUsername) {
        const target = normalizeUsernameToken(targetUsername);
        const textCandidates = rowTextUsernameCandidates(row);
        if (textCandidates.includes(target)) return target;
        const hrefCandidates = [...rowCandidateUsernames(row)];
        if (hrefCandidates.includes(target)) return target;
        if (textCandidates.length > 0) return textCandidates[0];
        if (hrefCandidates.length > 0) return hrefCandidates[0];
        return null;
      }

      function rowHasExactAnchorUsername(row, u) {
        return rowCandidateUsernames(row).has(u);
      }

      function rowTextHasAtUsername(row, u) {
        const visibleText = (row.innerText || row.textContent || "").toLowerCase();
        const atUsernameRegex = new RegExp(`(^|[^a-z0-9._])@${escapeRegex(u)}($|[^a-z0-9._])`, "i");
        return atUsernameRegex.test(visibleText);
      }

      function rowHasExtraIdentitySignal(row, u) {
        return rowHasExactAnchorUsername(row, u) || rowTextHasAtUsername(row, u);
      }

      function rowHasTextExactUsername(row, u) {
        return rowTextUsernameCandidates(row).includes(u);
      }

      function rowStrongMatch(row, u) {
        if (!row || !u) return null;

        const textUsers = rowTextUsernameCandidates(row);
        for (const tu of textUsers) {
          if (tu === u) {
            return { row, reason: "text-username-exact", username: tu };
          }
        }

        const exactPathA = "/" + u;
        const exactPathB = "/" + u + "/";
        const anchors = row.querySelectorAll("a[href]");
        const rowCandidates = new Set();

        for (const a of anchors) {
          const path = normalizeHrefPath(a.getAttribute("href") || "");
          const pathUsername = extractUsernameFromPath(path);
          if (pathUsername) rowCandidates.add(pathUsername);
          if (path === exactPathA || path === exactPathB) {
            return { row, reason: "href", href: path };
          }
        }

        if (rowCandidates.has(u)) {
          return { row, reason: "href-username", href: null };
        }

        const visibleText = (row.innerText || row.textContent || "").toLowerCase();
        const escapedUsername = escapeRegex(u);
        const usernameBoundaryRegex = new RegExp(
          `(^|[^a-z0-9._])@?${escapedUsername}($|[^a-z0-9._])`,
          "i"
        );
        if (visibleText.includes("@" + u) || usernameBoundaryRegex.test(visibleText)) {
          return { row, reason: "text", href: null };
        }

        return null;
      }

      function rowSoftMatch(row, u) {
        if (!row || !u) return null;
        const users = new Set();
        for (const tu of rowTextUsernameCandidates(row)) users.add(tu);
        for (const hu of rowCandidateUsernames(row)) users.add(hu);

        for (const cand of users) {
          if (cand === u) continue;
          if (u.length >= 4 && cand.startsWith(u) && cand.length <= u.length + 4) {
            return { row, reason: "soft-prefix-guarded", href: cand };
          }
          if (u.length >= 8 && cand.includes(u) && cand.length <= u.length + 2) {
            return { row, reason: "soft-contains-guarded", href: cand };
          }
        }

        const visibleText = (row.innerText || row.textContent || "").toLowerCase();
        const normalized = visibleText.replace(/[^a-z0-9._@]/g, " ");
        if (normalized.includes("@" + u)) {
          return { row, reason: "soft-text-at", href: null };
        }

        const compactText = visibleText.replace(/[^a-z0-9]/g, "");
        const compactU = u.replace(/[^a-z0-9]/g, "");
        if (compactU.length >= 8 && compactText.includes(compactU)) {
          return { row, reason: "soft-text-compact", href: null };
        }

        return null;
      }

      function clickRow(row) {
        if (!row) return;
        row.click();
        const parent = row.parentElement;
        if (parent && (parent.getAttribute("role") === "button" || parent.onclick != null)) {
          try {
            parent.click();
          } catch (_) {}
        }
      }

      const pollMs = 300;
      const timeoutMs = 28000;
      const startTs = Date.now();
      let sawVisibleRows = false;
      let lastDebugLogTs = 0;
      const attemptedRows = new WeakMap();

      function wasRowTriedRecently(row, minGapMs = 3000) {
        const lastTs = attemptedRows.get(row) || 0;
        return Date.now() - lastTs < minGapMs;
      }

      console.log("[BeLeadAI] Paso: esperando match fuerte en dropdown para @" + uname);
      console.log("[BeLeadAI] Timeout configurado:", timeoutMs, "ms");

      while (Date.now() - startTs < timeoutMs) {
        const resultRows = findResultRows();

        if (resultRows.length > 0 && !sawVisibleRows) {
          console.log("[BeLeadAI] Dropdown apareció con", resultRows.length, "filas");
          resultRows.forEach((row, idx) => {
            const textUsers = rowTextUsernameCandidates(row);
            const hrefUsers = [...rowCandidateUsernames(row)];
            console.log(
              `[BeLeadAI] Fila ${idx + 1}: textUsers=[${textUsers.join(", ")}], hrefUsers=[${hrefUsers.join(", ")}]`
            );
          });
        }

        if (resultRows.length > 0) {
          sawVisibleRows = true;
        }

        const elapsed = Date.now() - startTs;
        const clickPlan = [];

        for (const row of resultRows) {
          const strong = rowStrongMatch(row, uname);
          if (strong) {
            strong.confidence = "strong";
            console.log("[BeLeadAI] Match FUERTE encontrado:", strong.reason, "para @" + uname);
            clickPlan.push({ priority: 0, match: strong });
            continue;
          }

          if (elapsed > 4500) {
            const soft = rowSoftMatch(row, uname);
            if (
              soft &&
              (rowHasExtraIdentitySignal(row, uname) || rowHasTextExactUsername(row, uname))
            ) {
              soft.confidence = "soft";
              console.log("[BeLeadAI] Match DEBIL encontrado (con señal extra) para @" + uname);
              clickPlan.push({ priority: 1, match: soft });
            }
          }
        }

        if (clickPlan.length === 0 && resultRows.length === 1 && elapsed > 8000) {
          if (
            rowHasExtraIdentitySignal(resultRows[0], uname) ||
            rowHasTextExactUsername(resultRows[0], uname)
          ) {
            clickPlan.push({
              priority: 2,
              match: {
                row: resultRows[0],
                reason: "single-visible-row",
                href: null,
                confidence: "soft",
              },
            });
          } else {
            console.warn(
              "[BeLeadAI] Se descarta single-visible-row sin señal extra de identidad para @" +
                uname
            );
          }
        }

        clickPlan.sort((a, b) => a.priority - b.priority);

        let clickedAny = false;
        for (const item of clickPlan) {
          const candidate = item.match;
          if (wasRowTriedRecently(candidate.row)) continue;
          attemptedRows.set(candidate.row, Date.now());
          clickedAny = true;
          console.log(
            "[BeLeadAI] Intentando candidato (reason=" +
              candidate.reason +
              ", priority=" +
              item.priority +
              ", rows=" +
              resultRows.length +
              "). Click + verify."
          );
          lastDirectThreadCandidateUsername = pickBestRowUsername(candidate.row, uname);
          lastDirectThreadCandidateConfidence = candidate.confidence || "soft";
          if (lastDirectThreadCandidateUsername && lastDirectThreadCandidateUsername === uname) {
            lastDirectThreadCandidateConfidence = "strong";
          }
          if (lastDirectThreadCandidateUsername) {
            console.log(
              "[BeLeadAI] Username candidato desde row:",
              lastDirectThreadCandidateUsername
            );
          }
          clickRow(candidate.row);
          await sleep(1700);
          if (await waitForThreadOpened(6000)) {
            console.log("[BeLeadAI] Thread ABIERTO EXITOSAMENTE para @" + uname);
            console.log("[BeLeadAI] ========== FIN directSearchAndOpenThread (EXITO) ==========");
            return true;
          }
          console.warn(
            "[BeLeadAI] Candidato clickeado pero no abrió thread, probando siguiente..."
          );
        }

        if (!clickedAny) {
          if (resultRows.length > 0) {
            if (Date.now() - lastDebugLogTs > 1200) {
              const sample = (resultRows[0].innerText || resultRows[0].textContent || "")
                .replace(/\s+/g, " ")
                .trim()
                .slice(0, 90);
              console.log("[BeLeadAI] Ejemplo primera fila dropdown:", sample || "(vacío)");
              lastDebugLogTs = Date.now();
            }
            console.log(
              "[BeLeadAI] Dropdown visible con " +
                resultRows.length +
                " filas, sin match fuerte para @" +
                uname +
                " (t=" +
                elapsed +
                "ms)."
            );
          } else {
            console.log("[BeLeadAI] Dropdown sin resultados visibles aún (t=" + elapsed + "ms).");
          }
        }

        await sleep(pollMs);
      }

      console.error(
        "[BeLeadAI] ERROR: Timeout buscando resultado fuerte para @" +
          uname +
          " (dropdown visible=" +
          sawVisibleRows +
          ", tiempo=" +
          (Date.now() - startTs) +
          "ms)."
      );
      const openedByKeyboardFallback = await attemptKeyboardOpenFirstResult();
      if (openedByKeyboardFallback) {
        if (!lastDirectThreadCandidateUsername) {
          lastDirectThreadCandidateUsername = uname;
        }
        if (!lastDirectThreadCandidateConfidence) {
          lastDirectThreadCandidateConfidence = "soft";
        }
        console.log("[BeLeadAI] Thread abierto con fallback de teclado tras timeout de dropdown.");
        console.log(
          "[BeLeadAI] ========== FIN directSearchAndOpenThread (EXITO por fallback) =========="
        );
        return true;
      }
      lastDirectThreadCandidateUsername = null;
      lastDirectThreadCandidateConfidence = null;
      console.error(
        "[BeLeadAI] ERROR FINAL: No se encontró resultado de búsqueda para",
        maskUsername(username)
      );
      console.error("[BeLeadAI] ========== FIN directSearchAndOpenThread (FALLIDO) ==========");
      return false;
    }

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
      for (let i = messageNodes.length - 1; i >= lowerBound; i--) {
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
        await humanDelay(2000, 3500);
        result.steps.push("search_user");
        const okSearch = await directSearchAndOpenThread(username);
        if (!okSearch) {
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
          await sleep(1200);
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

      await sleep(1500);
      return true;
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

    function getCookie(name) {
      const parts = ("; " + (document.cookie || "")).split("; " + name + "=");
      if (parts.length !== 2) return null;
      const value = parts[1].split(";")[0].trim();
      return value || null;
    }

    function getCurrentInstagramUsername() {
      const dsUserId = getCookie("ds_user_id");
      if (dsUserId && String(dsUserId).trim()) {
        return { user_id: String(dsUserId).trim(), username: null, source: "cookie" };
      }
      return { user_id: null, username: null, source: "not_found" };
    }

    return {
      sendDM,
      getCurrentInstagramUsername,
      normalizeIgUsername,
      isLikelyIgUsername,
      navigateToProfile,
      navigateToDirect,
      directSearchAndOpenThread,
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
