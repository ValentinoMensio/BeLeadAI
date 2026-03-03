(function initContentMessagingModule(globalScope) {
  function createContentMessagingModule({ actionsModule, csBuild }) {
    function registerMessageHandlers() {
      chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
        if (sender?.id !== chrome.runtime.id) {
          sendResponse({ success: false, error: 'unauthorized_sender' });
          return false;
        }
        if (!message || typeof message !== 'object' || typeof message.action !== 'string') {
          sendResponse({ success: false, error: 'invalid_message' });
          return false;
        }

        if (message.action === 'send_dm') {
          const { username, text, dryRun } = message;

          actionsModule
            .sendDM(username, text, dryRun !== false)
            .then((result) => {
              sendResponse(result);
            })
            .catch((err) => {
              console.error('[BeLeadAI CS] send_dm error:', err?.message || err);
              sendResponse({ success: false, error: err.message });
            });

          return true;
        }

        if (message.action === 'ping') {
          sendResponse({ status: 'ok', url: window.location.href });
          return false;
        }

        if (message.action === 'content_ready') {
          sendResponse({ ready: true, url: window.location.href, build: csBuild });
          return false;
        }

        if (message.action === 'get_current_username') {
          const r = actionsModule.getCurrentInstagramUsername();
          console.log('[BeLeadAI CS] get_current_username →', r?.user_id ? 'detectado' : 'no detectado', '(source:', r?.source || '—', ')');
          sendResponse(r);
          return false;
        }

        return false;
      });
    }

    return {
      registerMessageHandlers,
    };
  }

  globalScope.createContentMessagingModule = createContentMessagingModule;
})(self);
