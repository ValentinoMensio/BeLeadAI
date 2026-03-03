function normalizePrefix(pathname) {
  const raw = String(pathname || "").trim();
  if (!raw || raw === "/") return "";
  return raw.endsWith("/") ? raw.slice(0, -1) : raw;
}

function normalizeApiPath(path) {
  const raw = String(path || "").trim();
  if (!raw) return "/";
  return `/${raw.replace(/^\/+/, "")}`;
}

export function buildApiUrl(baseUrl, apiPath, queryParams = null) {
  const url = new URL(String(baseUrl || "").trim());
  const [pathPart, queryPart = ""] = String(apiPath || "")
    .trim()
    .split("?");
  const prefix = normalizePrefix(url.pathname);
  url.pathname = `${prefix}${normalizeApiPath(pathPart)}`.replace(/\/+/g, "/");

  const search = new URLSearchParams(queryPart);
  if (queryParams instanceof URLSearchParams) {
    queryParams.forEach((value, key) => {
      search.set(key, value);
    });
  } else if (queryParams && typeof queryParams === "object") {
    Object.entries(queryParams).forEach(([key, value]) => {
      if (value == null) return;
      search.set(key, String(value));
    });
  }
  url.search = search.toString();
  url.hash = "";
  return url.toString();
}
