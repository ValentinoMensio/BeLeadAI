(function initBackgroundJobsReportingModule(globalScope) {
  function createBackgroundJobsReportingModule({
    state,
    storageModule,
    authModule,
    pendingReportsMax,
    heartbeatMinGapMs,
    heartbeatInstanceId,
    authErrorBackoffMs,
    networkFetchTimeoutMs,
    maskIdentity,
    normalizeAccount,
    getPinnedSenderAccount,
    pinSenderAccountForRun,
    getFallbackHeartbeatAccount,
    getLoggedInUsername,
    updateProgress,
  }) {
    let lastHeartbeatTs = 0;
    let lastAuthErrorTs = 0;
    let lastAuthErrorReason = null;
    let reportFlushInFlight = null;
    let pullRateLimitedUntilMs = 0;
    let reportRateLimitedUntilMs = 0;
    let heartbeatRateLimitedUntilMs = 0;
    let lastHeartbeatRateLimitLogTs = 0;

    async function fetchWithTimeout(url, options = {}, timeoutMs = networkFetchTimeoutMs) {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
      try {
        return await fetch(url, { ...options, signal: controller.signal });
      } finally {
        clearTimeout(timeoutId);
      }
    }

    function buildApiUrl(baseUrl, apiPath) {
      const url = new URL(String(baseUrl || "").trim());
      const prefixRaw = String(url.pathname || "").trim();
      const prefix =
        !prefixRaw || prefixRaw === "/"
          ? ""
          : prefixRaw.endsWith("/")
            ? prefixRaw.slice(0, -1)
            : prefixRaw;
      const cleanPath = `/${String(apiPath || "")
        .trim()
        .replace(/^\/+/, "")}`;
      url.pathname = `${prefix}${cleanPath}`.replace(/\/+/g, "/");
      url.search = "";
      url.hash = "";
      return url.toString();
    }

    function unwrapApiDataEnvelope(payload) {
      if (!payload || typeof payload !== "object") return {};
      const nested = payload.data;
      if (nested && typeof nested === "object" && !Array.isArray(nested)) return nested;
      return payload;
    }

    function parseRetryAfterMs(response, payload = null) {
      const headerVal = Number(response?.headers?.get?.("retry-after") || 0);
      const payloadVal = Number(
        payload?.error?.details?.retry_after ?? payload?.error?.details?.retry_after_sec ?? 0
      );
      const parsed = Number.isFinite(payloadVal) && payloadVal > 0 ? payloadVal : headerVal;
      if (!Number.isFinite(parsed) || parsed <= 0) return 0;
      return Math.max(1000, Math.round(parsed * 1000));
    }

    function applyRateLimitWindow(kind, retryAfterMs) {
      const floor = kind === "report" ? 4000 : 3000;
      const waitMs = Math.max(floor, Number(retryAfterMs || 0));
      const until = Date.now() + waitMs;
      if (kind === "report") {
        reportRateLimitedUntilMs = Math.max(reportRateLimitedUntilMs, until);
      } else {
        pullRateLimitedUntilMs = Math.max(pullRateLimitedUntilMs, until);
      }
      return waitMs;
    }

    function applyHeartbeatRateLimitWindow(retryAfterMs) {
      const waitMs = Math.max(5000, Number(retryAfterMs || 0));
      heartbeatRateLimitedUntilMs = Math.max(heartbeatRateLimitedUntilMs, Date.now() + waitMs);
      return waitMs;
    }

    async function pullTask() {
      if (Date.now() < pullRateLimitedUntilMs) {
        return {
          status: "rate_limited",
          retryAfterMs: Math.max(1000, pullRateLimitedUntilMs - Date.now()),
        };
      }
      const cfg = await authModule.loadSettings();
      if (!cfg.api_base || !authModule.isSecureApiBase(cfg.api_base)) {
        console.log("[BG] No hay API base configurada");
        return { status: "error", reason: "api_not_configured", retryAfterMs: 5000 };
      }
      const headers = await authModule.getAuthHeaders(cfg);
      if (!headers.Authorization) {
        console.log("[BG] No hay JWT válido (probá API Key en Opciones)");
        return { status: "error", reason: "auth_missing", retryAfterMs: 5000 };
      }

      let fromAccount = getPinnedSenderAccount();
      if (!fromAccount) {
        fromAccount = normalizeAccount(await getLoggedInUsername());
      }
      if (!fromAccount) {
        return { status: "error", reason: "account_not_detected", retryAfterMs: 5000 };
      }
      fromAccount = pinSenderAccountForRun(fromAccount);
      console.log("[BG] Pull request:", { fromAccount: maskIdentity(fromAccount), limit: 1 });
      const url = buildApiUrl(cfg.api_base, "/api/send/pull");

      try {
        const resp = await fetchWithTimeout(url, {
          method: "POST",
          headers,
          body: JSON.stringify({ limit: 1, from_account: fromAccount }),
        });

        if (!resp.ok) {
          const errText = await resp.text();
          let parsedErr = {};
          let retryAfterMs = 5000;
          try {
            parsedErr = JSON.parse(errText || "{}");
          } catch {}
          const parsedRetryAfterMs = parseRetryAfterMs(resp, parsedErr);
          if (parsedRetryAfterMs > 0) retryAfterMs = parsedRetryAfterMs;

          if (resp.status === 429 || resp.status === 503) {
            const waitMs = applyRateLimitWindow("pull", retryAfterMs);
            console.warn("[BG] Pull rate-limited; retry in", waitMs, "ms");
            return { status: "rate_limited", retryAfterMs: waitMs };
          }

          console.error("[BG] Pull failed with status", resp.status);
          return { status: "error", retryAfterMs };
        }

        const raw = await resp.json();
        const data = unwrapApiDataEnvelope(raw);
        console.log("[BG] Pull response:", {
          status: resp.status,
          itemsCount: data.items?.length || 0,
          fromAccount: maskIdentity(fromAccount),
        });
        if (data.items && data.items.length > 0) {
          updateProgress("pull_ok");
          return { status: "task", task: data.items[0] };
        }
        console.log("[BG] Pull: no tasks available for account:", maskIdentity(fromAccount));
        return { status: "empty" };
      } catch (e) {
        console.error("[BG] Pull error:", e);
        return { status: "error", retryAfterMs: 5000 };
      }
    }

    async function sendReportRequest(report) {
      if (Date.now() < reportRateLimitedUntilMs) {
        return false;
      }
      const cfg = await authModule.loadSettings();
      if (!cfg.api_base || !authModule.isSecureApiBase(cfg.api_base)) return false;

      const headers = await authModule.getAuthHeaders(cfg);
      if (!headers.Authorization) return false;
      const url = buildApiUrl(cfg.api_base, "/api/send/result");

      if (!report.job_id || !report.task_id) {
        console.warn("[BG] Report skipped: missing job_id or task_id", report);
        return true;
      }
      const leaseProof = String(report.lease_proof || "").trim();
      if (!leaseProof) {
        console.warn("[BG] Report discarded: missing lease_proof", {
          job_id: report.job_id,
          task_id: report.task_id,
        });
        return true;
      }

      try {
        const body = {
          job_id: report.job_id,
          task_id: report.task_id,
          lease_proof: leaseProof,
          ok: !!report.ok,
          dry_run: !!report.dry_run,
        };
        if (report.error) {
          body.error = report.error;
        }

        console.log("[BG] Sending report:", {
          job_id: body.job_id,
          task_id: body.task_id,
          ok: body.ok,
          error: body.error,
        });

        const resp = await fetchWithTimeout(url, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
        });

        if (!resp.ok) {
          const errorText = await resp.text();
          let errorPayload = {};
          try {
            errorPayload = errorText ? JSON.parse(errorText) : {};
          } catch {
            errorPayload = {};
          }
          const errorCode = String(errorPayload?.error?.code || "")
            .trim()
            .toUpperCase();
          console.warn(
            "[BG] Report result failed with status",
            resp.status,
            "code:",
            errorCode || "UNKNOWN"
          );
          if (resp.status === 400 && errorCode === "TASK_ID_NOT_FOUND") {
            console.warn("[BG] Task no existe en DB, discarding orphan report");
            return true;
          }
          if (resp.status === 403 && errorCode === "LEASE_NOT_ACTIVE") {
            console.warn("[BG] Lease no activo para report, discarding stale/duplicate report");
            return true;
          }
          if (resp.status === 429 || resp.status === 503) {
            const retryAfterMs = parseRetryAfterMs(resp, errorPayload);
            applyRateLimitWindow("report", retryAfterMs || 5000);
          }
          return false;
        }
        return true;
      } catch (e) {
        console.error("[BG] Report error:", e);
        return false;
      }
    }

    async function flushPendingReports() {
      if (reportFlushInFlight) return reportFlushInFlight;
      reportFlushInFlight = (async () => {
        if (Date.now() < reportRateLimitedUntilMs) return false;
        const queue = await storageModule.getPendingReports();
        if (!queue.length) return true;
        const remaining = [];
        for (let i = 0; i < queue.length; i += 1) {
          if (Date.now() < reportRateLimitedUntilMs) {
            remaining.push(...queue.slice(i));
            break;
          }
          const report = queue[i];
          const ok = await sendReportRequest(report);
          if (!ok) remaining.push(report);
        }
        await storageModule.saveState({
          dm_sender_pending_reports: remaining.slice(-pendingReportsMax),
        });
        if (remaining.length < queue.length) {
          updateProgress("flush_ok");
        }
        return remaining.length === 0;
      })();
      try {
        return await reportFlushInFlight;
      } finally {
        reportFlushInFlight = null;
      }
    }

    async function reportResult(jobId, taskId, leaseProof, ok, destUsername, error = null, dryRun = false) {
      const report = {
        job_id: String(jobId || ""),
        task_id: String(taskId || ""),
        lease_proof: String(leaseProof || ""),
        ok: !!ok,
        dest_username: destUsername || null,
        error: error || null,
        dry_run: !!dryRun,
        ts: Date.now(),
      };
      if (!report.lease_proof) {
        console.warn("[BG] Report skipped locally: missing lease_proof", {
          job_id: report.job_id,
          task_id: report.task_id,
        });
        return;
      }
      await storageModule.enqueuePendingReport(report);
      updateProgress("result_reported");
      const flushOk = await flushPendingReports();
      if (flushOk !== false) {
        await storageModule.saveState({ dm_current_task: null });
      }
    }

    async function sendHeartbeat(options = {}) {
      const {
        autonomous = false,
        force = false,
        fromAccountOverride = null,
        detectedAccountHint = null,
      } = options;
      const now = Date.now();

      const minGap = heartbeatMinGapMs - 5000;
      if (!force && now - lastHeartbeatTs < minGap) {
        return true;
      }
      if (now < heartbeatRateLimitedUntilMs) {
        return false;
      }

      const cfg = await authModule.loadSettings();
      if (!cfg.api_base || !authModule.isSecureApiBase(cfg.api_base)) {
        return false;
      }

      let headers = await authModule.getAuthHeaders(cfg);

      if (!headers.Authorization) {
        const refreshed = await authModule.ensureFreshAccessToken(cfg);
        if (refreshed) {
          headers = await authModule.getAuthHeaders(cfg);
        }

        if (!headers.Authorization) {
          if (now - lastAuthErrorTs > authErrorBackoffMs) {
            console.warn("[BG] Heartbeat: auth falló (sin JWT válido)");
            lastAuthErrorTs = now;
            lastAuthErrorReason = "no_valid_jwt";
            storageModule
              .saveState({
                dm_last_auth_error: { ts: now, reason: "no_valid_jwt" },
              })
              .catch((e) => {
                console.warn("[BG] Failed to persist dm_last_auth_error:", e?.message || e);
              });
          }
          return false;
        }
      }

      const pinnedAccount = getPinnedSenderAccount();
      const hintedAccount = normalizeAccount(detectedAccountHint);
      const detectedAccount = hintedAccount || normalizeAccount(await getLoggedInUsername());
      const igAccountDetected = !!detectedAccount;
      const fallbackAccount = normalizeAccount(fromAccountOverride) || getFallbackHeartbeatAccount();
      const candidateAccount = pinnedAccount || detectedAccount || fallbackAccount;
      const heartbeatAccount = pinSenderAccountForRun(candidateAccount);

      const payload = {
        sender_instance_id: heartbeatInstanceId,
        from_account: heartbeatAccount,
        autonomous,
        sender_running: autonomous ? false : state.isRunning,
        ig_account_detected: igAccountDetected,
      };

      if (!heartbeatAccount) {
        return false;
      }

      try {
        const url = buildApiUrl(cfg.api_base, "/api/send/heartbeat");
        const resp = await fetchWithTimeout(url, {
          method: "POST",
          headers,
          body: JSON.stringify(payload),
        });

        if (resp.status === 401) {
          if (now - lastAuthErrorTs > authErrorBackoffMs) {
            console.warn("[BG] Heartbeat: 401 Unauthorized - JWT expirado o inválido");
            lastAuthErrorTs = now;
            lastAuthErrorReason = "401_unauthorized";

            storageModule
              .saveState({
                dm_last_auth_error: { ts: now, reason: "401_unauthorized" },
              })
              .catch((e) => {
                console.warn("[BG] Failed to persist dm_last_auth_error:", e?.message || e);
              });
          }
          return false;
        }

        if (resp.status === 429 || resp.status === 503) {
          const retryAfterMs = parseRetryAfterMs(resp);
          const waitMs = applyHeartbeatRateLimitWindow(retryAfterMs);
          if (now - lastHeartbeatRateLimitLogTs > 15000) {
            console.warn("[BG] Heartbeat rate-limited; retry in", waitMs, "ms");
            lastHeartbeatRateLimitLogTs = now;
          }
          return false;
        }

        if (resp.ok) {
          lastHeartbeatTs = now;
          heartbeatRateLimitedUntilMs = 0;
          if (lastAuthErrorReason) {
            lastAuthErrorReason = null;
            storageModule.saveState({ dm_last_auth_error: null }).catch((e) => {
              console.warn("[BG] Failed to clear dm_last_auth_error:", e?.message || e);
            });
          }
          return true;
        }
        return false;
      } catch (e) {
        console.warn("[BG] Heartbeat: network error", e?.message || e);
        return false;
      }
    }

    async function sendAutonomousHeartbeat() {
      const igAccount = normalizeAccount(await getLoggedInUsername());
      if (!igAccount) {
        return false;
      }
      return sendHeartbeat({ autonomous: true, force: true, detectedAccountHint: igAccount });
    }

    async function sendSenderHeartbeat(force = false, fromAccountHint = "") {
      const hintedAccount = normalizeAccount(fromAccountHint);
      if (hintedAccount) {
        const pinnedFromHint = pinSenderAccountForRun(hintedAccount);
        if (pinnedFromHint) {
          return sendHeartbeat({
            autonomous: false,
            force,
            detectedAccountHint: pinnedFromHint,
            fromAccountOverride: pinnedFromHint,
          });
        }
      }

      const pinnedAccount = getPinnedSenderAccount();
      if (pinnedAccount) {
        return sendHeartbeat({ autonomous: false, force, detectedAccountHint: pinnedAccount });
      }
      const igAccount = normalizeAccount(await getLoggedInUsername());
      if (!igAccount) {
        const fallbackAccount = getFallbackHeartbeatAccount();
        if (!fallbackAccount) {
          return false;
        }
        return sendHeartbeat({
          autonomous: false,
          force,
          fromAccountOverride: fallbackAccount,
        });
      }
      pinSenderAccountForRun(igAccount);
      return sendHeartbeat({ autonomous: false, force, detectedAccountHint: igAccount });
    }

    function resetRuntimeState() {
      lastHeartbeatTs = 0;
    }

    return {
      pullTask,
      sendReportRequest,
      flushPendingReports,
      reportResult,
      sendSenderHeartbeat,
      sendAutonomousHeartbeat,
      resetRuntimeState,
    };
  }

  globalScope.createBackgroundJobsReportingModule = createBackgroundJobsReportingModule;
})(self);
