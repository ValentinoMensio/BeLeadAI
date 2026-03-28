import { classifyLoginFailure, isSecureApiBase, normalizeBaseUrl } from "./options-shared.js";

export function createOptionsAuthController(deps) {
  const { dom, services, auth, ui, versioning, quotas, config, state } = deps;
  const { $ } = dom;
  const { storageLocalSet, storageLocalRemove } = services;
  const {
    getAuthStateFromBackground,
    ensureAuthFromBackground,
    ensureApiHostPermission,
    performAuthLoginRemote,
    logoutRemote,
  } = auth;
  const { setCfgStatus, setSaveStatus } = ui;
  const {
    persistPlanBlockState,
    clearPlanBlockState,
    persistVersionBlockState,
    clearVersionBlockState,
    showVersionBlockScreen,
    hideVersionBlockScreen,
  } = versioning;
  const { fetchQuotas } = quotas;
  const { promptMaxChars } = config;

  async function performAuthLogin(requestPermission = false) {
    const base = normalizeBaseUrl($("#api_base").value);
    const apiKey = ($("#api_token").value || "").trim();

    if (!base) {
      return {
        ok: false,
        status: 0,
        errorMessage: "Configura la API primero.",
        error: { code: "CONFIG_REQUIRED", message: "Configura la API primero." },
      };
    }
    if (!isSecureApiBase(base)) {
      return {
        ok: false,
        status: 0,
        errorMessage: "La API debe usar HTTPS.",
        error: { code: "HTTPS_REQUIRED", message: "La API debe usar HTTPS." },
      };
    }
    const hasPermission = await ensureApiHostPermission(base, requestPermission);
    if (!hasPermission) {
      return {
        ok: false,
        status: 0,
        errorMessage: "Falta permiso para conectar con el dominio de la API.",
        error: {
          code: "HOST_PERMISSION_REQUIRED",
          message: "Falta permiso para conectar con el dominio de la API.",
        },
      };
    }
    if (!apiKey) {
      return {
        ok: false,
        status: 0,
        errorMessage: "Configura la API Key primero.",
        error: { code: "API_KEY_REQUIRED", message: "Configura la API Key primero." },
      };
    }

    try {
      const loginResp = await performAuthLoginRemote(base, apiKey);
      if (!loginResp?.ok) {
        return {
          ok: false,
          status: Number(loginResp?.status || 0) || 0,
          errorMessage:
            String(loginResp?.errorMessage || "").trim() ||
            "No se pudo iniciar sesión. Revisá la API Key.",
          error: loginResp?.error || {
            code: "AUTH_ERROR",
            message: "No se pudo iniciar sesión. Revisá la API Key.",
          },
        };
      }
      const authState = await getAuthStateFromBackground();
      return {
        ok: true,
        access_expires_at: authState.accessExpiresAt,
        client_id: authState.clientId,
      };
    } catch {
      return {
        ok: false,
        status: 0,
        errorMessage: "Error de red o permisos.",
        error: { code: "NETWORK_ERROR", message: "Error de red o permisos." },
      };
    }
  }

  async function persistAuthState({ loginResult = null }) {
    const accessExpiresAt = Number(loginResult?.access_expires_at || 0) || 0;
    const clientId = loginResult?.client_id != null ? String(loginResult.client_id) : "";
    if (clientId) {
      await storageLocalSet({ client_id: clientId });
    }
    await clearPlanBlockState();
    await clearVersionBlockState();
    state.sessionAccessExpiresAt = accessExpiresAt;
    hideVersionBlockScreen();
  }

  async function clearAuthState() {
    state.sessionAccessExpiresAt = 0;
    await storageLocalRemove(["client_id"]);
    try {
      await logoutRemote(false);
    } catch {}
  }

  async function logoutSession({ allDevices = false } = {}) {
    let remoteResult = { ok: false, errorMessage: "No se pudo cerrar sesión en el servidor." };
    try {
      remoteResult = await logoutRemote(allDevices);
    } catch {
      remoteResult = { ok: false, errorMessage: "No se pudo cerrar sesión en el servidor." };
    }

    await clearAuthState();
    if ($("#api_token")) $("#api_token").value = "";
    if ($("#health_ping_result")) $("#health_ping_result").value = "—";
    if ($("#health_result")) $("#health_result").value = "—";

    if (remoteResult.ok) {
      setSaveStatus(
        allDevices
          ? "Sesión cerrada en todos los dispositivos."
          : "Sesión cerrada en este dispositivo."
      );
    } else if (allDevices) {
      setSaveStatus("Sesión local cerrada. La revocación global no está disponible en tu API.", true);
    } else {
      setSaveStatus("Sesión local cerrada.");
    }
    ui.refreshCfgStatus();
  }

  async function save() {
    const base = normalizeBaseUrl($("#api_base").value);
    const apiToken = ($("#api_token").value || "").trim();
    if (!isSecureApiBase(base)) {
      setSaveStatus("La API debe usar HTTPS.", true);
      return;
    }

    const syncCfg = {
      api_base: base,
      default_limit: parseInt($("#default_limit").value, 10) || 50,
      chatgpt_prompt: $("#chatgpt_prompt").value || "",
    };

    const hasInputApiKey = !!apiToken;
    if (!hasInputApiKey) {
      await ensureAuthFromBackground(true);
      const authState = await getAuthStateFromBackground();
      if (authState.isAuthenticated) {
        chrome.storage.sync.set(syncCfg, async () => {
          await storageLocalSet({
            client_id: String(authState.clientId || "").trim(),
          });
          state.sessionAccessExpiresAt = Number(authState.accessExpiresAt || 0) || 0;
          setSaveStatus("Guardado");
          ui.refreshCfgStatus();
          fetchQuotas({ cacheMode: "network-only" });
        });
        return;
      }
    }

    setSaveStatus("Validando login…");
    const loginResult = await performAuthLogin(true);
    if (!loginResult.ok) {
      const failureType = classifyLoginFailure(loginResult);
      if (failureType === "update_required") {
        await persistVersionBlockState(loginResult);
        showVersionBlockScreen({
          message: loginResult?.errorMessage,
          details: loginResult?.error?.details,
          update_url:
            loginResult?.error?.details?.updateUrl || loginResult?.error?.details?.update_url,
        });
        setSaveStatus("Guardado, pero tu extension debe actualizarse para continuar.", true);
      } else if (failureType === "plan_expired") {
        await persistPlanBlockState(loginResult);
        await clearVersionBlockState();
        hideVersionBlockScreen();
        setSaveStatus(
          "Guardado, pero tu plan venció. Renovalo para seguir usando el servicio.",
          true
        );
      } else if (failureType === "rate_limit") {
        await clearPlanBlockState();
        await clearVersionBlockState();
        hideVersionBlockScreen();
        setSaveStatus(
          "Guardado, pero el login fue limitado temporalmente (429). Esperá unos segundos y reintentá.",
          true
        );
      } else if (failureType === "auth") {
        await clearPlanBlockState();
        await clearVersionBlockState();
        hideVersionBlockScreen();
        setSaveStatus("Guardado, pero no se pudo iniciar sesión. Revisá la API Key.", true);
      } else {
        await clearPlanBlockState();
        await clearVersionBlockState();
        hideVersionBlockScreen();
        setSaveStatus(
          "Guardado, pero no se pudo conectar con la API. Revisá URL base e intentá de nuevo.",
          true
        );
      }
      chrome.storage.sync.set(syncCfg, async () => {
        if (apiToken) await clearAuthState();
        ui.refreshCfgStatus();
      });
      return;
    }

    chrome.storage.sync.set(syncCfg, async () => {
      await persistAuthState({ loginResult });
      setSaveStatus("Guardado");
      ui.refreshCfgStatus();
      fetchQuotas({ cacheMode: "network-only" });
    });
  }

  async function testHealth() {
    const resultEl = $("#health_ping_result");
    if (resultEl) resultEl.value = "Probando…";

    const base = normalizeBaseUrl($("#api_base").value);
    const apiKey = ($("#api_token").value || "").trim();

    if (!base) {
      if (resultEl) resultEl.value = "Configura la API primero.";
      return;
    }
    if (!apiKey) {
      if (resultEl) resultEl.value = "Configura la API Key primero.";
      return;
    }

    const result = await performAuthLogin(true);
    if (!result.ok) {
      const failureType = classifyLoginFailure(result);
      if (failureType === "update_required") {
        await persistVersionBlockState(result);
        showVersionBlockScreen({
          message: result?.errorMessage,
          details: result?.error?.details,
          update_url: result?.error?.details?.updateUrl || result?.error?.details?.update_url,
        });
        await clearPlanBlockState();
      } else if (failureType === "plan_expired") {
        await persistPlanBlockState(result);
        await clearVersionBlockState();
        hideVersionBlockScreen();
      } else {
        await clearPlanBlockState();
        await clearVersionBlockState();
        hideVersionBlockScreen();
      }
      if (resultEl) {
        resultEl.value =
          failureType === "plan_expired"
            ? "Tu plan venció. Renovalo para seguir usando el servicio."
            : failureType === "update_required"
              ? "Debes actualizar la extension para continuar."
              : failureType === "rate_limit"
                ? "Login limitado temporalmente (429). Esperá unos segundos y reintentá."
                : failureType === "auth"
                  ? "No se pudo iniciar sesión. Revisá la API Key."
                  : "No se pudo conectar con la API. Revisá URL base e intentá de nuevo.";
      }
      setCfgStatus("err", "Login falló");
      return;
    }
    await persistAuthState({ loginResult: result });
    if (resultEl) resultEl.value = "Login OK";
    setCfgStatus("ok", "OK");
    fetchQuotas({ cacheMode: "network-only" });
  }

  function applyPromptCounter() {
    const promptTa = $("#chatgpt_prompt");
    if (promptTa) {
      promptTa.addEventListener("input", () =>
        ui.applyPromptLimits({ max_client_prompt_length: promptMaxChars })
      );
    }
  }

  return {
    performAuthLogin,
    persistAuthState,
    clearAuthState,
    logoutSession,
    save,
    testHealth,
    applyPromptCounter,
  };
}
