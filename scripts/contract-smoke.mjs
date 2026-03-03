import { randomUUID } from "node:crypto";

const REQUEST_TIMEOUT_MS = 15000;

function fail(message) {
  throw new Error(message);
}

function isObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function normalizeBaseUrl(raw) {
  const base = String(raw || "").trim().replace(/\/+$/, "");
  if (!base) fail("Missing API_BASE.");
  let url;
  try {
    url = new URL(base);
  } catch {
    fail(`Invalid API_BASE: ${base}`);
  }
  if (url.protocol !== "https:") {
    fail(`API_BASE must use HTTPS. Received: ${url.protocol}`);
  }
  return url.toString().replace(/\/+$/, "");
}

function parseJsonSafe(text) {
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    return null;
  }
}

function hasSuccessEnvelope(payload) {
  return isObject(payload) && isObject(payload.data) && payload.error == null;
}

function hasErrorEnvelope(payload) {
  return (
    isObject(payload) &&
    isObject(payload.error) &&
    typeof payload.error.code === "string" &&
    payload.error.code.trim().length > 0 &&
    typeof payload.error.message === "string" &&
    payload.error.message.trim().length > 0
  );
}

function assertEnvelope(status, payload, context) {
  if (status >= 200 && status < 300) {
    if (!hasSuccessEnvelope(payload)) {
      fail(`${context}: success response must be { data: ... } envelope.`);
    }
    return;
  }
  if (!hasErrorEnvelope(payload)) {
    fail(`${context}: error response must be { error: { code, message } } envelope.`);
  }
}

async function request(baseUrl, { context, method, path, token = "", body = null, expectedStatuses = [] }) {
  const url = new URL(path, baseUrl).toString();
  const headers = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let resp;
  try {
    resp = await fetch(url, {
      method,
      headers,
      body: body == null ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (error) {
    if (error?.name === "AbortError") {
      fail(`${context}: request timeout (${REQUEST_TIMEOUT_MS}ms).`);
    }
    fail(`${context}: network error (${error?.message || error}).`);
  } finally {
    clearTimeout(timeoutId);
  }

  const text = await resp.text();
  const payload = parseJsonSafe(text);
  if (!payload) {
    fail(`${context}: response is not valid JSON.`);
  }

  if (expectedStatuses.length > 0 && !expectedStatuses.includes(resp.status)) {
    fail(`${context}: unexpected HTTP ${resp.status}. Expected: ${expectedStatuses.join(", ")}.`);
  }

  assertEnvelope(resp.status, payload, context);
  return { status: resp.status, payload };
}

async function run() {
  const baseUrl = normalizeBaseUrl(process.env.API_BASE);
  const apiKey = String(process.env.API_KEY || "").trim();
  if (!apiKey) fail("Missing API_KEY.");

  console.log("[contract] base:", baseUrl);

  const login = await request(baseUrl, {
    context: "auth login",
    method: "POST",
    path: "/api/auth/login",
    body: {
      api_key: apiKey,
      device_id: randomUUID(),
    },
    expectedStatuses: [200, 400, 401, 403, 429, 500, 503],
  });

  if (login.status !== 200) {
    fail(`auth login: expected 200, got ${login.status}.`);
  }

  const authData = login.payload.data;
  const accessToken = String(authData?.access_token || "").trim();
  const refreshToken = String(authData?.refresh_token || "").trim();
  if (!accessToken || !refreshToken) {
    fail("auth login: missing access_token or refresh_token in data envelope.");
  }

  await request(baseUrl, {
    context: "ping",
    method: "GET",
    path: "/ext/v2/ping",
    token: accessToken,
    expectedStatuses: [200],
  });

  await request(baseUrl, {
    context: "config",
    method: "GET",
    path: "/config",
    expectedStatuses: [200],
  });

  await request(baseUrl, {
    context: "jobs list",
    method: "GET",
    path: "/ext/v2/jobs?limit=1",
    token: accessToken,
    expectedStatuses: [200],
  });

  await request(baseUrl, {
    context: "flows list",
    method: "GET",
    path: "/ext/v2/flows?limit=1",
    token: accessToken,
    expectedStatuses: [200],
  });

  await request(baseUrl, {
    context: "results list",
    method: "GET",
    path: "/ext/v2/results?limit=1",
    token: accessToken,
    expectedStatuses: [200],
  });

  await request(baseUrl, {
    context: "recipient sources list",
    method: "GET",
    path: "/ext/v2/recipient-sources?limit=1",
    token: accessToken,
    expectedStatuses: [200],
  });

  await request(baseUrl, {
    context: "results summary not found",
    method: "GET",
    path: "/ext/v2/results/not-found-smoke-id/summary",
    token: accessToken,
    expectedStatuses: [404, 422],
  });

  await request(baseUrl, {
    context: "send enqueue validation error",
    method: "POST",
    path: "/ext/v2/send/enqueue",
    token: accessToken,
    body: {
      invalid_payload: true,
    },
    expectedStatuses: [400, 409, 422],
  });

  await request(baseUrl, {
    context: "logout device",
    method: "POST",
    path: "/api/auth/logout",
    body: {
      refresh_token: refreshToken,
      device_id: randomUUID(),
    },
    token: accessToken,
    expectedStatuses: [200, 400, 401],
  });

  console.log("[contract] OK: envelope and /ext/v2 core routes validated.");
}

run().catch((error) => {
  console.error("[contract] FAIL:", error?.message || error);
  process.exit(1);
});
