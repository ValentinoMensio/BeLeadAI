(function initBackgroundJobsRuntimeModule(globalScope) {
  function createBackgroundJobsRuntimeModule({
    maskIdentity,
    updateProgress,
    sendDmTotalTimeoutMs = 120000,
  }) {
    const PACING = Object.freeze({
      retryPollMs: 180,
      handshakeRetryMinMs: 160,
      handshakeRetryMaxMs: 320,
      navigationSettleMinMs: 280,
      navigationSettleMaxMs: 760,
      preSendSettleMinMs: 180,
      preSendSettleMaxMs: 420,
      recoverySettleMinMs: 260,
      recoverySettleMaxMs: 650,
    });

    function randomBetween(min, max) {
      return Math.floor(Math.random() * (max - min + 1)) + min;
    }

    function sleep(ms) {
      return new Promise((resolve) => setTimeout(resolve, ms));
    }

    async function humanizedPause(minMs, maxMs) {
      await sleep(randomBetween(minMs, maxMs));
    }

    async function getLoggedInUsername() {
      try {
        const tabs = await chrome.tabs.query({
          url: ["https://www.instagram.com/*", "https://instagram.com/*"],
        });
        const tab = tabs.find((t) => t.active) || tabs[0];
        if (tab?.id) {
          try {
            const r = await chrome.tabs.sendMessage(tab.id, { action: "get_current_username" });
            const username = String(r?.username || "")
              .trim()
              .toLowerCase();
            if (username) return username;
            const userId = String(r?.user_id || "").trim();
            if (userId) return userId;
          } catch {
            // keep searching via next fallback
          }
        }
        const cookie = await chrome.cookies.get({
          url: "https://www.instagram.com",
          name: "ds_user_id",
        });
        if (cookie?.value) {
          const igUserId = String(cookie.value).trim();
          return igUserId || null;
        }
        return null;
      } catch {
        return null;
      }
    }

    async function findOrCreateInstagramTab() {
      const tabs = await chrome.tabs.query({
        url: ["https://www.instagram.com/*", "https://instagram.com/*"],
      });

      if (tabs.length > 0) {
        const directTab = tabs.find((t) => (t?.url || "").includes("instagram.com/direct"));
        if (directTab) return directTab;
        return tabs[0];
      }

      const newTab = await chrome.tabs.create({
        url: "https://www.instagram.com/",
        active: false,
      });

      await new Promise((resolve) => {
        const listener = (tabId, info) => {
          if (tabId === newTab.id && info.status === "complete") {
            chrome.tabs.onUpdated.removeListener(listener);
            resolve();
          }
        };
        chrome.tabs.onUpdated.addListener(listener);

        setTimeout(() => {
          chrome.tabs.onUpdated.removeListener(listener);
          resolve();
        }, 15000);
      });

      return newTab;
    }

    async function waitTabLoadComplete(tabId, timeoutMs = 8000) {
      return new Promise((resolve) => {
        const listener = (updatedTabId, info) => {
          if (updatedTabId === tabId && info.status === "complete") {
            chrome.tabs.onUpdated.removeListener(listener);
            resolve(true);
          }
        };
        chrome.tabs.onUpdated.addListener(listener);
        setTimeout(() => {
          chrome.tabs.onUpdated.removeListener(listener);
          resolve(false);
        }, timeoutMs);
      });
    }

    async function ensureContentScriptReady(tabId, maxTries = 3) {
      let lastErr = null;
      for (let i = 1; i <= maxTries; i += 1) {
        try {
          const r = await chrome.tabs.sendMessage(tabId, { action: "content_ready" });
          if (r && r.ready) {
            console.log(
              "[BG] Handshake content_ready OK (tab",
              tabId,
              ", intento",
              i,
              ", build",
              r.build || "n/a",
              ")"
            );
            return true;
          }
        } catch (e) {
          lastErr = e;
          const isReceivingEnd = (e.message || "").includes("Receiving end does not exist");
          if (!isReceivingEnd) {
            console.warn("[BG] Handshake content_ready falló:", e.message || e);
            await humanizedPause(PACING.handshakeRetryMinMs, PACING.handshakeRetryMaxMs);
            continue;
          }

          if (i < maxTries) {
            console.warn(
              "[BG] Content script no listo (handshake), recargando tab y reintentando..."
            );
            try {
              await chrome.tabs.reload(tabId);
            } catch {}
            await waitTabLoadComplete(tabId, 8000);
            await humanizedPause(PACING.navigationSettleMinMs, PACING.navigationSettleMaxMs);
          }
        }
      }
      if (lastErr) {
        console.warn("[BG] Handshake content_ready no logró conectar:", lastErr.message || lastErr);
      }
      return false;
    }

    async function ensureInstagramDirectReady(maxAttempts = 2) {
      const attempts = Math.max(1, Number(maxAttempts || 1));
      const directUrl = "https://www.instagram.com/direct/";
      let lastError = "instagram_direct_not_ready";

      for (let attempt = 1; attempt <= attempts; attempt += 1) {
        try {
          const tab = await findOrCreateInstagramTab();
          if (!tab?.id) {
            lastError = "instagram_tab_not_found";
            continue;
          }

          let currentTab = null;
          try {
            currentTab = await chrome.tabs.get(tab.id);
          } catch {
            lastError = "instagram_tab_closed";
            continue;
          }

          const currentUrl = String(currentTab?.url || tab.url || "");
          if (!currentUrl.includes("instagram.com/direct")) {
            await chrome.tabs.update(tab.id, { url: directUrl });
            await waitTabLoadComplete(tab.id, 10000);
            await humanizedPause(PACING.navigationSettleMinMs, PACING.navigationSettleMaxMs);
          }

          try {
            currentTab = await chrome.tabs.get(tab.id);
          } catch {
            lastError = "instagram_tab_closed_after_update";
            continue;
          }
          if (!currentTab?.url || !String(currentTab.url).includes("instagram.com")) {
            lastError = "instagram_tab_not_on_instagram";
            continue;
          }

          const csReady = await ensureContentScriptReady(tab.id, 3);
          if (csReady) {
            return { ok: true, tabId: tab.id };
          }
          lastError = "content_script_not_ready";
        } catch (e) {
          lastError = String(e?.message || e || "instagram_recovery_failed");
        }
      }

      return { ok: false, error: lastError };
    }

    async function sendDMViaContentScript(username, message, dryRun = true) {
      console.log(`[BG] Enviando DM a ${maskIdentity(username)}, dryRun: ${dryRun}`);

      try {
        const recoveredInitial = await ensureInstagramDirectReady(2);
        if (!recoveredInitial?.ok || !recoveredInitial?.tabId) {
          return {
            success: false,
            error: "instagram_recovery_failed",
            detail: "No se pudo recuperar automaticamente la pestaña de Instagram Direct.",
          };
        }
        let activeTabId = recoveredInitial.tabId;
        await humanizedPause(PACING.preSendSettleMinMs, PACING.preSendSettleMaxMs);

        const payload = {
          action: "send_dm",
          username,
          text: message,
          dryRun,
        };
        const maxTries = 3;
        let lastErr = null;
        for (let tryNum = 1; tryNum <= maxTries; tryNum += 1) {
          try {
            console.log(
              "[BG] Enviando mensaje send_dm al content script (tab",
              activeTabId,
              ", intento",
              tryNum,
              ")"
            );
            const result = await chrome.tabs.sendMessage(activeTabId, payload);
            console.log("[BG] Resultado send_dm:", result?.success ? "ok" : "error");
            if (result) {
              updateProgress("content_ack");
            }
            if (!result.success && result.error) {
              console.error("[BG] send_dm falló:", result.error || "unknown_error");
            }
            return result;
          } catch (e) {
            lastErr = e;
            const rawMsg = String(e?.message || e || "");
            const lowerMsg = rawMsg.toLowerCase();
            const shouldRecoverTab =
              lowerMsg.includes("receiving end does not exist") ||
              lowerMsg.includes("no tab with id") ||
              lowerMsg.includes("tabs cannot be edited") ||
              lowerMsg.includes("cannot access a chrome://");
            if (shouldRecoverTab && tryNum < maxTries) {
              console.warn("[BG] send_dm sin tab usable, intentando recuperación agresiva...");
              const recovered = await ensureInstagramDirectReady(2);
              if (!recovered?.ok || !recovered?.tabId) {
                throw e;
              }
              activeTabId = recovered.tabId;
              await humanizedPause(PACING.recoverySettleMinMs, PACING.recoverySettleMaxMs);
            } else {
              throw e;
            }
          }
        }
        throw lastErr;
      } catch (e) {
        console.error("[BG] sendDMViaContentScript error:", e);
        const msg = (e && e.message) || String(e);
        if (msg.includes("Receiving end does not exist")) {
          return {
            success: false,
            error:
              "Extensión no conectada a la pestaña. Abre una pestaña en instagram.com/direct/ (o recarga la de Instagram) y vuelve a Iniciar.",
          };
        }
        if (msg.includes("instagram_recovery_failed")) {
          return {
            success: false,
            error:
              "No se pudo recuperar la pestaña de Instagram Direct automáticamente. Abrila manualmente y reintentá.",
          };
        }
        return { success: false, error: msg };
      }
    }

    async function sendDMViaContentScriptWithTimeout(username, message, dryRun = true) {
      return Promise.race([
        sendDMViaContentScript(username, message, dryRun),
        new Promise((resolve) =>
          setTimeout(
            () => resolve({ success: false, error: "send_dm_timeout", timeout: true }),
            sendDmTotalTimeoutMs
          )
        ),
      ]);
    }

    return {
      getLoggedInUsername,
      findOrCreateInstagramTab,
      waitTabLoadComplete,
      ensureContentScriptReady,
      ensureInstagramDirectReady,
      sendDMViaContentScript,
      sendDMViaContentScriptWithTimeout,
    };
  }

  globalScope.createBackgroundJobsRuntimeModule = createBackgroundJobsRuntimeModule;
})(self);
