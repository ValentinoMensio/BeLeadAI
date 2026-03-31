(function initBackgroundMessagingModule(globalScope) {
  function createBackgroundMessagingModule({
    jobsModule,
    authModule,
    wsModule,
    ensureJobsWsDebounceMs,
  }) {
    let lastEnsureJobsWsConnectTs = 0;

    function registerMessageHandlers() {
      chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
        if (sender?.id !== chrome.runtime.id) {
          sendResponse({ error: "unauthorized_sender" });
          return false;
        }
        if (!message || typeof message !== "object" || typeof message.action !== "string") {
          sendResponse({ error: "invalid_message" });
          return false;
        }
        const allowedActions = new Set([
          "start_sender",
          "stop_sender",
          "get_sender_status",
          "sender_heartbeat_now",
          "process_now",
          "auth_login",
          "auth_logout",
          "auth_logout_all",
          "auth_get_state",
          "auth_ensure_fresh_access",
          "getAuthHeaders",
          "get_logged_in_username",
          "ensureJobsWsConnected",
        ]);
        if (!allowedActions.has(message.action)) {
          sendResponse({ error: "unsupported_action" });
          return false;
        }

        if (message.action === "start_sender") {
          jobsModule
            .startSender({
              deferFirstPull: !!message.defer_first_pull,
              allowIdleStart: !!message.allow_idle_start,
              fromAccountHint: String(message.from_account_hint || ""),
            })
            .then(sendResponse)
            .catch((e) => {
              console.warn("[BG] start_sender failed:", e?.message || e);
              sendResponse({ status: "error", reason: e?.message || "start_sender_failed" });
            });
          return true;
        }

        if (message.action === "stop_sender") {
          jobsModule
            .stopSender("manual")
            .then(sendResponse)
            .catch((e) => {
              console.warn("[BG] stop_sender failed:", e?.message || e);
              sendResponse({ status: "error", reason: e?.message || "stop_sender_failed" });
            });
          return true;
        }

        if (message.action === "get_sender_status") {
          jobsModule
            .getSenderStatus()
            .then(sendResponse)
            .catch((e) => {
              console.warn("[BG] get_sender_status failed:", e?.message || e);
              sendResponse({ status: "error", reason: e?.message || "get_sender_status_failed" });
            });
          return true;
        }

        if (message.action === "sender_heartbeat_now") {
          const fromAccountHint = String(message.from_account || "");
          jobsModule
            .sendSenderHeartbeat(true, fromAccountHint)
            .then(async (ok) => {
              let status = null;
              try {
                status = await jobsModule.getSenderStatus();
              } catch {
                status = null;
              }
              sendResponse({
                ok: !!ok,
                from_account:
                  String(status?.fromAccount || "")
                    .trim()
                    .toLowerCase() || null,
              });
            })
            .catch((e) => {
              console.warn("[BG] sender_heartbeat_now failed:", e?.message || e);
              sendResponse({ ok: false, reason: e?.message || "sender_heartbeat_now_failed" });
            });
          return true;
        }

        if (message.action === "process_now") {
          jobsModule.triggerProcessNextTaskThrottled("process_now");
          sendResponse({ status: "processed" });
          return true;
        }

        if (message.action === "getAuthHeaders") {
          (async () => {
            try {
              const cfg = await authModule.loadSettings();
              const headers = await authModule.getAuthHeaders(cfg);
              sendResponse({ headers });
            } catch (e) {
              console.warn("[BG] getAuthHeaders", e);
              sendResponse({ headers: {} });
            }
          })();
          return true;
        }

        if (message.action === "auth_login") {
          (async () => {
            try {
              const cfg = await authModule.loadSettings();
              const apiBase = String(message.api_base || cfg.api_base || "").trim();
              const apiToken = String(message.api_token || "").trim();
              const result = await authModule.loginWithResult(apiBase, apiToken);
              sendResponse({
                ok: !!result?.ok,
                status: Number(result?.status || 0) || 0,
                error: result?.error || null,
              });
            } catch {
              sendResponse({
                ok: false,
                status: 0,
                error: { code: "NETWORK_ERROR", message: "Error de red al iniciar sesión." },
              });
            }
          })();
          return true;
        }

        if (message.action === "auth_ensure_fresh_access") {
          (async () => {
            try {
              const cfg = await authModule.loadSettings();
              const token = await authModule.ensureFreshAccessToken(cfg, {
                force: !!message.force,
              });
              sendResponse({ ok: !!token });
            } catch {
              sendResponse({ ok: false });
            }
          })();
          return true;
        }

        if (message.action === "auth_get_state") {
          (async () => {
            try {
              const authState = await authModule.getAuthState();
              sendResponse(authState);
            } catch {
              sendResponse({
                isAuthenticated: false,
                accessExpiresAt: 0,
                clientId: "",
                sessionId: "",
              });
            }
          })();
          return true;
        }

        if (message.action === "auth_logout") {
          (async () => {
            try {
              const result = await authModule.logoutDevice({
                revokeRemote: !!message.revoke_remote,
              });
              sendResponse({ ok: !!result?.ok, remoteOk: !!result?.remoteOk });
            } catch {
              sendResponse({ ok: false });
            }
          })();
          return true;
        }

        if (message.action === "auth_logout_all") {
          (async () => {
            try {
              const result = await authModule.logoutAllDevices({
                revokeRemote: !!message.revoke_remote,
              });
              sendResponse({ ok: !!result?.ok, remoteOk: !!result?.remoteOk });
            } catch {
              sendResponse({ ok: false });
            }
          })();
          return true;
        }

        if (message.action === "get_logged_in_username") {
          (async () => {
            try {
              const readCookieAccount = async () => {
                try {
                  const cookie = await chrome.cookies.get({
                    url: "https://www.instagram.com",
                    name: "ds_user_id",
                  });
                  const userId = String(cookie?.value || "").trim();
                  if (!userId) return null;
                  return {
                    username: null,
                    user_id: userId,
                    source: "cookie",
                    error: null,
                  };
                } catch {
                  return null;
                }
              };

              const tabs = await chrome.tabs.query({
                url: ["https://www.instagram.com/*", "https://instagram.com/*"],
              });
              const sortedTabs = (() => {
                const active = tabs.find((t) => t.active && t.id);
                if (!active) return tabs;
                return [active, ...tabs.filter((t) => t?.id !== active.id)];
              })();
              for (const tab of sortedTabs) {
                if (!tab?.id) continue;
                let r = null;
                try {
                  r = await chrome.tabs.sendMessage(tab.id, { action: "get_current_username" });
                } catch {
                  continue;
                }
                const username = String(r?.username || "")
                  .trim()
                  .toLowerCase();
                const userId = String(r?.user_id || "").trim();
                if (username || userId) {
                  sendResponse({
                    username: username || null,
                    user_id: userId || null,
                    source: r?.source || null,
                    error: null,
                  });
                  return;
                }
              }

              const cookieAccount = await readCookieAccount();
              if (cookieAccount) {
                sendResponse(cookieAccount);
                return;
              }

              if (tabs.length === 0) {
                sendResponse({
                  username: null,
                  user_id: null,
                  source: null,
                  error: "no_instagram_tab",
                });
                return;
              }

              sendResponse({
                username: null,
                user_id: null,
                source: null,
                error: "account_not_detected",
              });
            } catch (e) {
              console.warn("[BeLeadAI BG] get_logged_in_username:", e);
              let cookieAccount = null;
              try {
                const cookie = await chrome.cookies.get({
                  url: "https://www.instagram.com",
                  name: "ds_user_id",
                });
                const userId = String(cookie?.value || "").trim();
                if (userId) {
                  cookieAccount = {
                    username: null,
                    user_id: userId,
                    source: "cookie",
                    error: null,
                  };
                }
              } catch {}
              if (cookieAccount) {
                sendResponse(cookieAccount);
                return;
              }
              sendResponse({
                username: null,
                user_id: null,
                source: null,
                error: e?.message || "tab_or_script_error",
              });
            }
          })();
          return true;
        }

        if (message.action === "ensureJobsWsConnected") {
          const now = Date.now();
          if (now - lastEnsureJobsWsConnectTs < ensureJobsWsDebounceMs) {
            sendResponse({ ok: true, debounced: true });
            return true;
          }
          lastEnsureJobsWsConnectTs = now;
          authModule
            .loadSettings()
            .then((cfg) => {
              if (cfg.api_base) wsModule.connectJobsWs(cfg);
              sendResponse({ ok: true });
            })
            .catch((e) => {
              console.warn("[BG] ensureJobsWsConnected failed:", e?.message || e);
              sendResponse({ ok: false, error: e?.message || "ensure_jobs_ws_failed" });
            });
          return true;
        }

        return false;
      });
    }

    return {
      registerMessageHandlers,
    };
  }

  globalScope.createBackgroundMessagingModule = createBackgroundMessagingModule;
})(self);
