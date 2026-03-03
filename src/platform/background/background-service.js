// background.js - BeLeadAI Service Worker
// Coordina el polling de tareas y la comunicación con el content script

importScripts(
  '/src/platform/background/modules/storage.js',
  '/src/platform/background/modules/auth.js',
  '/src/platform/background/modules/ws.js',
  '/src/platform/background/modules/jobs.js',
  '/src/platform/background/modules/job-notifier.js',
  '/src/platform/background/modules/messaging.js'
);

// =====================================================
// CONFIGURACIÓN
// =====================================================
const CONFIG = {
  minDelayBetweenDMs: 180000,
  maxDelayBetweenDMs: 420000,
  pollIntervalMs: 30000,
  maxDMsPerSession: 20,
};

// =====================================================
// ESTADO
// =====================================================
const state = {
  isRunning: false,
  isProcessing: false,
  currentTask: null,
  dmsSentThisSession: 0,
  lastDMTime: 0,
  nextDMTime: 0,
  pollAlarmName: 'beleadai-poll',
  heartbeatAlarmName: 'beleadai-heartbeat',
  watchdogAlarmName: 'beleadai-watchdog',
};

const PROCESS_TRIGGER_MIN_GAP_MS = 1200;
const ENSURE_JOBS_WS_DEBOUNCE_MS = 3000;
const HEARTBEAT_MIN_GAP_MS = 20000;
const HEARTBEAT_AUTONOMOUS_INTERVAL_MS = 15000;
const WATCHDOG_INTERVAL_MS = 30000;
const WATCHDOG_NO_PROGRESS_TIMEOUT_MS = 60000;
const HEARTBEAT_INSTANCE_ID = `${chrome.runtime.id}:bg`;
const WS_PULL_GRACE_MS = 350;
const PROCESSED_TASK_TTL_MS = 30 * 60 * 1000;
const PROCESSED_TASK_MAX = 500;
const PENDING_REPORTS_MAX = 500;
const REFRESH_BACKOFF_MS = 15000;
const WS_RECONNECT_DELAY_MS = 5000;
const SEND_WS_MAX_RETRIES = 3;
const JOBS_WS_RECONNECT_DELAY_MS = 5000;
const JOBS_WS_MAX_RETRIES = 2;
const JOBS_WS_DISABLE_MS = 5 * 60 * 1000;

const storageModule = self.createBackgroundStorageModule({
  state,
  processedTaskTtlMs: PROCESSED_TASK_TTL_MS,
  processedTaskMax: PROCESSED_TASK_MAX,
  pendingReportsMax: PENDING_REPORTS_MAX,
});

const authModule = self.createBackgroundAuthModule({
  storageModule,
  refreshBackoffMs: REFRESH_BACKOFF_MS,
});

const wsModule = self.createBackgroundWsModule({
  state,
  authModule,
  wsReconnectDelayMs: WS_RECONNECT_DELAY_MS,
  sendWsMaxRetries: SEND_WS_MAX_RETRIES,
  jobsWsReconnectDelayMs: JOBS_WS_RECONNECT_DELAY_MS,
  jobsWsMaxRetries: JOBS_WS_MAX_RETRIES,
  jobsWsDisableMs: JOBS_WS_DISABLE_MS,
  wsPullGraceMs: WS_PULL_GRACE_MS,
});

const jobsModule = self.createBackgroundJobsModule({
  state,
  config: CONFIG,
  storageModule,
  authModule,
  wsModule,
  processTriggerMinGapMs: PROCESS_TRIGGER_MIN_GAP_MS,
  heartbeatMinGapMs: HEARTBEAT_MIN_GAP_MS,
  heartbeatInstanceId: HEARTBEAT_INSTANCE_ID,
  wsPullGraceMs: WS_PULL_GRACE_MS,
  pendingReportsMax: PENDING_REPORTS_MAX,
});

const jobNotifierModule = self.createBackgroundJobNotifierModule({
  authModule,
  storageModule,
});

wsModule.setGetLoggedInUsername(jobsModule.getLoggedInUsername);
wsModule.setOnSendTasksReceived(() => {
  if (!state.isProcessing && state.isRunning) {
    jobsModule.triggerProcessNextTaskThrottled('send_ws_tasks');
  }
});

const messagingModule = self.createBackgroundMessagingModule({
  jobsModule,
  authModule,
  wsModule,
  ensureJobsWsDebounceMs: ENSURE_JOBS_WS_DEBOUNCE_MS,
});

messagingModule.registerMessageHandlers();

// =====================================================
// EVENT LISTENERS
// =====================================================

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === state.pollAlarmName) {
    console.log('[BG] Poll alarm triggered, procesando...');
    jobsModule.sendSenderHeartbeat().catch((e) => {
      console.warn('[BG] Poll alarm heartbeat failed:', e?.message || e);
    });
    jobsModule.flushPendingReports().catch((e) => {
      console.warn('[BG] Poll alarm flushPendingReports failed:', e?.message || e);
    });
    jobsModule.triggerProcessNextTaskThrottled('alarm');
    jobNotifierModule.triggerSync('poll_alarm').catch((e) => {
      console.warn('[BG] Poll alarm notifier sync failed:', e?.message || e);
    });
  }
  if (alarm.name === state.heartbeatAlarmName) {
    jobsModule.sendAutonomousHeartbeat().catch((e) => {
      console.warn('[BG] Autonomous heartbeat failed:', e?.message || e);
    });
    jobsModule.flushPendingReports().catch((e) => {
      console.warn('[BG] Autonomous flushPendingReports failed:', e?.message || e);
    });
    jobNotifierModule.triggerSync('heartbeat_alarm').catch((e) => {
      console.warn('[BG] Heartbeat notifier sync failed:', e?.message || e);
    });
  }
  if (alarm.name === state.watchdogAlarmName) {
    jobsModule.runWatchdog().catch((e) => {
      console.warn('[BG] Watchdog run failed:', e?.message || e);
    });
  }
});

function ensureAutonomousHeartbeatAlarm() {
  chrome.alarms.get(state.heartbeatAlarmName, (existing) => {
    if (!existing) {
      chrome.alarms.create(state.heartbeatAlarmName, {
        periodInMinutes: HEARTBEAT_AUTONOMOUS_INTERVAL_MS / 60000,
      });
      console.log('[BG] Autonomous heartbeat alarm created (every', HEARTBEAT_AUTONOMOUS_INTERVAL_MS / 1000, 's)');
    }
  });
}

function ensureWatchdogAlarm() {
  chrome.alarms.get(state.watchdogAlarmName, (existing) => {
    if (!existing) {
      chrome.alarms.create(state.watchdogAlarmName, {
        periodInMinutes: WATCHDOG_INTERVAL_MS / 60000,
      });
      console.log('[BG] Watchdog alarm created (every', WATCHDOG_INTERVAL_MS / 1000, 's)');
    }
  });
}

async function recoverFromPreviousState() {
  const data = await storageModule.storageGetLocal({
    dm_sender_running: false,
    dm_current_task: null,
    dm_last_progress_ts: 0,
    dm_progress_stage: 'idle',
    dm_sender_last_account: '',
    dm_sender_last_account_ts: 0,
  });

  jobsModule.restoreKnownAccount(data.dm_sender_last_account, data.dm_sender_last_account_ts);

  if (data.dm_sender_running) {
    console.log('[BG] Recuperando estado anterior: sender estaba corriendo');

    if (data.dm_current_task) {
      const taskAge = Date.now() - (data.dm_current_task.claimed_at || 0);
      if (taskAge > WATCHDOG_NO_PROGRESS_TIMEOUT_MS) {
        console.warn('[BG] Task huérfana detectada, reportando error');
        await jobsModule.reportOrphanTask(data.dm_current_task);
      } else {
        console.log('[BG] Task reciente encontrada, intentando continuar');
      }
    }

    state.isRunning = true;
    jobsModule.restoreProgressState(data.dm_last_progress_ts, data.dm_progress_stage);
    chrome.alarms.create(state.pollAlarmName, {
      periodInMinutes: CONFIG.pollIntervalMs / 60000,
    });
    jobsModule.processNextTask().catch((e) => {
      console.warn('[BG] Recovery processNextTask failed:', e?.message || e);
    });
  }
}

chrome.runtime.onInstalled.addListener(async () => {
  console.log('[BG] BeLeadAI instalado');
  await authModule.getOrCreateDeviceId();
  await storageModule.loadState();
  const installCfg = await authModule.loadSettings();
  if (installCfg.refresh_token) {
    authModule.ensureFreshAccessToken(installCfg, { force: true }).catch(() => {});
  }
  jobNotifierModule.bootstrapSilent().catch((e) => {
    console.warn('[BG] onInstalled notifier bootstrap failed:', e?.message || e);
  });
  jobsModule.flushPendingReports().catch((e) => {
    console.warn('[BG] onInstalled flushPendingReports failed:', e?.message || e);
  });

  ensureAutonomousHeartbeatAlarm();
  ensureWatchdogAlarm();

  await recoverFromPreviousState();
});

chrome.runtime.onStartup.addListener(async () => {
  console.log('[BG] BeLeadAI startup');
  await authModule.getOrCreateDeviceId();
  await storageModule.loadState();
  const startupCfg = await authModule.loadSettings();
  if (startupCfg.refresh_token) {
    authModule.ensureFreshAccessToken(startupCfg, { force: true }).catch(() => {});
  }
  jobNotifierModule.bootstrapSilent().catch((e) => {
    console.warn('[BG] onStartup notifier bootstrap failed:', e?.message || e);
  });
  jobsModule.flushPendingReports().catch((e) => {
    console.warn('[BG] onStartup flushPendingReports failed:', e?.message || e);
  });

  ensureAutonomousHeartbeatAlarm();
  ensureWatchdogAlarm();

  await recoverFromPreviousState();
});

ensureAutonomousHeartbeatAlarm();
ensureWatchdogAlarm();

chrome.runtime.onMessage.addListener((message, sender) => {
  if (sender?.id !== chrome.runtime.id) return;
  if (message?.type !== 'jobs_updated') return;
  jobNotifierModule.triggerSync('jobs_updated', { force: true }).catch((e) => {
    console.warn('[BG] jobs_updated notifier sync failed:', e?.message || e);
  });
});

console.log('[BG] Background script cargado');
