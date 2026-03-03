/**
 * Estado único del popup: config, job seleccionado, flags, caches.
 * getState(), setState(partial), subscribe(fn).
 */

let state = {
  config: null,
  selectedJobId: null,
  currentJobId: null,
  statusCheckInterval: null,
  limitsData: null,
  limitsLastFetchTime: 0,
  limitsLastUpdateTs: null,
  limitsLastFetchError: false,
  limitsLastAuth401: false,
  selectedSendJobId: null,
  selectedSendKind: null,
  selectedSendUsernames: [],
  selectedRecipientSet: new Set(),
  sendPendingCount: 0,
  pendingCancelableSendJobId: null,
  sendProgressInterval: null,
  senderStatusInterval: null,
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
