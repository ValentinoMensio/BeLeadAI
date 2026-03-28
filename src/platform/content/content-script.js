// content_script.js - BeLeadAI DM Sender (Humanizado)
// Se ejecuta en instagram.com/* y maneja el envío de DMs con comportamiento humanizado

(function initContentScript() {
  "use strict";

  const CS_BUILD = "2026-02-09-csp-fix";
  const maskUsername = (value) => {
    const raw = String(value || "").trim();
    if (!raw) return "unknown";
    if (raw.length <= 2) return "*".repeat(raw.length);
    return `${raw.slice(0, 2)}***`;
  };

  const selectorsModule = self.createContentSelectorsModule();
  const observersModule = self.createContentObserversModule({ selectorsModule });
  const inputActionsModule = self.createContentInputActionsModule({ selectorsModule });
  const accountIdentityModule = self.createContentAccountIdentityModule({ observersModule });
  const directSearchModule = self.createContentDirectSearchModule({
    selectorsModule,
    observersModule,
    inputActionsModule,
    maskUsername,
  });
  const messageActionsModule = self.createContentMessageActionsModule({
    selectorsModule,
    typeHumanLike: (...args) => inputActionsModule.typeHumanLike(...args),
  });
  const actionsModule = self.createContentActionsModule({
    selectorsModule,
    observersModule,
    inputActionsModule,
    directSearchModule,
    messageActionsModule,
    accountIdentityModule,
  });
  const messagingModule = self.createContentMessagingModule({ actionsModule, csBuild: CS_BUILD });

  messagingModule.registerMessageHandlers();

  console.log("[BeLeadAI] Content script cargado. build:", CS_BUILD);
})();
