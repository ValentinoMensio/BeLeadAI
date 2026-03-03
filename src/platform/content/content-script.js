// content_script.js - BeLeadAI DM Sender (Humanizado)
// Se ejecuta en instagram.com/* y maneja el envío de DMs con comportamiento humanizado

(function initContentScript() {
  "use strict";

  const CS_BUILD = "2026-02-09-csp-fix";

  const selectorsModule = self.createContentSelectorsModule();
  const observersModule = self.createContentObserversModule({ selectorsModule });
  const actionsModule = self.createContentActionsModule({ selectorsModule, observersModule });
  const messagingModule = self.createContentMessagingModule({ actionsModule, csBuild: CS_BUILD });

  messagingModule.registerMessageHandlers();

  console.log("[BeLeadAI] Content script cargado. build:", CS_BUILD);
})();
