/**
 * Browser-compatible Spotify authentication using Authorization Code + PKCE.
 */

import { createLogger, getDebugState, maskValue, nowMs } from './debug.js';

const AUTH_BASE = 'https://accounts.spotify.com';
export const API_BASE = 'https://api.spotify.com/v1';

const TOKEN_KEY = 'spotifyManager.tokens';
const SETUP_KEY = 'spotifyManager.setup';
const PKCE_SESSION_STATE_KEY = 'spotify_pkce_state';
const PKCE_SESSION_VERIFIER_KEY = 'spotify_pkce_verifier';
const PKCE_TRANSACTION_KEY = 'spotifyManager.pkceTransaction';
const API_REQUEST_TIMEOUT_MS = 15000;
const LOOPBACK_FALLBACK_ORIGIN = 'http://127.0.0.1:3000';

const SCOPES = [
  'playlist-read-private',
  'playlist-read-collaborative',
  'playlist-modify-private',
  'playlist-modify-public',
  'user-read-private',
];

function normalizeScopes(rawScope) {
  const values = Array.isArray(rawScope)
    ? rawScope
    : String(rawScope || '')
        .split(/\s+/)
        .map((scope) => scope.trim())
        .filter(Boolean);
  return [...new Set(values)].sort();
}

const dlog = createLogger('auth');

function currentLocationUrl() {
  try {
    return new URL(window.location.href);
  } catch {
    return null;
  }
}

function normalizeLoopbackHostname(hostname) {
  if (hostname === 'localhost' || hostname === '::1' || hostname === '[::1]') {
    return '127.0.0.1';
  }
  return hostname;
}

function describeTransaction(transaction) {
  if (!transaction) {
    return {
      present: false,
      state: null,
      codeVerifier: false,
      ageMs: null,
      redirectUri: null,
    };
  }
  return {
    present: true,
    state: maskValue(transaction.state),
    codeVerifier: Boolean(transaction.codeVerifier),
    ageMs: Number.isFinite(transaction.createdAt) ? Math.max(0, Math.round(Date.now() - transaction.createdAt)) : null,
    redirectUri: transaction.redirectUri || null,
  };
}

function buildStateMismatchMessage({ state, expectedState, transaction, redirectUri }) {
  const currentOrigin = currentLocationUrl()?.origin || 'unknown origin';
  const redirectOrigin = (() => {
    try {
      return new URL(redirectUri).origin;
    } catch {
      return null;
    }
  })();

  if (!transaction) {
    const hostHint = redirectOrigin
      ? ` Open ${redirectOrigin}/ and sign in again.`
      : ' Sign in again.';
    return `Authorization state mismatch. No saved PKCE transaction was available on ${currentOrigin}.${hostHint}`;
  }

  return `Authorization state mismatch. Expected ${maskValue(expectedState)} but received ${maskValue(state)}. Sign in again.`;
}

function ensureTrailingSlash(pathname) {
  return pathname.endsWith('/') ? pathname : `${pathname}/`;
}

function getAppBasePathname() {
  const current = currentLocationUrl();
  if (!current) return '/';

  const pathname = current.pathname || '/';
  const knownSuffixes = [
    /\/src\/renderer(?:\/.*)?$/i,
    /\/api\/auth\/spotify\/callback(?:\/.*)?$/i,
    /\/index\.html$/i,
  ];

  for (const suffix of knownSuffixes) {
    if (suffix.test(pathname)) {
      return ensureTrailingSlash(pathname.replace(suffix, '/'));
    }
  }

  if (pathname.endsWith('/')) {
    return pathname;
  }

  const lastSlash = pathname.lastIndexOf('/');
  return ensureTrailingSlash(lastSlash >= 0 ? pathname.slice(0, lastSlash + 1) : '/');
}

function getCurrentOriginForAppUrls() {
  const current = currentLocationUrl();
  if (!current) {
    return new URL(LOOPBACK_FALLBACK_ORIGIN);
  }

  const origin = new URL(current.origin);
  if (origin.protocol === 'http:') {
    origin.hostname = normalizeLoopbackHostname(origin.hostname);
  }
  return origin;
}

function buildAppUrl(relativePath = '') {
  const basePath = getAppBasePathname();
  const normalizedPath = String(relativePath || '').replace(/^\/+/, '');
  return new URL(`${basePath}${normalizedPath}`, getCurrentOriginForAppUrls());
}

function getDefaultRedirectUri() {
  return buildAppUrl('api/auth/spotify/callback').toString();
}

function isLegacyLoopbackRedirect(uri) {
  return /^https?:\/\/(127\.0\.0\.1|localhost):8888\/callback\/?$/i.test(String(uri || '').trim());
}

function isLoopbackHost(hostname) {
  return hostname === '127.0.0.1' || hostname === '::1' || hostname === '[::1]';
}

function resolveStoredRedirectUri(storedRedirectUri) {
  const recommended = getDefaultRedirectUri();
  const candidate = String(storedRedirectUri || '').trim();
  if (!candidate) return recommended;

  // Migrate older hard-coded setup defaults that pointed at port 8888.
  if (isLegacyLoopbackRedirect(candidate)) {
    return recommended;
  }

  // Spotify no longer accepts localhost redirect hosts; migrate to explicit IPv4 loopback.
  try {
    const parsed = new URL(candidate);
    const fallback = new URL(recommended);
    const usesLegacyCallbackPath = /^\/callback\/?$/i.test(parsed.pathname || '');
    if (usesLegacyCallbackPath) {
      parsed.pathname = fallback.pathname;
      parsed.protocol = 'http:';
      if (parsed.hostname === 'localhost') {
        parsed.hostname = '127.0.0.1';
      }
      if (!parsed.port) parsed.port = fallback.port;
      return parsed.toString();
    }
    if (parsed.hostname === 'localhost') {
      parsed.hostname = '127.0.0.1';
      parsed.protocol = 'http:';
      if (!parsed.port) parsed.port = fallback.port;
      return parsed.toString();
    }
  } catch {
    // Keep original candidate and let validation throw a clear message later.
  }

  return candidate;
}

export function getRecommendedRedirectUri() {
  return getDefaultRedirectUri();
}

export function getRecommendedWebsiteUrl() {
  return buildAppUrl('').toString();
}

export function ensureCanonicalLoopbackOrigin() {
  const current = currentLocationUrl();
  if (!current) return { redirected: false };

  const normalizedHost = normalizeLoopbackHostname(current.hostname);
  if (normalizedHost === current.hostname) {
    return { redirected: false };
  }

  current.hostname = normalizedHost;
  const targetUrl = current.toString();
  dlog('ensureCanonicalLoopbackOrigin:redirect', {
    from: window.location.href,
    to: targetUrl,
  });

  if (typeof window.location.replace === 'function') {
    window.location.replace(targetUrl);
  } else {
    window.location.href = targetUrl;
  }

  return { redirected: true, url: targetUrl };
}

function savePkceTransaction(transaction) {
  const payload = JSON.stringify(transaction);
  sessionStorage.setItem(PKCE_SESSION_STATE_KEY, transaction.state);
  sessionStorage.setItem(PKCE_SESSION_VERIFIER_KEY, transaction.codeVerifier);
  localStorage.setItem(PKCE_TRANSACTION_KEY, payload);
  dlog('savePkceTransaction', describeTransaction(transaction));
}

function loadPkceTransaction() {
  let backup = null;
  try {
    backup = JSON.parse(localStorage.getItem(PKCE_TRANSACTION_KEY) || 'null');
  } catch {
    backup = null;
  }

  const sessionState = sessionStorage.getItem(PKCE_SESSION_STATE_KEY);
  const sessionVerifier = sessionStorage.getItem(PKCE_SESSION_VERIFIER_KEY);

  if (sessionState && sessionVerifier) {
    const transaction = {
      state: sessionState,
      codeVerifier: sessionVerifier,
      redirectUri: backup?.redirectUri || null,
      createdAt: backup?.createdAt || Date.now(),
    };
    dlog('loadPkceTransaction:session', describeTransaction(transaction));
    return transaction;
  }

  if (backup?.state && backup?.codeVerifier) {
    dlog('loadPkceTransaction:localStorage', describeTransaction(backup));
    return backup;
  }

  dlog('loadPkceTransaction:none', {
    currentOrigin: currentLocationUrl()?.origin || null,
  });
  return null;
}

function clearPkceTransaction() {
  sessionStorage.removeItem(PKCE_SESSION_STATE_KEY);
  sessionStorage.removeItem(PKCE_SESSION_VERIFIER_KEY);
  localStorage.removeItem(PKCE_TRANSACTION_KEY);
  dlog('clearPkceTransaction');
}

function normalizeSetupInput({ clientId, redirectUri }) {
  const normalizedClientId = String(clientId || '').trim();
  const normalizedRedirect = String(redirectUri || getDefaultRedirectUri()).trim() || getDefaultRedirectUri();
  return {
    clientId: normalizedClientId,
    redirectUri: normalizedRedirect,
  };
}

function validateSetupInput({ clientId, redirectUri }) {
  if (!clientId) {
    throw new Error('SPOTIFY_CLIENT_ID is required.');
  }

  if (!/^[a-zA-Z0-9]{32}$/.test(clientId)) {
    throw new Error('Client ID format looks invalid. Spotify Client IDs are usually 32 letters/numbers.');
  }

  let parsed;
  try {
    parsed = new URL(redirectUri);
  } catch {
    throw new Error('Redirect URI must be a valid absolute URL (for example https://<user>.github.io/<repo>/api/auth/spotify/callback or http://127.0.0.1:3000/api/auth/spotify/callback).');
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Redirect URI must use http:// or https://.');
  }

  if (parsed.hash) {
    throw new Error('Redirect URI cannot include a hash fragment (#...).');
  }

  if (parsed.hostname === 'localhost') {
    throw new Error('Redirect URI cannot use localhost. Use http://127.0.0.1:<port>/api/auth/spotify/callback instead.');
  }

  if (parsed.protocol === 'http:' && !isLoopbackHost(parsed.hostname)) {
    throw new Error('HTTP redirect URIs are only allowed for loopback IP literals (127.0.0.1 or [::1]).');
  }

  return {
    clientId,
    redirectUri: parsed.toString(),
  };
}

export function testSetupConfig({ clientId, redirectUri }) {
  const normalized = normalizeSetupInput({ clientId, redirectUri });
  const validated = validateSetupInput(normalized);

  const authorizeParams = new URLSearchParams({
    response_type: 'code',
    client_id: validated.clientId,
    redirect_uri: validated.redirectUri,
    scope: SCOPES.join(' '),
    state: 'setup_test_state',
    code_challenge_method: 'S256',
    code_challenge: 'setup_test_challenge',
  });

  return {
    ok: true,
    clientIdMasked: `${validated.clientId.slice(0, 4)}...${validated.clientId.slice(-4)}`,
    redirectUri: validated.redirectUri,
    authorizeUrl: `${AUTH_BASE}/authorize?${authorizeParams.toString()}`,
  };
}

// --------------- Setup / Config ---------------

export function getSetupState() {
  let stored;
  try { stored = JSON.parse(localStorage.getItem(SETUP_KEY) || '{}'); } catch { stored = {}; }
  const clientId = stored.clientId || '';
  const redirectUri = resolveStoredRedirectUri(stored.redirectUri);
  return {
    hasClientId: Boolean(clientId),
    clientIdMasked: clientId ? `${clientId.slice(0, 4)}...${clientId.slice(-4)}` : '',
    redirectUri,
  };
}

export function saveSetup({ clientId, redirectUri }) {
  const normalized = normalizeSetupInput({ clientId, redirectUri });
  const validated = validateSetupInput(normalized);
  localStorage.setItem(SETUP_KEY, JSON.stringify(validated));
  return getSetupState();
}

function getConfig() {
  let stored;
  try { stored = JSON.parse(localStorage.getItem(SETUP_KEY) || '{}'); } catch { stored = {}; }
  const clientId = stored.clientId || '';
  const redirectUri = resolveStoredRedirectUri(stored.redirectUri);
  if (!clientId) throw new Error('Missing SPOTIFY_CLIENT_ID. Open setup wizard.');

  // Keep local storage in sync after automatic legacy redirect migration.
  if (stored.redirectUri !== redirectUri) {
    localStorage.setItem(SETUP_KEY, JSON.stringify({ clientId, redirectUri }));
  }

  return { clientId, redirectUri };
}

// --------------- Token Storage ---------------

function loadTokens() {
  try { return JSON.parse(localStorage.getItem(TOKEN_KEY) || '{}'); } catch { return {}; }
}

function saveTokens(payload) {
  const current = loadTokens();
  if (payload.access_token) current.accessToken = payload.access_token;
  if (payload.refresh_token) current.refreshToken = payload.refresh_token;
  const grantedScopes = normalizeScopes(payload.scope);
  if (grantedScopes.length) {
    current.scopes = grantedScopes;
  }
  if (payload.expires_in) {
    current.expiresAt = Date.now() + Math.max(0, payload.expires_in - 60) * 1000;
  }
  localStorage.setItem(TOKEN_KEY, JSON.stringify(current));
}

export function getRequestedScopes() {
  return [...SCOPES];
}

export function getGrantedScopes() {
  return normalizeScopes(loadTokens().scopes);
}

export function getMissingScopes(requiredScopes = SCOPES) {
  const granted = new Set(getGrantedScopes());
  return normalizeScopes(requiredScopes).filter((scope) => !granted.has(scope));
}

// --------------- Auth State ---------------

export function getAuthState() {
  const tokens = loadTokens();
  const grantedScopes = normalizeScopes(tokens.scopes);
  return {
    authenticated: Boolean(tokens.accessToken && tokens.expiresAt > Date.now()),
    hasRefreshToken: Boolean(tokens.refreshToken),
    expiresAt: tokens.expiresAt || 0,
    grantedScopes,
    missingScopes: SCOPES.filter((scope) => !grantedScopes.includes(scope)),
  };
}

export function logout() {
  localStorage.removeItem(TOKEN_KEY);
}

// --------------- PKCE Crypto ---------------

async function randomUrlSafe(size = 32) {
  const bytes = new Uint8Array(size);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');
}

async function toCodeChallenge(verifier) {
  const data = new TextEncoder().encode(verifier);
  const hash = await crypto.subtle.digest('SHA-256', data);
  return btoa(String.fromCharCode(...new Uint8Array(hash)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');
}

// --------------- Login Flow ---------------

export async function beginLogin() {
  const { clientId, redirectUri } = getConfig();
  const startedAt = nowMs();
  const state = await randomUrlSafe(16);
  const codeVerifier = await randomUrlSafe(64);
  const codeChallenge = await toCodeChallenge(codeVerifier);

  dlog('beginLogin:start', {
    currentOrigin: currentLocationUrl()?.origin || null,
    redirectUri,
    clientId: maskValue(clientId),
    debugEnabled: getDebugState(),
  });

  savePkceTransaction({
    state,
    codeVerifier,
    redirectUri,
    createdAt: Date.now(),
  });

  const params = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: SCOPES.join(' '),
    state,
    code_challenge_method: 'S256',
    code_challenge: codeChallenge,
    show_dialog: 'false',
  });

  dlog('beginLogin:navigate', {
    authorizationOrigin: AUTH_BASE,
    redirectUri,
    transactionAgeMs: Math.round(nowMs() - startedAt),
    state: maskValue(state),
  });
  window.location.href = `${AUTH_BASE}/authorize?${params.toString()}`;
}

/**
 * Check the current URL for an OAuth callback (code + state params).
 * Returns true if tokens were successfully exchanged.
 */
export async function handleAuthCallback() {
  const startedAt = nowMs();
  const params = new URLSearchParams(window.location.search);
  const code = params.get('code');
  const state = params.get('state');
  const error = params.get('error');

  if (!code && !error) return false;

  dlog('handleAuthCallback:start', {
    currentHref: window.location.href,
    hasCode: Boolean(code),
    state: maskValue(state),
    error: error || null,
  });

  // Clean URL immediately
  window.history.replaceState({}, document.title, window.location.pathname);

  if (error) throw new Error(`Spotify authorization failed: ${error}`);

  const transaction = loadPkceTransaction();
  const expectedState = transaction?.state || null;
  const codeVerifier = transaction?.codeVerifier || null;

  dlog('handleAuthCallback:transaction', describeTransaction(transaction));

  let redirectUri = getDefaultRedirectUri();
  try {
    redirectUri = getConfig().redirectUri;
  } catch {
    // Setup validation can fail before the app is configured; keep the fallback for diagnostics.
  }

  if (state !== expectedState) {
    const message = buildStateMismatchMessage({ state, expectedState, transaction, redirectUri });
    dlog('handleAuthCallback:stateMismatch', {
      actualState: maskValue(state),
      expectedState: maskValue(expectedState),
      redirectUri,
      transaction: describeTransaction(transaction),
    });
    throw new Error(message);
  }
  if (!codeVerifier) throw new Error('Authorization code verifier missing. Sign in again.');

  const { clientId } = getConfig();

  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    client_id: clientId,
    code_verifier: codeVerifier,
  });

  const response = await fetch(`${AUTH_BASE}/api/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });

  if (!response.ok) {
    const text = await response.text();
    dlog('handleAuthCallback:exchangeFailed', {
      status: response.status,
      body: text,
      durationMs: Math.round(nowMs() - startedAt),
    });
    throw new Error(`Token exchange failed: ${response.status} ${text}`);
  }

  saveTokens(await response.json());
  clearPkceTransaction();
  dlog('handleAuthCallback:done', {
    redirectUri,
    durationMs: Math.round(nowMs() - startedAt),
  });
  return true;
}

// --------------- Token Refresh ---------------

async function refreshAccessToken() {
  const tokens = loadTokens();
  if (!tokens.refreshToken) throw new Error('No refresh token. Sign in again.');
  const { clientId } = getConfig();
  const startedAt = nowMs();

  dlog('refreshAccessToken:start', {
    hasAccessToken: Boolean(tokens.accessToken),
    hasRefreshToken: Boolean(tokens.refreshToken),
    expiresAt: tokens.expiresAt || 0,
    clientId: maskValue(clientId),
  });

  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: tokens.refreshToken,
    client_id: clientId,
  });

  const response = await fetch(`${AUTH_BASE}/api/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });

  if (!response.ok) {
    const text = await response.text();
    dlog('refreshAccessToken:failed', {
      status: response.status,
      body: text,
      durationMs: Math.round(nowMs() - startedAt),
    });
    throw new Error(`Token refresh failed: ${response.status} ${text}`);
  }

  saveTokens(await response.json());
  dlog('refreshAccessToken:done', {
    durationMs: Math.round(nowMs() - startedAt),
  });
}

// --------------- Session Persistence ---------------

/**
 * Attempt to restore a valid session on startup.
 * Returns true if the user is now authenticated (token still valid or refreshed).
 */
export async function tryAutoRefresh() {
  const tokens = loadTokens();
  dlog('tryAutoRefresh:start', {
    hasAccessToken: Boolean(tokens.accessToken),
    hasRefreshToken: Boolean(tokens.refreshToken),
    expiresAt: tokens.expiresAt || 0,
  });
  if (tokens.accessToken && tokens.expiresAt > Date.now()) return true;
  if (!tokens.refreshToken) return false;
  try {
    await refreshAccessToken();
    dlog('tryAutoRefresh:done', { refreshed: true });
    return true;
  } catch (error) {
    dlog('tryAutoRefresh:failed', { message: String(error?.message || error) });
    return false;
  }
}

// --------------- Authenticated Requests ---------------

async function ensureAccessToken() {
  const tokens = loadTokens();
  if (tokens.accessToken && Date.now() < tokens.expiresAt) return tokens.accessToken;
  if (tokens.refreshToken) {
    dlog('ensureAccessToken:refreshNeeded', {
      expiresAt: tokens.expiresAt || 0,
    });
    await refreshAccessToken();
    return loadTokens().accessToken;
  }
  throw new Error('Not authenticated. Sign in first.');
}

async function fetchWithTimeout(url, options = {}, timeoutMs = API_REQUEST_TIMEOUT_MS) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = nowMs();

  try {
    dlog('fetchWithTimeout:start', {
      method: options?.method || 'GET',
      url: url instanceof URL ? url.toString() : String(url),
      timeoutMs,
    });
    return await fetch(url, {
      ...options,
      signal: controller.signal,
    });
  } catch (error) {
    if (error?.name === 'AbortError') {
      const path = url instanceof URL ? url.pathname : String(url);
      dlog('fetchWithTimeout:timeout', {
        path,
        timeoutMs,
      });
      throw new Error(`Spotify API request timed out after ${Math.round(timeoutMs / 1000)}s: ${path}`);
    }
    dlog('fetchWithTimeout:error', {
      method: options?.method || 'GET',
      url: url instanceof URL ? url.toString() : String(url),
      durationMs: Math.round(nowMs() - startedAt),
      message: String(error?.message || error),
    });
    throw error;
  } finally {
    dlog('fetchWithTimeout:done', {
      method: options?.method || 'GET',
      url: url instanceof URL ? url.toString() : String(url),
      durationMs: Math.round(nowMs() - startedAt),
    });
    clearTimeout(timeoutId);
  }
}

export async function spotifyRequest(method, endpointPath, query = {}, body = undefined) {
  const token = await ensureAccessToken();
  const url = new URL(endpointPath.startsWith('http') ? endpointPath : `${API_BASE}${endpointPath}`);
  Object.entries(query || {}).forEach(([key, value]) => {
    if (value !== undefined && value !== null && `${value}`.length > 0) {
      url.searchParams.set(key, String(value));
    }
  });

  const startedAt = nowMs();
  dlog('spotifyRequest:start', {
    method,
    path: url.pathname,
    query: Object.fromEntries(url.searchParams.entries()),
    hasBody: body !== undefined,
    tokenSuffix: maskValue(token, 6),
  });

  const response = await fetchWithTimeout(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (response.status === 401) {
    const tokens = loadTokens();
    if (tokens.refreshToken) {
      dlog('spotifyRequest:retryAfter401', {
        method,
        path: url.pathname,
      });
      await refreshAccessToken();
      return spotifyRequest(method, endpointPath, query, body);
    }
  }

  if (!response.ok) {
    const text = await response.text();
    dlog('spotifyRequest:failed', {
      method,
      path: url.pathname,
      status: response.status,
      durationMs: Math.round(nowMs() - startedAt),
      body: text,
    });
    throw new Error(`Spotify API ${response.status} ${method} ${url.pathname}: ${text}`);
  }

  if (response.status === 204) return null;
  const result = await response.json();
  dlog('spotifyRequest:done', {
    method,
    path: url.pathname,
    status: response.status,
    durationMs: Math.round(nowMs() - startedAt),
  });
  return result;
}

export async function loadCurrentUser() {
  return spotifyRequest('GET', '/me');
}
