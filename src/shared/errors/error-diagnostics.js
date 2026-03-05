function isObject(value) {
  return !!value && typeof value === "object";
}

function normalizeThrown(source) {
  if (!source) return null;
  if (source instanceof Error) {
    return {
      name: source.name || "Error",
      message: String(source.message || "Error inesperado"),
      stack: source.stack || null,
    };
  }
  return { name: "ThrownValue", message: String(source), stack: null };
}

export function buildApiErrorDiagnostic(source) {
  if (!isObject(source)) {
    return {
      kind: "throwable",
      uiMessage: null,
      code: null,
      status: 0,
      traceId: null,
      backendMessage: null,
      details: null,
      thrown: normalizeThrown(source),
    };
  }

  const errorObj = isObject(source.error) ? source.error : null;
  const status = Number(source.status || errorObj?.status || 0) || 0;
  return {
    kind: source.ok === false ? "api_result" : "object",
    uiMessage: source.errorMessage ? String(source.errorMessage) : null,
    code: errorObj?.code ? String(errorObj.code) : null,
    status,
    traceId: errorObj?.traceId ? String(errorObj.traceId) : null,
    backendMessage: errorObj?.message ? String(errorObj.message) : null,
    details: isObject(errorObj?.details) ? errorObj.details : null,
    thrown: null,
  };
}

export function logApiErrorDiagnostic(context, source, extra = null) {
  const label = String(context || "api_error").trim() || "api_error";
  const diagnostic = buildApiErrorDiagnostic(source);
  const payload = extra && isObject(extra) ? { ...diagnostic, extra } : diagnostic;
  console.warn(`[diag] ${label}`, payload);
  return payload;
}
