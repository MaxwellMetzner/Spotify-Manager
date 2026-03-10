const DEBUG_STORAGE_KEY = 'spotifyManager.debug';
const LOG_LIMIT = 400;
const logEntries = [];
const listeners = new Set();

function normalizeBoolean(value) {
  if (typeof value === 'boolean') return value;
  if (value === null || value === undefined) return null;

  const normalized = String(value).trim().toLowerCase();
  if (!normalized) return null;
  if (['1', 'true', 'on', 'yes'].includes(normalized)) return true;
  if (['0', 'false', 'off', 'no'].includes(normalized)) return false;
  return null;
}

function safeLocalStorageGet(key) {
  try {
    return globalThis?.localStorage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function safeLocalStorageSet(key, value) {
  try {
    globalThis?.localStorage?.setItem(key, value);
  } catch {
    // Ignore storage failures in private mode or non-browser tests.
  }
}

function safeLocalStorageRemove(key) {
  try {
    globalThis?.localStorage?.removeItem(key);
  } catch {
    // Ignore storage failures in private mode or non-browser tests.
  }
}

function notifyListeners(entry) {
  const snapshot = getDebugLogEntries();
  listeners.forEach((listener) => {
    try {
      listener(entry, snapshot);
    } catch {
      // Ignore listener failures so diagnostics never break app behavior.
    }
  });
}

function getDebugQueryValue() {
  try {
    const search = globalThis?.window?.location?.search || '';
    return new URLSearchParams(search).get('debug');
  } catch {
    return null;
  }
}

export function getDebugState() {
  const queryValue = normalizeBoolean(getDebugQueryValue());
  if (queryValue !== null) return queryValue;

  const globalValue = normalizeBoolean(globalThis?.SPOTIFY_MANAGER_DEBUG);
  if (globalValue !== null) return globalValue;

  const storageValue = normalizeBoolean(safeLocalStorageGet(DEBUG_STORAGE_KEY));
  if (storageValue !== null) return storageValue;

  return String(globalThis?.process?.env?.SPOTIFY_MANAGER_DEBUG || '') === '1';
}

export function setDebugState(enabled, { persist = true } = {}) {
  const normalized = Boolean(enabled);
  globalThis.SPOTIFY_MANAGER_DEBUG = normalized;
  if (persist) {
    safeLocalStorageSet(DEBUG_STORAGE_KEY, normalized ? '1' : '0');
  } else {
    safeLocalStorageRemove(DEBUG_STORAGE_KEY);
  }
  return normalized;
}

export function createLogger(scope) {
  return function log(event, payload) {
    const stamp = new Date().toISOString();
    const entry = {
      stamp,
      scope,
      event,
      payload: payload === undefined ? null : payload,
    };
    logEntries.push(entry);
    if (logEntries.length > LOG_LIMIT) {
      logEntries.splice(0, logEntries.length - LOG_LIMIT);
    }
    notifyListeners(entry);

    if (!getDebugState()) return;
    const prefix = `[SpotifyManager:${scope}][${stamp}] ${event}`;
    if (payload === undefined) {
      console.log(prefix);
      return;
    }

    let renderedPayload;
    if (typeof payload === 'string') {
      renderedPayload = payload;
    } else {
      try {
        renderedPayload = JSON.stringify(payload);
      } catch {
        renderedPayload = String(payload);
      }
    }

    console.log(`${prefix} ${renderedPayload}`);
  };
}

export function getDebugLogEntries() {
  return logEntries.slice();
}

export function clearDebugLogEntries() {
  logEntries.length = 0;
  notifyListeners(null);
}

export function subscribeDebugLogs(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function nowMs() {
  if (typeof globalThis?.performance?.now === 'function') {
    return globalThis.performance.now();
  }
  return Date.now();
}

export function maskValue(value, visible = 4) {
  const text = String(value || '');
  if (!text) return '';
  if (text.length <= visible * 2) return text;
  return `${text.slice(0, visible)}...${text.slice(-visible)}`;
}