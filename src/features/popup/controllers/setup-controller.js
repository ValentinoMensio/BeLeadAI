/**
 * Controlador de setup: pantalla de configuración, validación, transición a UI principal.
 */

function isValidApiBase(url) {
  if (!url || typeof url !== "string") return false;
  try {
    const u = new URL(url.trim().startsWith("http") ? url.trim() : "https://" + url.trim());
    return u.protocol === "https:";
  } catch {
    return false;
  }
}

function hasAuth(cfg) {
  if ((cfg.jwt_token || "").toString().trim()) return true;
  return false;
}

function openOptions() {
  if (chrome.runtime.openOptionsPage) chrome.runtime.openOptionsPage();
  else window.open(chrome.runtime.getURL("options.html"));
}

/**
 * @param {{ store, services, ui, dom }} deps
 * @returns {{ showSetup, hideSetup, updateSetupChecklist, refreshTabAccountDisplay, bindSetupEvents }}
 */
export function initSetup(deps) {
  const { store, ui, dom } = deps;
  const { getState } = store;
  const { qs } = dom;

  function updateSetupChecklist(cfg, opts = {}) {
    const apiOk = opts.apiReachable !== undefined ? opts.apiReachable : isValidApiBase(cfg.api_base);
    const tokenOk = opts.tokenOk !== undefined ? opts.tokenOk : hasAuth(cfg);
    const checkApi = qs("#check-api");
    const checkToken = qs("#check-token");
    if (checkApi) {
      checkApi.className = `checklist-item ${apiOk ? "ok" : "missing"}`;
      const icon = checkApi.querySelector(".check-icon");
      if (icon) icon.textContent = apiOk ? "✓" : "✗";
    }
    if (checkToken) {
      checkToken.className = `checklist-item ${tokenOk ? "ok" : "missing"}`;
      const icon = checkToken.querySelector(".check-icon");
      if (icon) icon.textContent = tokenOk ? "✓" : "✗";
    }
    refreshTabAccountDisplay();
  }

  async function refreshTabAccountDisplay() {
    const labelEl = document.getElementById("check-tab-label");
    const iconEl = document.getElementById("check-tab-icon");
    const rowEl = document.getElementById("check-tab-account");
    const sendHintEl = document.getElementById("send-tab-account-hint");
    try {
      const r = await chrome.runtime.sendMessage({ action: "get_logged_in_username" });
      const tabDisplay = r?.username ? "@" + r.username : r?.user_id != null ? "ID: " + r.user_id : "";
      if (tabDisplay) {
        if (labelEl) labelEl.textContent = "Cuenta en pestaña: " + tabDisplay;
        if (iconEl) iconEl.textContent = "✓";
        if (rowEl) {
          rowEl.className = "checklist-item ok";
          rowEl.title = "Los DMs se envían desde la cuenta con la que estés logueado en la pestaña de Instagram.";
        }
        if (sendHintEl) {
          sendHintEl.textContent = "Enviarás desde: " + tabDisplay;
          sendHintEl.style.color = "";
        }
      } else {
        const err = r?.error || "desconocido";
        if (labelEl) labelEl.textContent = err === "no_instagram_tab" ? "Cuenta en pestaña: abrí instagram.com" : "Cuenta en pestaña: no detectada";
        if (iconEl) iconEl.textContent = "○";
        if (rowEl) {
          rowEl.className = "checklist-item missing";
          rowEl.title = "Abrí instagram.com en una pestaña e iniciá sesión.";
        }
        if (sendHintEl) {
          sendHintEl.textContent =
            err === "no_instagram_tab"
              ? "Enviarás desde: — (abrí instagram.com en una pestaña e iniciá sesión)"
              : "Enviarás desde: — (iniciá sesión en instagram.com en una pestaña)";
          sendHintEl.style.color = "";
        }
      }
    } catch {
      if (labelEl) labelEl.textContent = "Cuenta en pestaña: —";
      if (iconEl) iconEl.textContent = "○";
      if (rowEl) rowEl.className = "checklist-item missing";
      if (sendHintEl) {
        sendHintEl.textContent = "Enviarás desde: — (abrí instagram.com en una pestaña para ver la cuenta)";
        sendHintEl.style.color = "";
      }
    }
  }

  function showSetup() {
    const setupScreen = qs("#setup-screen");
    const mainUi = qs("#main-ui");
    if (setupScreen) setupScreen.style.display = "flex";
    if (mainUi) mainUi.style.display = "none";
  }

  function hideSetup() {
    const setupScreen = qs("#setup-screen");
    const mainUi = qs("#main-ui");
    if (setupScreen) setupScreen.style.display = "none";
    if (mainUi) mainUi.style.display = "flex";
  }

  function bindSetupEvents() {
    const btnOptions = qs("#btn-open-options");
    const cfgStatus = qs("#cfgStatus");
    const footerNote = qs("#footer-note");
    const onOpenOptions = () => openOptions();
    if (btnOptions) btnOptions.addEventListener("click", onOpenOptions);
    if (cfgStatus) cfgStatus.addEventListener("click", onOpenOptions);
    if (footerNote) footerNote.addEventListener("click", onOpenOptions);

    function cleanup() {
      if (btnOptions) btnOptions.removeEventListener("click", onOpenOptions);
      if (cfgStatus) cfgStatus.removeEventListener("click", onOpenOptions);
      if (footerNote) footerNote.removeEventListener("click", onOpenOptions);
    }
    return cleanup;
  }

  return {
    showSetup,
    hideSetup,
    updateSetupChecklist,
    refreshTabAccountDisplay,
    bindSetupEvents,
    isValidApiBase,
    hasAuth,
  };
}
