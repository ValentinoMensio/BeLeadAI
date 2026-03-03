/**
 * Controlador de límites: refresh/cache/render vía limits_ui, eventos (filas, dry_run, intervalo).
 */

const LIMITS_REFRESH_INTERVAL_MS = 15000;

/**
 * @param {{ store, services, ui, dom }} deps
 * @returns {{ refreshLimits, refreshLimitsWithCache, bindLimitsEvents }}
 */
export function initLimits(deps) {
  const { ui } = deps;
  const { refreshLimitsWithCache: uiRefreshLimitsWithCache, showLimitDetail } = ui;

  let limitsRefreshIntervalId = null;

  function refreshLimits(forceRefresh = false) {
    return uiRefreshLimitsWithCache(forceRefresh);
  }

  function refreshLimitsWithCache(forceRefresh = false) {
    return uiRefreshLimitsWithCache(forceRefresh);
  }

  function updateSandboxBadge() {
    // UI badge removido del popup; se mantiene la API para compatibilidad.
  }

  function bindLimitsEvents() {
    const rowDay = document.getElementById("limits-row-day");
    const rowMonth = document.getElementById("limits-row-month");
    const onDayClick = () => showLimitDetail("day");
    const onMonthClick = () => showLimitDetail("month");
    if (rowDay) rowDay.addEventListener("click", onDayClick);
    if (rowMonth) rowMonth.addEventListener("click", onMonthClick);

    const dryRunEl = document.getElementById("dry_run");
    const onDryRunChange = () => {
      chrome.storage.local.set({ dry_run: !!dryRunEl.checked });
      updateSandboxBadge();
    };
    if (dryRunEl) {
      chrome.storage.local.get({ dry_run: true }, (st) => {
        dryRunEl.checked = !!st.dry_run;
        updateSandboxBadge();
      });
      dryRunEl.addEventListener("change", onDryRunChange);
    }

    limitsRefreshIntervalId = setInterval(
      () => refreshLimitsWithCache(false),
      LIMITS_REFRESH_INTERVAL_MS
    );

    function cleanup() {
      if (rowDay) rowDay.removeEventListener("click", onDayClick);
      if (rowMonth) rowMonth.removeEventListener("click", onMonthClick);
      if (dryRunEl) dryRunEl.removeEventListener("change", onDryRunChange);
      if (limitsRefreshIntervalId) {
        clearInterval(limitsRefreshIntervalId);
        limitsRefreshIntervalId = null;
      }
    }
    return cleanup;
  }

  return {
    refreshLimits,
    refreshLimitsWithCache,
    bindLimitsEvents,
    updateSandboxBadge,
  };
}
