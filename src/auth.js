/**
 * Browser-compatible Spotify authentication using Authorization Code + PKCE.
 * Replaces the Electron main-process auth module.
 */

const AUTH_BASE = 'https://accounts.spotify.com';
export const API_BASE = 'https://api.spotify.com/v1';

const TOKEN_KEY = 'spotifyManager.tokens';
const SETUP_KEY = 'spotifyManager.setup';

const SCOPES = [
  'playlist-read-private',
  'playlist-read-collaborative',
  'playlist-modify-private',
  'playlist-modify-public',
  'user-read-private',
];

function getDefaultRedirectUri() {
  const loc = window.location;
  let port = loc.port;
  if (!port) {
    try {
      port = new URL(loc.origin).port;
    } catch {
      port = '';
    }
  }
  if (!port) port = '3000';
  // Spotify disallows localhost in redirect URIs; use explicit loopback literal.
  return `http://127.0.0.1:${port}/callback`;
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
    if (parsed.hostname === 'localhost') {
      const fallback = new URL(recommended);
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
    throw new Error('Redirect URI must be a valid absolute URL (for example http://127.0.0.1:8888/callback).');
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Redirect URI must use http:// or https://.');
  }

  if (parsed.hash) {
    throw new Error('Redirect URI cannot include a hash fragment (#...).');
  }

  if (parsed.hostname === 'localhost') {
    throw new Error('Redirect URI cannot use localhost. Use http://127.0.0.1:<port>/callback instead.');
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
  if (payload.expires_in) {
    current.expiresAt = Date.now() + Math.max(0, payload.expires_in - 60) * 1000;
  }
  localStorage.setItem(TOKEN_KEY, JSON.stringify(current));
}

// --------------- Auth State ---------------

export function getAuthState() {
  const tokens = loadTokens();
  return {
    authenticated: Boolean(tokens.accessToken && tokens.expiresAt > Date.now()),
    hasRefreshToken: Boolean(tokens.refreshToken),
    expiresAt: tokens.expiresAt || 0,
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
  const state = await randomUrlSafe(16);
  const codeVerifier = await randomUrlSafe(64);
  const codeChallenge = await toCodeChallenge(codeVerifier);

  sessionStorage.setItem('spotify_pkce_verifier', codeVerifier);
  sessionStorage.setItem('spotify_pkce_state', state);

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

  window.location.href = `${AUTH_BASE}/authorize?${params.toString()}`;
}

/**
 * Check the current URL for an OAuth callback (code + state params).
 * Returns true if tokens were successfully exchanged.
 */
export async function handleAuthCallback() {
  const params = new URLSearchParams(window.location.search);
  const code = params.get('code');
  const state = params.get('state');
  const error = params.get('error');

  if (!code && !error) return false;

  // Clean URL immediately
  window.history.replaceState({}, document.title, window.location.pathname);

  if (error) throw new Error(`Spotify authorization failed: ${error}`);

  const expectedState = sessionStorage.getItem('spotify_pkce_state');
  const codeVerifier = sessionStorage.getItem('spotify_pkce_verifier');
  sessionStorage.removeItem('spotify_pkce_state');
  sessionStorage.removeItem('spotify_pkce_verifier');

  if (state !== expectedState) throw new Error('Authorization state mismatch.');

  const { clientId, redirectUri } = getConfig();

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
    throw new Error(`Token exchange failed: ${response.status} ${text}`);
  }

  saveTokens(await response.json());
  return true;
}

// --------------- Token Refresh ---------------

async function refreshAccessToken() {
  const tokens = loadTokens();
  if (!tokens.refreshToken) throw new Error('No refresh token. Sign in again.');
  const { clientId } = getConfig();

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
    throw new Error(`Token refresh failed: ${response.status} ${text}`);
  }

  saveTokens(await response.json());
}

// --------------- Authenticated Requests ---------------

async function ensureAccessToken() {
  const tokens = loadTokens();
  if (tokens.accessToken && Date.now() < tokens.expiresAt) return tokens.accessToken;
  if (tokens.refreshToken) {
    await refreshAccessToken();
    return loadTokens().accessToken;
  }
  throw new Error('Not authenticated. Sign in first.');
}

export async function spotifyRequest(method, endpointPath, query = {}, body = undefined) {
  const token = await ensureAccessToken();
  const url = new URL(endpointPath.startsWith('http') ? endpointPath : `${API_BASE}${endpointPath}`);
  Object.entries(query || {}).forEach(([key, value]) => {
    if (value !== undefined && value !== null && `${value}`.length > 0) {
      url.searchParams.set(key, String(value));
    }
  });

  const response = await fetch(url, {
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
      await refreshAccessToken();
      return spotifyRequest(method, endpointPath, query, body);
    }
  }

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Spotify API ${response.status} ${method} ${url.pathname}: ${text}`);
  }

  if (response.status === 204) return null;
  return response.json();
}

export async function loadCurrentUser() {
  return spotifyRequest('GET', '/me');
}
