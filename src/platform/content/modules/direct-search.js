(function initContentDirectSearchModule(globalScope) {
  function createContentDirectSearchModule({
    selectorsModule,
    observersModule,
    inputActionsModule,
    maskUsername,
  }) {
    const { HUMAN_CONFIG, isElementVisible, humanDelay, waitForCondition, waitForElement, sleep } =
      selectorsModule;
    const { waitForThreadOpened } = observersModule;
    const { writeSearchQuery, normalizeSearchValue } = inputActionsModule;

    function escapeRegex(v) {
      return String(v).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }

    function normalizeUsernameToken(v) {
      return String(v || "")
        .trim()
        .replace(/^@+/, "")
        .toLowerCase();
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
        if (!(t.includes("more accounts") || t.includes("más cuentas") || t === "accounts")) continue;

        let scope =
          h.closest('div[style*="--x-minHeight"]') ||
          h.closest('div[role="dialog"]') ||
          h.closest("section") ||
          h.parentElement;

        for (let i = 0; i < 6 && scope; i += 1) {
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

    async function attemptKeyboardOpenFirstResult(searchInput) {
      try {
        console.warn("[BeLeadAI] Fallback teclado: Enter sobre búsqueda");
        searchInput.focus();
        searchInput.dispatchEvent(
          new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true })
        );
        searchInput.dispatchEvent(
          new KeyboardEvent("keyup", { key: "Enter", code: "Enter", bubbles: true })
        );
        const openedByEnter = await waitForCondition(() => waitForThreadOpened(900), {
          timeout: 2400,
          pollMs: 160,
          settleMinMs: 120,
          settleMaxMs: 320,
        });
        if (openedByEnter) return true;

        console.warn("[BeLeadAI] Fallback teclado: ArrowDown + Enter");
        searchInput.dispatchEvent(
          new KeyboardEvent("keydown", { key: "ArrowDown", code: "ArrowDown", bubbles: true })
        );
        searchInput.dispatchEvent(
          new KeyboardEvent("keyup", { key: "ArrowDown", code: "ArrowDown", bubbles: true })
        );
        await humanDelay(140, 260);
        searchInput.dispatchEvent(
          new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true })
        );
        searchInput.dispatchEvent(
          new KeyboardEvent("keyup", { key: "Enter", code: "Enter", bubbles: true })
        );
        return !!(await waitForCondition(() => waitForThreadOpened(900), {
          timeout: 2800,
          pollMs: 180,
          settleMinMs: 120,
          settleMaxMs: 320,
        }));
      } catch {
        return false;
      }
    }

    function normalizeHrefPath(href) {
      if (!href) return "";
      let path = href.trim().toLowerCase();
      if (path.startsWith("http://") || path.startsWith("https://")) {
        try {
          path = new URL(path).pathname || "";
        } catch {
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
        } catch {}
      }
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
        return { ok: false, candidateUsername: null, candidateConfidence: null };
      }
      console.log(
        "[BeLeadAI] Input de búsqueda encontrado:",
        searchInput.placeholder || searchInput.getAttribute("aria-label") || "sin placeholder"
      );
      searchInput.focus();
      await humanDelay(300, 600);
      const typedOk = await writeSearchQuery(searchInput, username);
      if (!typedOk) {
        console.warn(
          "[BeLeadAI] No se pudo mantener el query completo en el buscador; seguimos con fallback.",
          maskUsername(username)
        );
      }
      const currentSearchValue = normalizeSearchValue(searchInput.value || searchInput.textContent || "");
      console.log(
        "[BeLeadAI] Username ingresado en input:",
        maskUsername(username),
        "actual_len=",
        currentSearchValue.length
      );
      const uname = String(username || "")
        .trim()
        .replace(/^@+/, "")
        .toLowerCase();
      console.log("[BeLeadAI] Username normalizado para matching:", uname);

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
        const currentValue = normalizeSearchValue(searchInput.value || searchInput.textContent || "");
        if (currentValue !== uname && Date.now() - startTs > 1200) {
          console.warn(
            "[BeLeadAI] Query se desincronizó (actual=",
            maskUsername(currentValue),
            "), reescribiendo..."
          );
          await writeSearchQuery(searchInput, uname);
          await humanDelay(120, 260);
        }
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

        if (resultRows.length > 0) sawVisibleRows = true;

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
            if (soft && (rowHasExtraIdentitySignal(row, uname) || rowHasTextExactUsername(row, uname))) {
              soft.confidence = "soft";
              console.log("[BeLeadAI] Match DEBIL encontrado (con señal extra) para @" + uname);
              clickPlan.push({ priority: 1, match: soft });
            }
          }
        }

        if (clickPlan.length === 0 && resultRows.length === 1 && elapsed > 8000) {
          if (rowHasExtraIdentitySignal(resultRows[0], uname) || rowHasTextExactUsername(resultRows[0], uname)) {
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
              "[BeLeadAI] Se descarta single-visible-row sin señal extra de identidad para @" + uname
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
          const candidateUsername = pickBestRowUsername(candidate.row, uname);
          let candidateConfidence = candidate.confidence || "soft";
          if (candidateUsername && candidateUsername === uname) {
            candidateConfidence = "strong";
          }
          if (candidateUsername) {
            console.log("[BeLeadAI] Username candidato desde row:", candidateUsername);
          }
          clickRow(candidate.row);
          const opened = await waitForCondition(() => waitForThreadOpened(900), {
            timeout: 2800,
            pollMs: 180,
            settleMinMs: 150,
            settleMaxMs: 360,
          });
          if (opened || (await waitForThreadOpened(3600))) {
            console.log("[BeLeadAI] Thread ABIERTO EXITOSAMENTE para @" + uname);
            console.log("[BeLeadAI] ========== FIN directSearchAndOpenThread (EXITO) ==========");
            return {
              ok: true,
              candidateUsername: candidateUsername || uname,
              candidateConfidence,
            };
          }
          console.warn("[BeLeadAI] Candidato clickeado pero no abrió thread, probando siguiente...");
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
      const openedByKeyboardFallback = await attemptKeyboardOpenFirstResult(searchInput);
      if (openedByKeyboardFallback) {
        console.log("[BeLeadAI] Thread abierto con fallback de teclado tras timeout de dropdown.");
        console.log("[BeLeadAI] ========== FIN directSearchAndOpenThread (EXITO por fallback) ==========");
        return { ok: true, candidateUsername: uname, candidateConfidence: "soft" };
      }
      console.error("[BeLeadAI] ERROR FINAL: No se encontró resultado de búsqueda para", maskUsername(username));
      console.error("[BeLeadAI] ========== FIN directSearchAndOpenThread (FALLIDO) ==========");
      return { ok: false, candidateUsername: null, candidateConfidence: null };
    }

    return {
      directSearchAndOpenThread,
    };
  }

  globalScope.createContentDirectSearchModule = createContentDirectSearchModule;
})(self);
