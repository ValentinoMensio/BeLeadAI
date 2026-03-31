(function initContentAccountIdentityModule(globalScope) {
  function createContentAccountIdentityModule({ observersModule }) {
    const { isLikelyIgUsername } = observersModule;

    function getCookie(name) {
      const parts = `; ${document.cookie || ""}`.split(`; ${name}=`);
      if (parts.length !== 2) return null;
      const value = parts[1].split(";")[0].trim();
      return value || null;
    }

    function normalizeUsername(value) {
      const username = String(value || "")
        .trim()
        .replace(/^@+/, "")
        .toLowerCase();
      return isLikelyIgUsername(username) ? username : "";
    }

    function readUsernameFromDocument() {
      try {
        const profileMeta = document.querySelector('meta[property="og:title"]')?.content || "";
        const profileMatch = /^@([a-z0-9._]+)\b/i.exec(String(profileMeta));
        const profileUsername = normalizeUsername(profileMatch?.[1] || "");
        if (profileUsername) {
          return profileUsername;
        }

        const canonicalHref = document.querySelector('link[rel="canonical"]')?.href || "";
        const canonicalPath = (() => {
          try {
            return new URL(canonicalHref, window.location.origin).pathname;
          } catch {
            return "";
          }
        })();
        const canonicalMatch = /^\/([a-z0-9._]+)\/?$/i.exec(canonicalPath);
        const canonicalUsername = normalizeUsername(canonicalMatch?.[1] || "");
        if (canonicalUsername) {
          return canonicalUsername;
        }
      } catch {}
      return "";
    }

    async function readUsernameFromApi() {
      const csrfToken = getCookie("csrftoken");
      const headers = {
        "x-requested-with": "XMLHttpRequest",
      };
      if (csrfToken) {
        headers["x-csrftoken"] = csrfToken;
      }
      const candidatePaths = [
        "/api/v1/accounts/current_user/?edit=true",
        "/api/v1/accounts/current_user/?edit=false",
      ];

      for (const path of candidatePaths) {
        try {
          const response = await fetch(path, {
            method: "GET",
            credentials: "include",
            headers,
          });
          if (!response.ok) continue;
          const data = await response.json();
          const user =
            data && typeof data === "object" && data.user && typeof data.user === "object"
              ? data.user
              : data;
          const username = normalizeUsername(user?.username || "");
          const userId = String(user?.pk || user?.id || "").trim();
          if (username || userId) {
            return {
              username: username || null,
              user_id: userId || null,
              source: "api_current_user",
            };
          }
        } catch {}
      }
      return null;
    }

    async function getCurrentInstagramUsername() {
      const apiResult = await readUsernameFromApi();
      if (apiResult?.username) {
        return apiResult;
      }

      const domUsername = readUsernameFromDocument();
      if (domUsername) {
        return {
          username: domUsername,
          user_id: apiResult?.user_id || null,
          source: "dom",
        };
      }

      const dsUserId = getCookie("ds_user_id");
      const userId = dsUserId && String(dsUserId).trim() ? String(dsUserId).trim() : "";
      if (userId) {
        return { user_id: userId, username: null, source: "cookie" };
      }
      return { user_id: null, username: null, source: "not_found" };
    }

    return {
      getCurrentInstagramUsername,
    };
  }

  globalScope.createContentAccountIdentityModule = createContentAccountIdentityModule;
})(self);
