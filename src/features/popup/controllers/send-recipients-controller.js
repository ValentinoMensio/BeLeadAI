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

  let searchDebounceId = null;

  function getRecipientsKindLabel(kind) {
    const kindLower = String(kind || "").toLowerCase();
    if (kindLower.includes("flow")) return "prospectos";
    if (kindLower.includes("analyze")) return "perfiles";
    return "followings";
  }

  function updateRecipientsLoadMoreUi() {
    const loadMoreBtn = qs("#recipients_load_more");
    if (!loadMoreBtn) return;
    const st = getState();
    const hasVisible = Array.isArray(st.visibleRecipientUsernames) && st.visibleRecipientUsernames.length > 0;
    loadMoreBtn.classList.toggle("is-hidden", !hasVisible || !st.recipientHasMore);
    loadMoreBtn.disabled = !st.recipientHasMore;
    if (st.recipientHasMore) {
      const remaining = Math.max(0, Number(st.recipientMatchedCount || 0) - Number(st.visibleRecipientUsernames.length || 0));
      loadMoreBtn.textContent = remaining > 0 ? `Cargar más (${remaining} restantes)` : "Cargar más";
    }
  }

  function renderRecipientsState() {
    const st = getState();
    const infoEl = qs("#send_recipients_info");
    if (infoEl) infoEl.style.display = st.selectedSendJobId ? "block" : "none";
    const searchEl = qs("#send_recipients_search");
    if (searchEl && searchEl.value !== String(st.recipientQuery || "")) {
      searchEl.value = String(st.recipientQuery || "");
    }
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
      {
        matchedCount: st.recipientMatchedCount || st.recipientTotalCount || 0,
        visibleCount: Array.isArray(st.visibleRecipientUsernames) ? st.visibleRecipientUsernames.length : 0,
      }
    );
    updateRecipientsLoadMoreUi();
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
    const searchEl = qs("#send_recipients_search");
    if (searchEl) searchEl.value = "";
    updateRecipientsLoadMoreUi();
    setRecipientsExpanded(false);
    updateRecipientsSelectionUI();
  }

  async function fetchRecipientsPage({ jobId, kind, query = "", cursor = null, append = false }) {
    const cfg = await loadSettings();
    const base = (cfg.api_base || "").trim().replace(/\/+$/, "");
    if (!base) return false;
    setSendInfoStatus(append ? "Cargando más destinatarios..." : "Cargando destinatarios...", {
      source: "activity",
    });
    const result = await loadRecipientSourceRecipientsPage(base, jobId, {
      limit: 100,
      cursor,
      query,
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
    const nextSelected =
      existingSelected.length > 0 || append || query || cursor ? existingSelected : [...visible];
    setSendRecipientContext({
      jobId: normalizeJobId(jobId, kind || "job"),
      kind: kind || "followings_flow",
      visibleUsernames: visible,
      selectedUsernames: nextSelected,
      query: data.query || query,
      nextCursor: data.nextCursor,
      hasMore: data.hasMore,
      totalCount: data.total,
      matchedCount: data.matchedCount || data.total,
    });
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
    const ok = await fetchRecipientsPage({ jobId, kind, query: "", cursor: null, append: false });
    if (!ok) return;
    setRecipientsExpanded(false);
  }

  function onRecipientsSearchInput() {
    const st = getState();
    if (!st.selectedSendJobId) return;
    const searchEl = qs("#send_recipients_search");
    const nextQuery = String(searchEl?.value || "").trim().toLowerCase();
    if (searchDebounceId) clearTimeout(searchDebounceId);
    searchDebounceId = setTimeout(() => {
      fetchRecipientsPage({
        jobId: st.selectedSendJobId,
        kind: st.selectedSendKind,
        query: nextQuery,
        cursor: null,
        append: false,
      });
    }, 250);
  }

  async function loadMoreRecipients() {
    const st = getState();
    if (!st.selectedSendJobId || !st.recipientHasMore || !st.recipientNextCursor) return;
    await fetchRecipientsPage({
      jobId: st.selectedSendJobId,
      kind: st.selectedSendKind,
      query: st.recipientQuery,
      cursor: st.recipientNextCursor,
      append: true,
    });
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
    onRecipientsSearchInput,
    loadMoreRecipients,
    selectAllRecipients,
    deselectAllRecipients,
  };
}
