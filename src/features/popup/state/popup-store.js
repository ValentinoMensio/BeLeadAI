/**
 * Estado único del popup: config, job seleccionado, flags, caches.
 * getState(), setState(partial), subscribe(fn).
 */

let state = {
  config: null,
  currentJobId: null,
  selectedSendJobId: null,
  selectedSendKind: null,
  visibleRecipientUsernames: [],
  selectedRecipientUsernames: [],
  recipientQuery: "",
  recipientNextCursor: null,
  recipientHasMore: false,
  recipientTotalCount: 0,
  recipientMatchedCount: 0,
  sendPendingCount: 0,
  pendingCancelableSendJobId: null,
  apiLimits: {
    max_message_length: 1000,
    min_message_length: 10,
    max_client_prompt_length: 2000,
  },
};

const listeners = new Set();

export function getState() {
  return state;
}

export function setState(partial) {
  if (!partial || typeof partial !== "object") return;
  state = { ...state, ...partial };
  listeners.forEach((fn) => {
    try {
      fn(state);
    } catch (e) {
      console.warn("[popup_store] subscriber error", e);
    }
  });
}

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function normalizeUsernames(usernames) {
  return [
    ...new Set(
      (Array.isArray(usernames) ? usernames : []).map((u) => String(u || "").trim()).filter(Boolean)
    ),
  ];
}

export function getSelectedRecipientUsernames() {
  return [...state.selectedRecipientUsernames];
}

export function getSelectedRecipientSet() {
  return new Set(state.selectedRecipientUsernames);
}

export function getSelectedRecipientCount() {
  return state.selectedRecipientUsernames.length;
}

export function isRecipientSelected(username) {
  const normalized = String(username || "").trim();
  return !!normalized && state.selectedRecipientUsernames.includes(normalized);
}

export function setSelectedRecipients(usernames) {
  setState({ selectedRecipientUsernames: normalizeUsernames(usernames) });
}

export function clearSelectedRecipients() {
  setState({ selectedRecipientUsernames: [] });
}

export function toggleSelectedRecipient(username) {
  const normalized = String(username || "").trim();
  if (!normalized) return;
  const selected = getSelectedRecipientUsernames();
  const next = selected.includes(normalized)
    ? selected.filter((item) => item !== normalized)
    : [...selected, normalized];
  setSelectedRecipients(next);
}

export function selectAllRecipients() {
  setSelectedRecipients(state.visibleRecipientUsernames);
}

export function clearSendRecipientContext() {
  setState({
    selectedSendJobId: null,
    selectedSendKind: null,
    visibleRecipientUsernames: [],
    selectedRecipientUsernames: [],
    recipientQuery: "",
    recipientNextCursor: null,
    recipientHasMore: false,
    recipientTotalCount: 0,
    recipientMatchedCount: 0,
  });
}

export function setSendRecipientContext({
  jobId = null,
  kind = null,
  visibleUsernames = [],
  selectedUsernames = null,
  query = "",
  nextCursor = null,
  hasMore = false,
  totalCount = 0,
  matchedCount = 0,
}) {
  const normalizedUsernames = normalizeUsernames(visibleUsernames);
  const normalizedSelected = normalizeUsernames(
    selectedUsernames == null ? normalizedUsernames : selectedUsernames
  );
  setState({
    selectedSendJobId: jobId,
    selectedSendKind: kind,
    visibleRecipientUsernames: normalizedUsernames,
    selectedRecipientUsernames: normalizedSelected,
    recipientQuery: String(query || ""),
    recipientNextCursor: nextCursor ? String(nextCursor) : null,
    recipientHasMore: !!hasMore,
    recipientTotalCount: Number(totalCount || 0) || 0,
    recipientMatchedCount: Number(matchedCount || 0) || 0,
  });
}
