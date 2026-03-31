import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const REQUEST_TIMEOUT_MS = 15000;
const CONTRACTS_DIR = resolve(process.cwd(), "contracts", "v1");
const SUCCESS_SCHEMA_BY_CONTEXT = {
  "auth login": "auth-login.response.schema.json",
  ping: "ping.response.schema.json",
  config: "config.response.schema.json",
  limits: "limits.response.schema.json",
  "recipient sources list": "recipient-sources.response.schema.json",
  "recipient source recipients": "recipient-source-recipients.response.schema.json",
};
const ERROR_SCHEMA_FILE = resolve(CONTRACTS_DIR, "common", "error-envelope.schema.json");
const schemaCache = new Map();

function fail(message) {
  throw new Error(message);
}

function isObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function normalizeBaseUrl(raw) {
  const base = String(raw || "")
    .trim()
    .replace(/\/+$/, "");
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

async function loadSchema(schemaPath) {
  const fullPath = schemaPath.endsWith(".json") ? schemaPath : resolve(CONTRACTS_DIR, schemaPath);
  if (schemaCache.has(fullPath)) return schemaCache.get(fullPath);
  const raw = await readFile(fullPath, "utf8");
  const parsed = JSON.parse(raw);
  schemaCache.set(fullPath, parsed);
  return parsed;
}

function matchesSchemaType(value, typeName) {
  if (typeName === "null") return value === null;
  if (typeName === "array") return Array.isArray(value);
  if (typeName === "object") return isObject(value);
  if (typeName === "integer") return Number.isInteger(value);
  if (typeName === "number") return typeof value === "number" && Number.isFinite(value);
  if (typeName === "string") return typeof value === "string";
  if (typeName === "boolean") return typeof value === "boolean";
  return true;
}

function validateSchemaValue(schema, value, valuePath = "$") {
  if (!schema || typeof schema !== "object") return;

  if (schema.const !== undefined && value !== schema.const) {
    fail(`${valuePath}: expected const ${JSON.stringify(schema.const)}.`);
  }

  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
    fail(
      `${valuePath}: expected one of ${schema.enum.map((item) => JSON.stringify(item)).join(", ")}.`
    );
  }

  if (schema.type) {
    const allowedTypes = Array.isArray(schema.type) ? schema.type : [schema.type];
    const ok = allowedTypes.some((typeName) => matchesSchemaType(value, typeName));
    if (!ok) {
      fail(`${valuePath}: expected type ${allowedTypes.join(" | ")}.`);
    }
  }

  if (
    typeof value === "string" &&
    Number.isFinite(schema.minLength) &&
    value.length < schema.minLength
  ) {
    fail(`${valuePath}: expected minLength ${schema.minLength}.`);
  }

  if (typeof value === "number" && Number.isFinite(schema.minimum) && value < schema.minimum) {
    fail(`${valuePath}: expected minimum ${schema.minimum}.`);
  }

  if (Array.isArray(value) && schema.items) {
    value.forEach((item, index) =>
      validateSchemaValue(schema.items, item, `${valuePath}[${index}]`)
    );
  }

  if (isObject(value)) {
    const properties = isObject(schema.properties) ? schema.properties : {};
    const required = Array.isArray(schema.required) ? schema.required : [];
    for (const key of required) {
      if (!(key in value)) {
        fail(`${valuePath}: missing required property ${key}.`);
      }
    }
    for (const [key, childSchema] of Object.entries(properties)) {
      if (key in value) {
        validateSchemaValue(childSchema, value[key], `${valuePath}.${key}`);
      }
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!(key in properties)) {
          fail(`${valuePath}: unexpected property ${key}.`);
        }
      }
    } else if (isObject(schema.additionalProperties)) {
      for (const [key, childValue] of Object.entries(value)) {
        if (!(key in properties)) {
          validateSchemaValue(schema.additionalProperties, childValue, `${valuePath}.${key}`);
        }
      }
    }
  }
}

async function assertPublishedContract(status, payload, context) {
  assertEnvelope(status, payload, context);
  if (status >= 200 && status < 300) {
    const schemaName = SUCCESS_SCHEMA_BY_CONTEXT[context];
    if (!schemaName) return;
    const schema = await loadSchema(resolve(CONTRACTS_DIR, schemaName));
    validateSchemaValue(schema, payload, `$:${context}`);
    return;
  }
  const errorSchema = await loadSchema(ERROR_SCHEMA_FILE);
  validateSchemaValue(errorSchema, payload, `$:${context}`);
}

async function request(
  baseUrl,
  { context, method, path, token = "", body = null, expectedStatuses = [] }
) {
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

  await assertPublishedContract(resp.status, payload, context);
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

  const ping = await request(baseUrl, {
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

  const fromAccount = String(
    ping.payload?.data?.account_username || ping.payload?.data?.default_from_account || ""
  ).trim();
  if (fromAccount) {
    await request(baseUrl, {
      context: "limits",
      method: "GET",
      path: `/ext/v2/limits?from_account=${encodeURIComponent(fromAccount)}`,
      token: accessToken,
      expectedStatuses: [200],
    });
  }

  const recipientSources = await request(baseUrl, {
    context: "recipient sources list",
    method: "GET",
    path: "/ext/v2/recipient-sources?limit=1",
    token: accessToken,
    expectedStatuses: [200],
  });

  const firstSourceId = String(recipientSources.payload?.data?.items?.[0]?.source_id || "").trim();
  if (firstSourceId) {
    await request(baseUrl, {
      context: "recipient source recipients",
      method: "GET",
      path: `/ext/v2/recipient-sources/${encodeURIComponent(firstSourceId)}/recipients?limit=1`,
      token: accessToken,
      expectedStatuses: [200],
    });
  }

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

  console.log("[contract] OK: envelopes and published response contracts validated.");
}

run().catch((error) => {
  console.error("[contract] FAIL:", error?.message || error);
  process.exit(1);
});
