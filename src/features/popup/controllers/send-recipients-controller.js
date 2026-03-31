export function createSendRecipientsController(deps) {
  const { store, services, ui, dom, helpers } = deps;
  const {
    getState,
    clearSendRecipientContext,
    setSendRecipientContext,
    getSelectedRecipientUsernames,
    clearSelectedRecipients,
    toggleSelectedRecipient,
  } = store;
  const { loadSettings, loadRecipientSourceRecipientsPage } = services;
  const { setSendStatus, renderRecipients } = ui;
  const { qs } = dom;
  const { normalizeJobId, setRecipientsExpanded, updateRecipientsSelectionUI, setSendInfoStatus, syncRecipientChipsFromState } = helpers;

  function getRecipientsKindLabel(kind) {
    const kindLower = String(kind || "").toLowerCase();
    if (kindLower.includes("flow")) return "prospectos";
    if (kindLower.includes("analyze")) return "perfiles";
    return "followings";
  }

  function renderRecipientsState() {
    const st = getState();
    const infoEl = qs("#send_recipients_info");
    if (infoEl) infoEl.style.display = st.selectedSendJobId ? "block" : "none";
    const listEl = qs("#send_recipients_list");
    const toggleEl = qs("#recipients_toggle");
    const actionsEl = document.getElementById("recipients_actions");
    const summaryEl = qs("#send_recipients_summary");
    renderRecipients(
      { listEl, toggleEl, actionsEl, summaryEl },
      st.visibleRecipientUsernames || [],
      getSelectedRecipientUsernames(),
      toggleSelectedRecipient,
      () => updateRecipientsSelectionUI(),
      getRecipientsKindLabel(st.selectedSendKind),
      null
    );
    updateRecipientsSelectionUI();
  }

  function clearSelectedRecipientsUi() {
    clearSendRecipientContext();
    const infoEl = qs("#send_recipients_info");
    if (infoEl) infoEl.style.display = "none";
    const listEl = qs("#send_recipients_list");
    if (listEl) {
      listEl.style.display = "none";
      listEl.replaceChildren();
    }
    const actionsEl = document.getElementById("recipients_actions");
    if (actionsEl) actionsEl.style.display = "none";
    setRecipientsExpanded(false);
    updateRecipientsSelectionUI();
  }

  async function fetchRecipientsPage({ jobId, kind, cursor = null, append = false }) {
    const cfg = await loadSettings();
    const base = (cfg.api_base || "").trim().replace(/\/+$/, "");
    if (!base) return false;
    setSendInfoStatus(append ? "Cargando más destinatarios..." : "Cargando destinatarios...", {
      source: "activity",
    });
    const result = await loadRecipientSourceRecipientsPage(base, jobId, {
      limit: 100,
      cursor,
    });
    if (!result.ok) {
      setSendStatus(result?.errorMessage || "Error al cargar destinatarios.", true);
      return false;
    }
    const data = result.data;
    const st = getState();
    const visible = append
      ? [...new Set([...(st.visibleRecipientUsernames || []), ...(data.usernames || [])])]
      : [...(data.usernames || [])];
    const existingSelected = getSelectedRecipientUsernames();
    const hadAllVisibleSelected =
      append &&
      Array.isArray(st.visibleRecipientUsernames) &&
      existingSelected.length === st.visibleRecipientUsernames.length;
    const nextSelected = hadAllVisibleSelected
      ? [...visible]
      : existingSelected.length > 0 || append || cursor
        ? existingSelected
        : [...visible];
    setSendRecipientContext({
      jobId: normalizeJobId(jobId, kind || "job"),
      kind: kind || "followings_flow",
      visibleUsernames: visible,
      selectedUsernames: nextSelected,
      query: "",
      nextCursor: data.nextCursor,
      hasMore: data.hasMore,
      totalCount: data.total,
      matchedCount: data.matchedCount || data.total,
    });
    return { ok: true, data };
  }

  async function fetchAllRecipients(jobId, kind) {
    let cursor = null;
    let append = false;
    let page = 0;
    while (page < 20) {
      page += 1;
      const pageResult = await fetchRecipientsPage({ jobId, kind, cursor, append });
      if (!pageResult?.ok) return false;
      if (!pageResult.data?.hasMore || !pageResult.data?.nextCursor) break;
      cursor = pageResult.data.nextCursor;
      append = true;
    }
    renderRecipientsState();
    return true;
  }

  async function onSendRecipientsJobChange(jobIdOrNull, kindOrNull) {
    const sel = qs("#send_recipients_job_select");
    const jobId = normalizeJobId(jobIdOrNull || (sel && sel.value) || null);
    const kind = kindOrNull || sel?.selectedOptions?.[0]?.dataset?.kind || null;
    if (!jobId) {
      clearSelectedRecipientsUi();
      return;
    }
    clearSelectedRecipients();
    setSendRecipientContext({
      jobId,
      kind,
      visibleUsernames: [],
      selectedUsernames: [],
      query: "",
      nextCursor: null,
      hasMore: false,
      totalCount: 0,
      matchedCount: 0,
    });
    const ok = await fetchAllRecipients(jobId, kind);
    if (!ok) return;
    setRecipientsExpanded(false);
  }

  function selectAllRecipients() {
    store.selectAllRecipients();
    syncRecipientChipsFromState();
    updateRecipientsSelectionUI();
  }

  function deselectAllRecipients() {
    clearSelectedRecipients();
    syncRecipientChipsFromState();
    updateRecipientsSelectionUI();
  }

  return {
    clearSelectedRecipientsUi,
    onSendRecipientsJobChange,
    selectAllRecipients,
    deselectAllRecipients,
  };
}
