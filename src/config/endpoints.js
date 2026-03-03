const API_PREFIX = "/api";
const EXT_PREFIX = "/ext/v2";

function withApi(path) {
  return `${API_PREFIX}${path}`;
}

function withExt(path) {
  return `${EXT_PREFIX}${path}`;
}

function encodeSegment(value) {
  return encodeURIComponent(String(value || "").trim());
}

export const API_PATHS = {
  authLogin: withApi("/auth/login"),
  authTokenRefresh: withApi("/auth/token/refresh"),
  authLogout: withApi("/auth/logout"),
  authLogoutAll: withApi("/auth/logout-all"),
  ping: withExt("/ping"),
  config: "/config",
  health: "/health",
  limits: withExt("/limits"),
  metaVersion: withExt("/meta/version"),
  jobs: withExt("/jobs"),
  flows: withExt("/flows"),
  results: withExt("/results"),
  resultSummary: (id) => withExt(`/results/${encodeSegment(id)}/summary`),
  recipientSources: withExt("/recipient-sources"),
  recipientSourceRecipients: (sourceId) => withExt(`/recipient-sources/${encodeSegment(sourceId)}/recipients`),
  jobCancel: (id) => withExt(`/jobs/${encodeSegment(id)}/cancel`),
  sendEnqueue: withExt("/send/enqueue"),
  followingsEnqueue: withExt("/followings/enqueue"),
  analyzeEnqueue: withExt("/analyze/enqueue"),
  sendPull: withApi("/send/pull"),
  sendResult: withApi("/send/result"),
  sendHeartbeat: withApi("/send/heartbeat"),
  sendWsTicket: withApi("/send/ws-ticket"),
  jobsWsTicket: withExt("/jobs/ws-ticket"),
};

export const WS_PATHS = {
  send: withApi("/send/ws"),
  jobs: withExt("/jobs/ws"),
};
