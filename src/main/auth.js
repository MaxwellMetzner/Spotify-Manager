const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { shell } = require('electron');

const AUTH_BASE = 'https://accounts.spotify.com';
const API_BASE = 'https://api.spotify.com/v1';
const TOKENS_FILE = path.resolve(process.cwd(), '.spotify-tokens.json');
const DEFAULT_REDIRECT_URI = 'http://127.0.0.1:8888/callback';
const SCOPES = [
  'playlist-read-private',
  'playlist-read-collaborative',
  'playlist-modify-private',
  'playlist-modify-public',
  'user-read-private',
];

const tokenState = {
  accessToken: null,
  refreshToken: null,
  expiresAt: 0,
};

loadTokens();

function parseEnvFile() {
  const envPath = path.resolve(process.cwd(), '.env');
  const result = {};
  if (!fs.existsSync(envPath)) return result;
  const lines = fs.readFileSync(envPath, 'utf-8').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || !trimmed.includes('=')) continue;
    const [rawKey, ...rawValue] = trimmed.split('=');
    result[rawKey.trim()] = rawValue.join('=').trim().replace(/^"|"$/g, '');
  }
  return result;
}

function getConfig() {
  const envFile = parseEnvFile();
  const clientId = process.env.SPOTIFY_CLIENT_ID || envFile.SPOTIFY_CLIENT_ID;
  const redirectUri = process.env.SPOTIFY_REDIRECT_URI || envFile.SPOTIFY_REDIRECT_URI || DEFAULT_REDIRECT_URI;
  if (!clientId) {
    throw new Error('Missing SPOTIFY_CLIENT_ID. Add it to .env or environment variables.');
  }
  return { clientId, redirectUri };
}

function loadTokens() {
  if (!fs.existsSync(TOKENS_FILE)) return;
  try {
    const parsed = JSON.parse(fs.readFileSync(TOKENS_FILE, 'utf-8'));
    tokenState.accessToken = parsed.accessToken || null;
    tokenState.refreshToken = parsed.refreshToken || null;
    tokenState.expiresAt = parsed.expiresAt || 0;
  } catch {
    tokenState.accessToken = null;
    tokenState.refreshToken = null;
    tokenState.expiresAt = 0;
  }
}

function saveTokens(payload) {
  if (payload.access_token) {
    tokenState.accessToken = payload.access_token;
  }
  if (payload.refresh_token) {
    tokenState.refreshToken = payload.refresh_token;
  }
  if (payload.expires_in) {
    tokenState.expiresAt = Date.now() + Math.max(0, payload.expires_in - 60) * 1000;
  }
  fs.writeFileSync(
    TOKENS_FILE,
    JSON.stringify(
      {
        accessToken: tokenState.accessToken,
        refreshToken: tokenState.refreshToken,
        expiresAt: tokenState.expiresAt,
      },
      null,
      2
    )
  );
}

function getAuthState() {
  return {
    authenticated: Boolean(tokenState.accessToken && tokenState.expiresAt > Date.now()),
    hasRefreshToken: Boolean(tokenState.refreshToken),
    expiresAt: tokenState.expiresAt,
  };
}

function randomUrlSafe(size = 32) {
  return crypto.randomBytes(size).toString('base64url');
}

function toCodeChallenge(verifier) {
  return crypto.createHash('sha256').update(verifier).digest('base64url');
}

function waitForOAuthCode(redirectUri, expectedState) {
  const parsed = new URL(redirectUri);
  const port = Number(parsed.port || 80);
  const pathname = parsed.pathname;

  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const incoming = new URL(req.url, `${parsed.protocol}//${req.headers.host}`);
      if (incoming.pathname !== pathname) {
        res.writeHead(404);
        res.end('Not found');
        return;
      }

      const code = incoming.searchParams.get('code');
      const state = incoming.searchParams.get('state');
      const error = incoming.searchParams.get('error');

      if (error) {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<h3>Spotify authorization canceled. You can close this window.</h3>');
        server.close();
        reject(new Error(`Spotify auth failed: ${error}`));
        return;
      }

      if (!code || state !== expectedState) {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<h3>Authorization failed (state mismatch). You can close this window.</h3>');
        server.close();
        reject(new Error('Authorization state mismatch or missing code.'));
        return;
      }

      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<h3>Spotify connected. You can close this window.</h3>');
      server.close();
      resolve(code);
    });

    server.on('error', (err) => reject(err));
    server.listen(port, parsed.hostname);
  });
}

async function exchangeCodeForTokens({ code, codeVerifier, redirectUri, clientId }) {
  const params = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    client_id: clientId,
    code_verifier: codeVerifier,
  });

  const response = await fetch(`${AUTH_BASE}/api/token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: params,
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Failed to exchange authorization code: ${response.status} ${text}`);
  }

  const json = await response.json();
  saveTokens(json);
}

async function refreshAccessToken() {
  if (!tokenState.refreshToken) {
    throw new Error('No refresh token available. Please sign in again.');
  }
  const { clientId } = getConfig();
  const params = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: tokenState.refreshToken,
    client_id: clientId,
  });

  const response = await fetch(`${AUTH_BASE}/api/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params,
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Failed to refresh token: ${response.status} ${text}`);
  }

  const json = await response.json();
  saveTokens(json);
}

async function beginSpotifyLogin() {
  const { clientId, redirectUri } = getConfig();
  const state = randomUrlSafe(16);
  const codeVerifier = randomUrlSafe(64);
  const codeChallenge = toCodeChallenge(codeVerifier);

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

  const authUrl = `${AUTH_BASE}/authorize?${params.toString()}`;
  const waitForCodePromise = waitForOAuthCode(redirectUri, state);
  await shell.openExternal(authUrl);
  const code = await waitForCodePromise;
  await exchangeCodeForTokens({ code, codeVerifier, redirectUri, clientId });
}

async function ensureAccessToken() {
  if (tokenState.accessToken && Date.now() < tokenState.expiresAt) {
    return tokenState.accessToken;
  }
  if (tokenState.refreshToken) {
    await refreshAccessToken();
    return tokenState.accessToken;
  }
  throw new Error('Not authenticated. Use Sign In With Spotify first.');
}

async function spotifyRequest(method, endpointPath, query = {}, body = undefined) {
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

  if (response.status === 401 && tokenState.refreshToken) {
    await refreshAccessToken();
    return spotifyRequest(method, endpointPath, query, body);
  }

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Spotify API ${response.status}: ${text}`);
  }

  if (response.status === 204) return null;
  return response.json();
}

async function loadCurrentUser() {
  return spotifyRequest('GET', '/me');
}

function logout() {
  tokenState.accessToken = null;
  tokenState.refreshToken = null;
  tokenState.expiresAt = 0;
  if (fs.existsSync(TOKENS_FILE)) {
    fs.unlinkSync(TOKENS_FILE);
  }
}

module.exports = {
  getAuthState,
  beginSpotifyLogin,
  ensureAccessToken,
  spotifyRequest,
  loadCurrentUser,
  logout,
};
