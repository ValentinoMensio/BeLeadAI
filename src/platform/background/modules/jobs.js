(function initBackgroundJobsModule(globalScope) {
  function createBackgroundJobsModule({
    state,
    config,
    storageModule,
    authModule,
    wsModule,
    processTriggerMinGapMs,
    heartbeatMinGapMs,
    heartbeatInstanceId,
    wsPullGraceMs,
    pendingReportsMax,
  }) {
    let lastHeartbeatTs = 0;
    let lastAuthErrorTs = 0;
    let lastAuthErrorReason = null;
    const AUTH_ERROR_BACKOFF_MS = 60000;
    let reportFlushInFlight = null;
    let lastProcessTriggerTs = 0;
    let pendingProcessTriggerTimer = null;
    let pendingProcessNextTimer = null;
    let senderRunVersion = 0;
    let activeProcessToken = null;
    let startSenderInFlight = false;
    let watchdogRecoveryInFlight = null;
    let lastProcessingSkipLogTs = 0;
    let lastSenderNotRunningLogTs = 0;
    let noTasksRestartCooldownUntil = 0;
    let emptyPullStreak = 0;
    let consecutiveThreadIdentityFails = 0;
    let lastKnownFromAccount = '';
    let lastKnownFromAccountTs = 0;
    let transientFailureCount = 0;
    let definitiveFailureCount = 0;

    // Watchdog state
    let lastProgressTs = 0;
    let progressStage = 'idle';
    let watchdogRecoveryAttempts = 0;
    const WATCHDOG_NO_PROGRESS_TIMEOUT_MS = 90000;
    const WATCHDOG_NO_PROGRESS_TIMEOUT_NAV_MS = 150000;
    const WATCHDOG_MAX_RECOVERY_ATTEMPTS = 3;
    const SEND_DM_TOTAL_TIMEOUT_MS = 120000;
    const NETWORK_FETCH_TIMEOUT_MS = 20000;
    const NO_TASKS_RESTART_COOLDOWN_MS = 8000;
    const THREAD_IDENTITY_MAX_RETRIES = 1;
    const EMPTY_PULL_MAX_STREAK_BEFORE_STOP = 8;
    const EMPTY_PULL_RETRY_BASE_MS = 1500;
    const THREAD_IDENTITY_CONSECUTIVE_STOP_THRESHOLD = 3;
    const ACCOUNT_FALLBACK_LIVENESS_GRACE_MS = 120000;

    async function fetchWithTimeout(url, options = {}, timeoutMs = NETWORK_FETCH_TIMEOUT_MS) {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
      try {
        return await fetch(url, { ...options, signal: controller.signal });
      } finally {
        clearTimeout(timeoutId);
      }
    }

    function buildApiUrl(baseUrl, apiPath) {
      const url = new URL(String(baseUrl || '').trim());
      const prefixRaw = String(url.pathname || '').trim();
      const prefix = !prefixRaw || prefixRaw === '/'
        ? ''
        : (prefixRaw.endsWith('/') ? prefixRaw.slice(0, -1) : prefixRaw);
      const cleanPath = `/${String(apiPath || '').trim().replace(/^\/+/, '')}`;
      url.pathname = `${prefix}${cleanPath}`.replace(/\/+/g, '/');
      url.search = '';
      url.hash = '';
      return url.toString();
    }

    function updateProgress(stage) {
      lastProgressTs = Date.now();
      progressStage = stage;
      console.log(`[BG] Progress: ${stage}`);
      storageModule.saveState({
        dm_last_progress_ts: lastProgressTs,
        dm_progress_stage: stage,
      }).catch((e) => {
        console.warn('[BG] updateProgress: failed to persist progress state', e?.message || e);
      });
    }

    function markProgressStage(stage) {
      lastProgressTs = Date.now();
      progressStage = stage;
    }

    function triggerProcessNextTaskThrottled() {
      const now = Date.now();
      const elapsed = now - lastProcessTriggerTs;
      if (elapsed >= processTriggerMinGapMs) {
        lastProcessTriggerTs = now;
        runProcessNextTaskSafe();
        return;
      }
      if (pendingProcessTriggerTimer) return;
      const waitMs = Math.max(50, processTriggerMinGapMs - elapsed);
      pendingProcessTriggerTimer = setTimeout(() => {
        pendingProcessTriggerTimer = null;
        lastProcessTriggerTs = Date.now();
        runProcessNextTaskSafe();
      }, waitMs);
    }

    function clearPendingProcessNextTimer() {
      if (!pendingProcessNextTimer) return;
      clearTimeout(pendingProcessNextTimer);
      pendingProcessNextTimer = null;
    }

    function runProcessNextTaskSafe(prefetchedTask = null) {
      processNextTask(prefetchedTask).catch((e) => {
        console.error('[BG] processNextTask fatal error:', e?.message || e);
      });
    }

    function scheduleProcessNextTask(delayMs, reason = 'scheduled') {
      const waitMs = Math.max(0, Number(delayMs || 0));
      const expectedRunVersion = senderRunVersion;
      clearPendingProcessNextTimer();
      pendingProcessNextTimer = setTimeout(() => {
        pendingProcessNextTimer = null;
        if (!state.isRunning || expectedRunVersion !== senderRunVersion) {
          return;
        }
        console.log('[BG] Trigger processNextTask:', reason, `(+${waitMs}ms)`);
        runProcessNextTaskSafe();
      }, waitMs);
    }

    function randomBetween(min, max) {
      return Math.floor(Math.random() * (max - min + 1)) + min;
    }

    function formatTime(ms) {
      const seconds = Math.floor(ms / 1000);
      const minutes = Math.floor(seconds / 60);
      const secs = seconds % 60;
      return `${minutes}:${secs.toString().padStart(2, '0')}`;
    }

    function maskIdentity(value) {
      const raw = String(value || '').trim();
      if (!raw) return 'unknown';
      if (raw.length <= 2) return '*'.repeat(raw.length);
      return `${raw.slice(0, 2)}***`;
    }

    function normalizeAccount(value) {
      return String(value || '').trim();
    }

    function rememberKnownAccount(account) {
      const normalized = normalizeAccount(account);
      if (!normalized) return;
      lastKnownFromAccount = normalized;
      lastKnownFromAccountTs = Date.now();
      storageModule.saveState({
        dm_sender_last_account: lastKnownFromAccount,
        dm_sender_last_account_ts: lastKnownFromAccountTs,
      }).catch((e) => {
        console.warn('[BG] Failed to persist last known account:', e?.message || e);
      });
    }

    function getFallbackHeartbeatAccount() {
      if (!state.currentTask) return '';
      const ageMs = Date.now() - Number(lastKnownFromAccountTs || 0);
      if (ageMs < 0 || ageMs > ACCOUNT_FALLBACK_LIVENESS_GRACE_MS) return '';
      return normalizeAccount(lastKnownFromAccount);
    }

    function classifyFailure(errorCode) {
      const code = String(errorCode || '').trim().toLowerCase();
      if (!code) return 'transient';
      if (code === 'invalid_username' || code === 'unauthorized_sender') return 'definitive';
      if (code === 'thread_identity_not_verified') return 'definitive';
      if (code.includes('timeout') || code.includes('not_found') || code.includes('recovery_failed')) return 'transient';
      if (code.includes('search_or_open_thread_failed')) return 'transient';
      if (code.includes('navigation_direct_failed')) return 'transient';
      if (code.includes('content_script_not_ready')) return 'transient';
      if (code.includes('send_not_confirmed') || code.includes('write_failed')) return 'transient';
      return 'transient';
    }

    function unwrapApiDataEnvelope(payload) {
      if (!payload || typeof payload !== 'object') return {};
      const nested = payload.data;
      if (nested && typeof nested === 'object' && !Array.isArray(nested)) return nested;
      return payload;
    }

    async function recordFailureMetric(errorCode) {
      const failureClass = classifyFailure(errorCode);
      if (failureClass === 'definitive') {
        definitiveFailureCount += 1;
      } else {
        transientFailureCount += 1;
      }
      try {
        await storageModule.saveState({
          dm_sender_failure_metrics: {
            transient: transientFailureCount,
            definitive: definitiveFailureCount,
            last_error_code: String(errorCode || '').trim().toLowerCase() || null,
            last_failure_class: failureClass,
            updated_at: Date.now(),
          },
        });
      } catch (e) {
        console.warn('[BG] Failed to persist failure metrics:', e?.message || e);
      }
      return failureClass;
    }

    function buildFailureMetrics() {
      return {
        transient: transientFailureCount,
        definitive: definitiveFailureCount,
      };
    }

    function isPopupClosedError(error) {
      const msg = String(error?.message || error || '').toLowerCase();
      return msg.includes('receiving end does not exist') || msg.includes('could not establish connection');
    }

    function isSafeThreadIdentityRetry(result) {
      const code = String(result?.error || '').trim().toLowerCase();
      if (code !== 'thread_identity_not_verified') return false;
      const steps = Array.isArray(result?.steps) ? result.steps.map((s) => String(s || '').trim().toLowerCase()) : [];
      if (!steps.length) return false;
      const touchedComposer = steps.includes('type_message') || steps.some((s) => s === 'send' || s.startsWith('sent:'));
      return !touchedComposer;
    }

    async function prepareThreadIdentityRetry() {
      try {
        const recovered = await ensureInstagramDirectReady(2);
        return !!recovered?.ok;
      } catch (e) {
        console.warn('[BG] prepareThreadIdentityRetry failed:', e?.message || e);
        return false;
      }
    }

    async function getLoggedInUsername() {
      try {
        const cookie = await chrome.cookies.get({ url: 'https://www.instagram.com', name: 'ds_user_id' });
        if (cookie?.value) {
          const igUserId = String(cookie.value).trim();
          return igUserId;
        }
        const tabs = await chrome.tabs.query({
          url: ['https://www.instagram.com/*', 'https://instagram.com/*'],
        });
        const tab = tabs.find((t) => t.active) || tabs[0];
        if (!tab?.id) return null;
        const r = await chrome.tabs.sendMessage(tab.id, { action: 'get_current_username' });
        const igUserIdOrUsername = (((r?.user_id != null ? String(r.user_id) : '') || r?.username || '')).trim();
        return igUserIdOrUsername || null;
      } catch {
        return null;
      }
    }

    async function pullTask() {
      const cfg = await authModule.loadSettings();
      if (!cfg.api_base || !authModule.isSecureApiBase(cfg.api_base)) {
        console.log('[BG] No hay API base configurada');
        return { status: 'error', reason: 'api_not_configured', retryAfterMs: 5000 };
      }
      const headers = await authModule.getAuthHeaders(cfg);
      if (!headers.Authorization) {
        console.log('[BG] No hay JWT válido (probá API Key en Opciones)');
        return { status: 'error', reason: 'auth_missing', retryAfterMs: 5000 };
      }

      let fromAccount = await getLoggedInUsername();
      if (!fromAccount) {
        try {
          const recovered = await ensureInstagramDirectReady(1);
          if (recovered?.ok) {
            fromAccount = await getLoggedInUsername();
          }
        } catch (e) {
          console.warn('[BG] Pull account recovery failed:', e?.message || e);
        }
      }
      if (!fromAccount) {
        console.log('[BG] Pull omitido: no hay pestaña de Instagram con cuenta detectada');
        return { status: 'error', reason: 'account_not_detected', retryAfterMs: 5000 };
      }
      rememberKnownAccount(fromAccount);
      console.log('[BG] Pull request:', { fromAccount: maskIdentity(fromAccount), limit: 1 });
      const url = buildApiUrl(cfg.api_base, '/api/send/pull');

      try {
        const resp = await fetchWithTimeout(url, {
          method: 'POST',
          headers,
          body: JSON.stringify({ limit: 1, from_account: fromAccount }),
        });

        if (!resp.ok) {
          const errText = await resp.text();
          let retryAfterMs = 5000;
          try {
            const parsed = JSON.parse(errText || '{}');
            const retryAfter = Number(parsed?.error?.details?.retry_after || 0);
            if (Number.isFinite(retryAfter) && retryAfter > 0) {
              retryAfterMs = Math.max(1000, Math.round(retryAfter * 1000));
            }
          } catch {}

          if (resp.status === 429) {
            console.warn('[BG] Pull rate-limited; retry in', retryAfterMs, 'ms');
            return { status: 'rate_limited', retryAfterMs };
          }

          console.error('[BG] Pull failed with status', resp.status);
          return { status: 'error', retryAfterMs };
        }

        const raw = await resp.json();
        const data = unwrapApiDataEnvelope(raw);
        console.log('[BG] Pull response:', { status: resp.status, itemsCount: data.items?.length || 0, fromAccount: maskIdentity(fromAccount) });
        if (data.items && data.items.length > 0) {
          updateProgress('pull_ok');
          return { status: 'task', task: data.items[0] };
        }
        console.log('[BG] Pull: no tasks available for account:', maskIdentity(fromAccount));
        return { status: 'empty' };
      } catch (e) {
        console.error('[BG] Pull error:', e);
        return { status: 'error', retryAfterMs: 5000 };
      }
    }

    async function sendReportRequest(report) {
      const cfg = await authModule.loadSettings();
      if (!cfg.api_base || !authModule.isSecureApiBase(cfg.api_base)) return false;

      const headers = await authModule.getAuthHeaders(cfg);
      if (!headers.Authorization) return false;
      const url = buildApiUrl(cfg.api_base, '/api/send/result');

      if (!report.job_id || !report.task_id) {
        console.warn('[BG] Report skipped: missing job_id or task_id', report);
        return true;
      }

      try {
        const body = {
          job_id: report.job_id,
          task_id: report.task_id,
          ok: !!report.ok,
          dest_username: report.dest_username || null,
          dry_run: !!report.dry_run,
        };
        if (report.error) {
          body.error = report.error;
        }

        console.log('[BG] Sending report:', { job_id: body.job_id, task_id: body.task_id, ok: body.ok, error: body.error });

        const resp = await fetchWithTimeout(url, {
          method: 'POST',
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
          const errorCode = String(errorPayload?.error?.code || '').trim().toUpperCase();
          console.warn('[BG] Report result failed with status', resp.status, 'code:', errorCode || 'UNKNOWN');
          if (resp.status === 400 && errorCode === 'TASK_ID_NOT_FOUND') {
            console.warn('[BG] Task no existe en DB, discarding orphan report');
            return true;
          }
          return false;
        }
        return true;
      } catch (e) {
        console.error('[BG] Report error:', e);
        return false;
      }
    }

    async function flushPendingReports() {
      if (reportFlushInFlight) return reportFlushInFlight;
      reportFlushInFlight = (async () => {
        const queue = await storageModule.getPendingReports();
        if (!queue.length) return true;
        const remaining = [];
        for (const report of queue) {
          const ok = await sendReportRequest(report);
          if (!ok) remaining.push(report);
        }
        await storageModule.saveState({ dm_sender_pending_reports: remaining.slice(-pendingReportsMax) });
        if (remaining.length < queue.length) {
          updateProgress('flush_ok');
        }
        return remaining.length === 0;
      })();
      try {
        return await reportFlushInFlight;
      } finally {
        reportFlushInFlight = null;
      }
    }

    async function reportResult(jobId, taskId, ok, destUsername, error = null, dryRun = false) {
      const report = {
        job_id: String(jobId || ''),
        task_id: String(taskId || ''),
        ok: !!ok,
        dest_username: destUsername || null,
        error: error || null,
        dry_run: !!dryRun,
        ts: Date.now(),
      };
      await storageModule.enqueuePendingReport(report);
      updateProgress('result_reported');
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
      
      const cfg = await authModule.loadSettings();
      if (!cfg.api_base || !authModule.isSecureApiBase(cfg.api_base)) {
        return false;
      }
      
      let headers = await authModule.getAuthHeaders(cfg);
      
      if (!headers.Authorization) {
        const refreshed = await authModule.refreshJwtSingleFlight(cfg);
        if (refreshed) {
          headers = await authModule.getAuthHeaders(cfg);
        }
        
        if (!headers.Authorization) {
          if (now - lastAuthErrorTs > AUTH_ERROR_BACKOFF_MS) {
            console.warn('[BG] Heartbeat: auth falló (sin JWT válido)');
            lastAuthErrorTs = now;
            lastAuthErrorReason = 'no_valid_jwt';
            
            storageModule.saveState({
              dm_last_auth_error: { ts: now, reason: 'no_valid_jwt' }
            }).catch((e) => {
              console.warn('[BG] Failed to persist dm_last_auth_error:', e?.message || e);
            });
          }
          return false;
        }
      }
      
      const hintedAccount = normalizeAccount(detectedAccountHint);
      const igAccount = hintedAccount || await getLoggedInUsername();
      if (igAccount) {
        rememberKnownAccount(igAccount);
      }
      const igAccountDetected = !!igAccount;
      const fallbackAccount = normalizeAccount(fromAccountOverride) || getFallbackHeartbeatAccount();
      const heartbeatAccount = normalizeAccount(igAccount) || fallbackAccount;
      
      const payload = {
        sender_instance_id: heartbeatInstanceId,
        autonomous: autonomous,
        sender_running: autonomous ? false : state.isRunning,
        ig_account_detected: igAccountDetected,
      };
      
      if (!autonomous && heartbeatAccount) {
        payload.from_account = heartbeatAccount;
      }
      
      try {
        const url = buildApiUrl(cfg.api_base, '/api/send/heartbeat');
        const resp = await fetchWithTimeout(url, {
          method: 'POST',
          headers,
          body: JSON.stringify(payload),
        });
        
        if (resp.status === 401) {
          if (now - lastAuthErrorTs > AUTH_ERROR_BACKOFF_MS) {
            console.warn('[BG] Heartbeat: 401 Unauthorized - JWT expirado o inválido');
            lastAuthErrorTs = now;
            lastAuthErrorReason = '401_unauthorized';
            
            storageModule.saveState({
              dm_last_auth_error: { ts: now, reason: '401_unauthorized' }
            }).catch((e) => {
              console.warn('[BG] Failed to persist dm_last_auth_error:', e?.message || e);
            });
          }
          return false;
        }
        
        if (resp.ok) {
          lastHeartbeatTs = now;
          if (lastAuthErrorReason) {
            lastAuthErrorReason = null;
            storageModule.saveState({ dm_last_auth_error: null }).catch((e) => {
              console.warn('[BG] Failed to clear dm_last_auth_error:', e?.message || e);
            });
          }
          return true;
        }
        return false;
      } catch (e) {
        console.warn('[BG] Heartbeat: network error', e?.message || e);
        return false;
      }
    }

    async function sendAutonomousHeartbeat() {
      return sendHeartbeat({ autonomous: true, force: true });
    }

    async function sendSenderHeartbeat(force = false) {
      const igAccount = await getLoggedInUsername();
      if (!igAccount) {
        const fallbackAccount = getFallbackHeartbeatAccount();
        if (fallbackAccount) {
          return sendHeartbeat({
            autonomous: false,
            force,
            fromAccountOverride: fallbackAccount,
          });
        }
        return sendAutonomousHeartbeat();
      }
      rememberKnownAccount(igAccount);
      return sendHeartbeat({ autonomous: false, force, detectedAccountHint: igAccount });
    }

    async function findOrCreateInstagramTab() {
      const tabs = await chrome.tabs.query({ url: ['https://www.instagram.com/*', 'https://instagram.com/*'] });

      if (tabs.length > 0) {
        const directTab = tabs.find((t) => (t?.url || '').includes('instagram.com/direct'));
        if (directTab) return directTab;
        return tabs[0];
      }

      const newTab = await chrome.tabs.create({
        url: 'https://www.instagram.com/',
        active: false,
      });

      await new Promise((resolve) => {
        const listener = (tabId, info) => {
          if (tabId === newTab.id && info.status === 'complete') {
            chrome.tabs.onUpdated.removeListener(listener);
            resolve();
          }
        };
        chrome.tabs.onUpdated.addListener(listener);

        setTimeout(() => {
          chrome.tabs.onUpdated.removeListener(listener);
          resolve();
        }, 15000);
      });

      return newTab;
    }

    async function waitTabLoadComplete(tabId, timeoutMs = 8000) {
      return new Promise((resolve) => {
        const listener = (updatedTabId, info) => {
          if (updatedTabId === tabId && info.status === 'complete') {
            chrome.tabs.onUpdated.removeListener(listener);
            resolve(true);
          }
        };
        chrome.tabs.onUpdated.addListener(listener);
        setTimeout(() => {
          chrome.tabs.onUpdated.removeListener(listener);
          resolve(false);
        }, timeoutMs);
      });
    }

    async function ensureInstagramDirectReady(maxAttempts = 2) {
      const attempts = Math.max(1, Number(maxAttempts || 1));
      const directUrl = 'https://www.instagram.com/direct/';
      let lastError = 'instagram_direct_not_ready';

      for (let attempt = 1; attempt <= attempts; attempt++) {
        try {
          const tab = await findOrCreateInstagramTab();
          if (!tab?.id) {
            lastError = 'instagram_tab_not_found';
            continue;
          }

          let currentTab = null;
          try {
            currentTab = await chrome.tabs.get(tab.id);
          } catch {
            lastError = 'instagram_tab_closed';
            continue;
          }

          const currentUrl = String(currentTab?.url || tab.url || '');
          if (!currentUrl.includes('instagram.com/direct')) {
            await chrome.tabs.update(tab.id, { url: directUrl });
            await waitTabLoadComplete(tab.id, 10000);
            await new Promise((r) => setTimeout(r, 1200));
          }

          try {
            currentTab = await chrome.tabs.get(tab.id);
          } catch {
            lastError = 'instagram_tab_closed_after_update';
            continue;
          }
          if (!currentTab?.url || !String(currentTab.url).includes('instagram.com')) {
            lastError = 'instagram_tab_not_on_instagram';
            continue;
          }

          const csReady = await ensureContentScriptReady(tab.id, 3);
          if (csReady) {
            return { ok: true, tabId: tab.id };
          }
          lastError = 'content_script_not_ready';
        } catch (e) {
          lastError = String(e?.message || e || 'instagram_recovery_failed');
        }
      }

      return { ok: false, error: lastError };
    }

    async function ensureContentScriptReady(tabId, maxTries = 3) {
      let lastErr = null;
      for (let i = 1; i <= maxTries; i++) {
        try {
          const r = await chrome.tabs.sendMessage(tabId, { action: 'content_ready' });
          if (r && r.ready) {
            console.log('[BG] Handshake content_ready OK (tab', tabId, ', intento', i, ', build', r.build || 'n/a', ')');
            return true;
          }
        } catch (e) {
          lastErr = e;
          const isReceivingEnd = (e.message || '').includes('Receiving end does not exist');
          if (!isReceivingEnd) {
            console.warn('[BG] Handshake content_ready falló:', e.message || e);
            await new Promise((r) => setTimeout(r, 400));
            continue;
          }

          if (i < maxTries) {
            console.warn('[BG] Content script no listo (handshake), recargando tab y reintentando...');
            try {
              await chrome.tabs.reload(tabId);
            } catch {}
            await waitTabLoadComplete(tabId, 8000);
            await new Promise((r) => setTimeout(r, 1200));
          }
        }
      }
      if (lastErr) {
        console.warn('[BG] Handshake content_ready no logró conectar:', lastErr.message || lastErr);
      }
      return false;
    }

    async function sendDMViaContentScript(username, message, dryRun = true) {
      console.log(`[BG] Enviando DM a ${maskIdentity(username)}, dryRun: ${dryRun}`);

      try {
        const recoveredInitial = await ensureInstagramDirectReady(2);
        if (!recoveredInitial?.ok || !recoveredInitial?.tabId) {
          return {
            success: false,
            error: 'instagram_recovery_failed',
            detail: 'No se pudo recuperar automaticamente la pestaña de Instagram Direct.',
          };
        }
        let activeTabId = recoveredInitial.tabId;
        await new Promise((r) => setTimeout(r, 500));

        const payload = {
          action: 'send_dm',
          username,
          text: message,
          dryRun,
        };
        const maxTries = 3;
        let lastErr = null;
        for (let tryNum = 1; tryNum <= maxTries; tryNum++) {
          try {
            console.log('[BG] Enviando mensaje send_dm al content script (tab', activeTabId, ', intento', tryNum, ')');
            const result = await chrome.tabs.sendMessage(activeTabId, payload);
            console.log('[BG] Resultado send_dm:', result?.success ? 'ok' : 'error');
            if (result) {
              updateProgress('content_ack');
            }
            if (!result.success && result.error) {
              console.error('[BG] send_dm falló:', result.error || 'unknown_error');
            }
            return result;
          } catch (e) {
            lastErr = e;
            const rawMsg = String(e?.message || e || '');
            const lowerMsg = rawMsg.toLowerCase();
            const shouldRecoverTab =
              lowerMsg.includes('receiving end does not exist') ||
              lowerMsg.includes('no tab with id') ||
              lowerMsg.includes('tabs cannot be edited') ||
              lowerMsg.includes('cannot access a chrome://');
            if (shouldRecoverTab && tryNum < maxTries) {
              console.warn('[BG] send_dm sin tab usable, intentando recuperación agresiva...');
              const recovered = await ensureInstagramDirectReady(2);
              if (!recovered?.ok || !recovered?.tabId) {
                throw e;
              }
              activeTabId = recovered.tabId;
              await new Promise((r) => setTimeout(r, 700));
            } else {
              throw e;
            }
          }
        }
        throw lastErr;
      } catch (e) {
        console.error('[BG] sendDMViaContentScript error:', e);
        const msg = (e && e.message) || String(e);
        if (msg.includes('Receiving end does not exist')) {
          return {
            success: false,
            error: 'Extensión no conectada a la pestaña. Abre una pestaña en instagram.com/direct/ (o recarga la de Instagram) y vuelve a Iniciar.',
          };
        }
        if (msg.includes('instagram_recovery_failed')) {
          return {
            success: false,
            error: 'No se pudo recuperar la pestaña de Instagram Direct automáticamente. Abrila manualmente y reintentá.',
          };
        }
        return { success: false, error: msg };
      }
    }

    async function sendDMViaContentScriptWithTimeout(username, message, dryRun = true) {
      return Promise.race([
        sendDMViaContentScript(username, message, dryRun),
        new Promise((resolve) =>
          setTimeout(() => resolve({ success: false, error: 'send_dm_timeout', timeout: true }), SEND_DM_TOTAL_TIMEOUT_MS)
        ),
      ]);
    }

    async function processNextTask(prefetchedTask = null) {
      await storageModule.loadState();
      const runVersion = senderRunVersion;
      const isRunAborted = () => !state.isRunning || runVersion !== senderRunVersion;

      if (state.isProcessing) {
        const now = Date.now();
        if (now - lastProcessingSkipLogTs > 10000) {
          console.log('[BG] Ya hay un envío en curso, esperando...');
          lastProcessingSkipLogTs = now;
        }
        return;
      }
      const processToken = Symbol('process_next_task');
      activeProcessToken = processToken;
      state.isProcessing = true;

      try {
        if (isRunAborted()) {
          const now = Date.now();
          if (now - lastSenderNotRunningLogTs > 10000) {
            console.log('[BG] Sender no está corriendo');
            lastSenderNotRunningLogTs = now;
          }
          return;
        }

        sendSenderHeartbeat().catch((e) => {
          console.warn('[BG] sendSenderHeartbeat failed:', e?.message || e);
        });
        flushPendingReports().catch((e) => {
          console.warn('[BG] flushPendingReports failed:', e?.message || e);
        });

        if (state.dmsSentThisSession >= config.maxDMsPerSession) {
          console.log('[BG] Límite de sesión alcanzado');
          try {
            await stopSender('session_limit');
          } catch (e) {
            console.error('[BG] Error stopping sender (session_limit):', e);
          }
          return;
        }

        const now = Date.now();
        if (state.nextDMTime > now) {
          if (progressStage !== 'cooldown_wait') {
            updateProgress('cooldown_wait');
          } else {
            markProgressStage('cooldown_wait');
          }
          console.log(`[BG] Esperando... próximo DM en ${Math.round((state.nextDMTime - now) / 1000)}s`);
          return;
        }

        let task = prefetchedTask || null;
        if (!task) {
          if (wsModule.isSendWsConnected() && wsModule.hasPendingWsTasks()) {
            task = wsModule.shiftPendingWsTask();
            if (task) {
              updateProgress('ws_tasks');
            }
          } else {
            if (wsModule.isSendWsConnected() && state.isRunning) {
              const requested = wsModule.requestSendWsPull();
              if (requested) {
                const wsTask = await wsModule.waitForWsTask(wsPullGraceMs);
                if (wsTask) {
                  task = wsTask;
                  updateProgress('ws_tasks');
                }
              }
            }

            if (!task) {
              console.log('[BG] Pulling task (HTTP)...');
              const pull = await pullTask();
              if (isRunAborted()) {
                return;
              }
              if (pull?.status === 'task') {
                task = pull.task;
              } else if (pull?.status === 'empty') {
                task = null;
              } else {
                let waitMs = Math.max(1000, Number(pull?.retryAfterMs || 5000));
                const pullReason = String(pull?.reason || '').trim().toLowerCase();
                if (pullReason === 'account_not_detected') {
                  console.warn('[BG] Pull sin cuenta detectada: intentando recuperación agresiva de pestaña...');
                  try {
                    const recovered = await ensureInstagramDirectReady(1);
                    if (recovered?.ok) {
                      waitMs = Math.min(waitMs, 1500);
                    }
                  } catch (e) {
                    console.warn('[BG] Pull recovery failed:', e?.message || e);
                  }
                }
                console.warn('[BG] Pull no disponible temporalmente, reintentando en', waitMs, 'ms');
                if (state.isRunning) {
                  scheduleProcessNextTask(waitMs, 'pull_retry');
                }
                return;
              }
            }
          }
        }

        if (!task) {
          emptyPullStreak += 1;
          const shouldStopForNoTasks = emptyPullStreak >= EMPTY_PULL_MAX_STREAK_BEFORE_STOP;
          if (!shouldStopForNoTasks) {
            const retryMs = Math.min(5000, EMPTY_PULL_RETRY_BASE_MS + (emptyPullStreak - 1) * 500);
            updateProgress('no_tasks_retry');
            chrome.runtime.sendMessage({
              type: 'dm_status_update',
              data: {
                isRunning: true,
                message: `Sin tareas por ahora. Reintentando en ${Math.max(1, Math.ceil(retryMs / 1000))}s...`,
              },
            }).catch((e) => {
              if (!isPopupClosedError(e)) {
                console.warn('[BG] Failed to notify popup (no_tasks_retry):', e?.message || e);
              }
            });
            if (state.isRunning) {
              scheduleProcessNextTask(retryMs, 'no_tasks_retry');
            }
            return;
          }

          emptyPullStreak = 0;
          console.log('[BG] No hay tareas pendientes (confirmado tras reintentos)');
          try {
            await stopSender('no_tasks');
            chrome.runtime.sendMessage({
              type: 'dm_status_update',
              data: {
                isRunning: false,
                message: 'No hay más mensajes pendientes para enviar.',
              },
            }).catch((e) => {
              if (!isPopupClosedError(e)) {
                console.warn('[BG] Failed to notify popup (no_tasks):', e?.message || e);
              }
            });
          } catch (e) {
            console.error('[BG] Error stopping sender (no_tasks):', e);
          }
          return;
        }

        emptyPullStreak = 0;

        if (isRunAborted()) {
          return;
        }

        console.log('[BG] Task obtenida:', String(task?.task_id || 'sin_task_id'));
        state.currentTask = task;
        watchdogRecoveryAttempts = 0;
        updateProgress('task_claimed');
        await storageModule.saveState({
          dm_current_task: {
            job_id: task.job_id,
            task_id: task.task_id,
            dest_username: task.dest_username || task.payload?.target_username,
            claimed_at: Date.now(),
          },
        });

        const username = task.dest_username || task.payload?.target_username;
        const message = task.payload?.message_template || task.payload?.message || 'Hola!';
        const dryRun = task.payload?.dry_run !== false;

        if (!username) {
          console.error('[BG] Task sin username');
          await reportResult(task.job_id, task.task_id, false, null, 'missing_username');
          return;
        }

        const processed = await storageModule.getProcessedTaskResult(task.task_id);
        if (processed && processed.report) {
          console.warn('[BG] Task ya procesada localmente; se omite reenvío y se reintenta reportar', task.task_id);
          await reportResult(
            task.job_id,
            task.task_id,
            !!processed.report.ok,
            processed.report.dest_username || username,
            processed.report.error || null,
            !!processed.report.dry_run
          );
          state.currentTask = null;
          return;
        }

        if (isRunAborted()) {
          await reportResult(task.job_id, task.task_id, false, username, 'sender_stopped_before_send', dryRun);
          state.currentTask = null;
          return;
        }

        console.log(`[BG] Ejecutando DM a ${maskIdentity(username)} (dryRun: ${dryRun})`);
        let result = await sendDMViaContentScriptWithTimeout(username, message, dryRun);

        let threadIdentityRetries = 0;
        while (
          !result?.success &&
          isSafeThreadIdentityRetry(result) &&
          threadIdentityRetries < THREAD_IDENTITY_MAX_RETRIES &&
          !isRunAborted()
        ) {
          threadIdentityRetries += 1;
          console.warn(
            '[BG] thread_identity_not_verified para',
            maskIdentity(username),
            '- reintento controlado',
            `${threadIdentityRetries}/${THREAD_IDENTITY_MAX_RETRIES}`
          );
          updateProgress('thread_identity_retry');
          const prepared = await prepareThreadIdentityRetry();
          if (!prepared) break;
          await new Promise((r) => setTimeout(r, 900));
          result = await sendDMViaContentScriptWithTimeout(username, message, dryRun);
        }

        await storageModule.rememberProcessedTaskResult(task.task_id, {
          ok: !!result.success,
          dest_username: username,
          error: result.error || null,
          dry_run: !!dryRun,
        });

        const errorCode = String(result?.error || '').trim().toLowerCase();
        let failureClass = null;
        if (!result.success) {
          try {
            failureClass = await recordFailureMetric(errorCode);
          } catch (e) {
            console.warn('[BG] recordFailureMetric failed:', e?.message || e);
            failureClass = classifyFailure(errorCode);
          }
        }

        await reportResult(task.job_id, task.task_id, result.success, username, result.error, dryRun);

        if (!result.success && errorCode === 'thread_identity_not_verified') {
          consecutiveThreadIdentityFails += 1;
          state.currentTask = null;

          if (consecutiveThreadIdentityFails >= THREAD_IDENTITY_CONSECUTIVE_STOP_THRESHOLD) {
            console.warn(
              '[BG] Corte preventivo: identidad de thread no verificada de forma consecutiva para',
              maskIdentity(username),
              '- se detiene sender para evitar errores en cascada.'
            );
            try {
              await stopSender('thread_identity_not_verified');
            } catch (e) {
              console.error('[BG] Error stopping sender (thread_identity):', e);
            }
            chrome.runtime.sendMessage({
              type: 'dm_status_update',
              data: {
                lastUsername: username,
                success: false,
                sessionCount: state.dmsSentThisSession,
                nextDMTime: 0,
                isRunning: false,
                error: 'thread_identity_not_verified',
                failureClass: failureClass || 'definitive',
              },
            }).catch((e) => {
              if (!isPopupClosedError(e)) {
                console.warn('[BG] Failed to notify popup (thread_identity):', e?.message || e);
              }
            });
            return;
          }

          const retryAfterMs = 6000;
          state.nextDMTime = Date.now() + retryAfterMs;
          updateProgress('thread_identity_skip');
          await storageModule.saveState({
            dm_sender_next_time: state.nextDMTime,
          });
          chrome.runtime.sendMessage({
            type: 'dm_status_update',
            data: {
              lastUsername: username,
              success: false,
              sessionCount: state.dmsSentThisSession,
              nextDMTime: state.nextDMTime,
              isRunning: true,
              error: 'thread_identity_not_verified',
              failureClass: failureClass || 'definitive',
              message: 'No se pudo validar el hilo; se salta este contacto y se continúa.',
            },
          }).catch((e) => {
            if (!isPopupClosedError(e)) {
              console.warn('[BG] Failed to notify popup (thread_identity_soft):', e?.message || e);
            }
          });
          if (state.isRunning) {
            scheduleProcessNextTask(retryAfterMs, 'thread_identity_skip');
          }
          return;
        }

        if (result.success || errorCode !== 'thread_identity_not_verified') {
          consecutiveThreadIdentityFails = 0;
        }

        if (result.success) {
          state.dmsSentThisSession++;
          state.lastDMTime = Date.now();
          if (dryRun) {
            state.nextDMTime = Date.now() + 5000;
          } else {
            state.nextDMTime = Date.now() + randomBetween(config.minDelayBetweenDMs, config.maxDelayBetweenDMs);
          }
        } else {
          state.nextDMTime = Date.now() + 10000;
        }
        state.currentTask = null;

        await storageModule.saveState({
          dm_sender_session_count: state.dmsSentThisSession,
          dm_sender_last_time: state.lastDMTime,
          dm_sender_next_time: state.nextDMTime,
        });

        chrome.runtime.sendMessage({
          type: 'dm_status_update',
          data: {
            lastUsername: username,
            success: result.success,
            sessionCount: state.dmsSentThisSession,
            nextDMTime: state.nextDMTime,
            failureClass: failureClass || null,
          },
        }).catch((e) => {
          if (!isPopupClosedError(e)) {
            console.warn('[BG] Failed to notify popup (dm_status_update):', e?.message || e);
          }
        });

        if (dryRun) {
          console.log(`[BG] Dry-run OK para ${maskIdentity(username)}. Siguiente usuario en 5 s.`);
        } else if (!result.success) {
          console.log(
            `[BG] DM fallido para ${maskIdentity(username)} (${result.error || 'unknown_error'}) [${failureClass || 'transient'}]. Reintento de siguiente tarea en 10 s.`
          );
        } else {
          console.log(`[BG] DM ${result.success ? 'exitoso' : 'fallido'} a ${maskIdentity(username)}. Próximo en ${Math.round((state.nextDMTime - Date.now()) / 60000)} minutos`);
        }

        if (state.isRunning) {
          if (!result.success) {
            scheduleProcessNextTask(10000, 'after_send_error');
          } else if (dryRun) {
            scheduleProcessNextTask(5000, 'after_dry_run');
          } else if (wsModule.hasPendingWsTasks() || !wsModule.isSendWsConnected()) {
            const delay = Math.max(1000, state.nextDMTime - Date.now());
            scheduleProcessNextTask(delay, 'after_send_delay');
          }
        }
      } finally {
        if (activeProcessToken === processToken) {
          activeProcessToken = null;
          state.isProcessing = false;
        }
      }
    }

    async function startSender(options = {}) {
      if (state.isRunning) {
        return { status: 'already_running' };
      }
      const now = Date.now();
      if (noTasksRestartCooldownUntil > now) {
        return {
          status: 'no_tasks_cooldown',
          retryAfterMs: Math.max(1000, noTasksRestartCooldownUntil - now),
        };
      }
      if (startSenderInFlight || activeProcessToken) {
        return { status: 'starting' };
      }

      console.log('[BG] Iniciando sender...');

      startSenderInFlight = true;
      const deferFirstPull = !!options?.deferFirstPull;
      const allowIdleStart = !!options?.allowIdleStart;

      try {
        let prefetchedTask = null;
        if (!allowIdleStart) {
          const preflight = await pullTask();
          if (preflight?.status === 'task') {
            prefetchedTask = preflight.task;
          } else if (preflight?.status === 'empty') {
            return { status: 'no_tasks' };
          } else {
            return {
              status: 'error',
              reason: preflight?.reason || 'pull_unavailable',
              retryAfterMs: Math.max(1000, Number(preflight?.retryAfterMs || 5000)),
            };
          }
        }

        clearPendingProcessNextTimer();
        senderRunVersion += 1;
        state.isRunning = true;
        state.dmsSentThisSession = 0;
        emptyPullStreak = 0;
        consecutiveThreadIdentityFails = 0;
        transientFailureCount = 0;
        definitiveFailureCount = 0;
        wsModule.resetSendWsFailures();
        state.nextDMTime = Date.now();
        watchdogRecoveryAttempts = 0;
        updateProgress('started');

        await storageModule.saveState({
          dm_sender_running: true,
          dm_sender_session_count: 0,
          dm_sender_next_time: state.nextDMTime,
          dm_sender_failure_metrics: {
            transient: transientFailureCount,
            definitive: definitiveFailureCount,
            last_error_code: null,
            last_failure_class: null,
            updated_at: Date.now(),
          },
        });

        const cfg = await authModule.loadSettings();
        await wsModule.connectSendWs(cfg);
        const heartbeatOk = await sendSenderHeartbeat(true);
        if (!heartbeatOk) {
          console.warn('[BG] Heartbeat preflight falló; sender no quedó activo.');
          await stopSender('heartbeat_preflight_failed');
          return { status: 'error', reason: 'sender_offline' };
        }

        chrome.alarms.create(state.pollAlarmName, {
          periodInMinutes: config.pollIntervalMs / 60000,
        });
        flushPendingReports().catch((e) => {
          console.warn('[BG] flushPendingReports on start failed:', e?.message || e);
        });

        if (prefetchedTask) {
          await processNextTask(prefetchedTask);
        } else if (!deferFirstPull) {
          await processNextTask();
        }

        return {
          status: 'started',
          defer_first_pull: deferFirstPull,
          prefetched_task: !!prefetchedTask,
          idle_start: allowIdleStart,
        };
      } finally {
        startSenderInFlight = false;
      }
    }

    async function stopSender(reason = 'manual') {
      if (!state.isRunning && !activeProcessToken) {
        return { status: 'already_stopped', reason };
      }
      console.log('[BG] Deteniendo sender, razón:', reason);

      senderRunVersion += 1;
      const hasActiveProcessing = !!activeProcessToken;

      if (reason === 'no_tasks') {
        noTasksRestartCooldownUntil = Date.now() + NO_TASKS_RESTART_COOLDOWN_MS;
      } else if (reason !== 'manual') {
        noTasksRestartCooldownUntil = 0;
      }

      state.isRunning = false;
      emptyPullStreak = 0;
      consecutiveThreadIdentityFails = 0;
      if (!hasActiveProcessing) {
        state.isProcessing = false;
        state.currentTask = null;
      }
      lastHeartbeatTs = 0;
      watchdogRecoveryAttempts = 0;
      updateProgress('idle');
      if (pendingProcessTriggerTimer) {
        clearTimeout(pendingProcessTriggerTimer);
        pendingProcessTriggerTimer = null;
      }
      clearPendingProcessNextTimer();
      wsModule.disconnectSendWs();

      const statePatch = {
        dm_sender_running: false,
      };
      if (!hasActiveProcessing || !state.currentTask) {
        statePatch.dm_current_task = null;
      }
      await storageModule.saveState(statePatch);

      chrome.alarms.clear(state.pollAlarmName);

      chrome.runtime.sendMessage({
        type: 'dm_status_update',
        data: {
          lastUsername: null,
          success: null,
          sessionCount: state.dmsSentThisSession,
          nextDMTime: state.nextDMTime,
          isRunning: false,
        },
      }).catch((e) => {
        if (!isPopupClosedError(e)) {
          console.warn('[BG] Failed to notify popup (sender_stopped):', e?.message || e);
        }
      });

      return { status: 'stopped', reason };
    }

 async function getSenderStatus() {
      await storageModule.loadState();

      const now = Date.now();
      const timeUntilNext = Math.max(0, state.nextDMTime - now);

      return {
        isRunning: state.isRunning,
        isProcessing: state.isProcessing,
        sessionCount: state.dmsSentThisSession,
        lastDMTime: state.lastDMTime,
        nextDMTime: state.nextDMTime,
        timeUntilNextMs: timeUntilNext,
        timeUntilNextFormatted: formatTime(timeUntilNext),
        currentTask: state.currentTask,
        progressStage: progressStage,
        lastProgressTs: lastProgressTs,
        watchdogRecoveryAttempts: watchdogRecoveryAttempts,
        watchdogState: getWatchdogState(),
        failureMetrics: buildFailureMetrics(),
        noTasksRestartCooldownMs: Math.max(0, noTasksRestartCooldownUntil - now),
      };
    }

    async function runWatchdog() {
      if (!state.isRunning) return;
      if (watchdogRecoveryInFlight) return;

      const now = Date.now();
      if (!state.currentTask && state.nextDMTime > now) {
        markProgressStage('cooldown_wait');
        return;
      }
      const timeSinceProgress = now - lastProgressTs;

      const isNavigationStage = ['started', 'task_claimed', 'ws_tasks', 'pull_ok'].includes(progressStage);
      const effectiveTimeout = isNavigationStage ? WATCHDOG_NO_PROGRESS_TIMEOUT_NAV_MS : WATCHDOG_NO_PROGRESS_TIMEOUT_MS;

      if (timeSinceProgress > effectiveTimeout) {
        console.warn(`[BG] Watchdog: no progress for ${Math.round(timeSinceProgress / 1000)}s (stage: ${progressStage}, timeout: ${Math.round(effectiveTimeout / 1000)}s)`);

        if (watchdogRecoveryAttempts >= WATCHDOG_MAX_RECOVERY_ATTEMPTS) {
          console.error('[BG] Watchdog: max recovery attempts reached, stopping sender');
          await stopSender('watchdog_max_recovery');
          chrome.runtime.sendMessage({
            type: 'dm_status_update',
            data: {
              error: 'watchdog_stuck',
              message: 'El envío se detuvo por falta de progreso. Revisá Instagram y reiniciá.',
              isRunning: false,
            },
          }).catch((e) => {
            if (!isPopupClosedError(e)) {
              console.warn('[BG] Failed to notify popup (watchdog_stuck):', e?.message || e);
            }
          });
          return;
        }

        watchdogRecoveryAttempts++;
        console.log(`[BG] Watchdog: recovery attempt ${watchdogRecoveryAttempts}/${WATCHDOG_MAX_RECOVERY_ATTEMPTS}`);
        watchdogRecoveryInFlight = (async () => {
          try {
            await performWatchdogRecovery();
          } finally {
            watchdogRecoveryInFlight = null;
          }
        })();
        await watchdogRecoveryInFlight;
      }
    }

    async function performWatchdogRecovery() {
      if (state.currentTask) {
        console.warn('[BG] Watchdog: reporting stuck task as uncertain');
        await reportResult(
          state.currentTask.job_id,
          state.currentTask.task_id,
          false,
          state.currentTask.dest_username,
          'watchdog_uncertain_timeout'
        );
        state.currentTask = null;
      }

      if (!wsModule.isSendWsConnected()) {
        const cfg = await authModule.loadSettings();
        await wsModule.connectSendWs(cfg);
      }

      try {
        const recovered = await ensureInstagramDirectReady(2);
        if (!recovered?.ok) {
          console.warn('[BG] Watchdog: aggressive tab recovery did not succeed');
        }
      } catch (e) {
        console.warn('[BG] Watchdog: tab recovery failed', e?.message || e);
      }

      updateProgress('recovery');

      if (state.isRunning) {
        scheduleProcessNextTask(0, 'watchdog_recovery');
      }
    }

    async function reportOrphanTask(task) {
      if (!task) return;
      console.warn('[BG] Reporting orphan task:', task.task_id);
      await reportResult(task.job_id, task.task_id, false, task.dest_username, 'orphan_on_restart');
      await storageModule.saveState({ dm_current_task: null });
    }

    function getWatchdogState() {
      return {
        lastProgressTs,
        progressStage,
        watchdogRecoveryAttempts,
        emptyPullStreak,
        consecutiveThreadIdentityFails,
        failureMetrics: buildFailureMetrics(),
        noProgressTimeoutMs: WATCHDOG_NO_PROGRESS_TIMEOUT_MS,
        maxRecoveryAttempts: WATCHDOG_MAX_RECOVERY_ATTEMPTS,
      };
    }

    function restoreProgressState(progressTs, stage) {
      const restoredTs = Number(progressTs || 0);
      lastProgressTs = restoredTs > 0 ? restoredTs : Date.now();
      const restoredStage = String(stage || '').trim();
      progressStage = restoredStage || 'idle';
    }

    function restoreKnownAccount(account, accountTs = 0) {
      const normalized = normalizeAccount(account);
      if (!normalized) {
        lastKnownFromAccount = '';
        lastKnownFromAccountTs = 0;
        return;
      }
      lastKnownFromAccount = normalized;
      lastKnownFromAccountTs = Number(accountTs || 0) || Date.now();
    }


    return {
      triggerProcessNextTaskThrottled,
      getLoggedInUsername,
      pullTask,
      sendReportRequest,
      flushPendingReports,
      reportResult,
      sendSenderHeartbeat,
      sendAutonomousHeartbeat,
      findOrCreateInstagramTab,
      waitTabLoadComplete,
      ensureContentScriptReady,
      sendDMViaContentScript,
      processNextTask,
      startSender,
      stopSender,
      getSenderStatus,
      formatTime,
      runWatchdog,
      reportOrphanTask,
      getWatchdogState,
      restoreProgressState,
      restoreKnownAccount,
    };
  }

  globalScope.createBackgroundJobsModule = createBackgroundJobsModule;
})(self);
