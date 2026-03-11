import test from 'node:test';
import assert from 'node:assert/strict';

/**
 * Unit tests for src/auth.js — browser PKCE auth module.
 *
 * Since auth.js is an ES module that relies on browser globals (localStorage,
 * sessionStorage, crypto.subtle, window.location, fetch), we mock those and
 * dynamically import the module under test so each test starts fresh.
 */

// --------------- Browser Global Mocks ---------------

function createStorageMock() {
  const map = new Map();
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: (key) => map.delete(key),
    clear: () => map.clear(),
  };
}

function createLocation(url) {
  const parsed = new URL(url);
  return {
    origin: parsed.origin,
    pathname: parsed.pathname,
    href: parsed.toString(),
    search: parsed.search,
    hash: parsed.hash,
    hostname: parsed.hostname,
    port: parsed.port,
    replace(nextUrl) {
      Object.assign(this, createLocation(nextUrl));
    },
  };
}

function installBrowserGlobals(overrides = {}) {
  globalThis.localStorage = createStorageMock();
  globalThis.sessionStorage = createStorageMock();
  const windowOverrides = overrides.window || {};
  const location = overrides.window?.location
    ? createLocation(overrides.window.location.href || `${overrides.window.location.origin || 'http://localhost:3000'}${overrides.window.location.pathname || '/'}${overrides.window.location.search || ''}${overrides.window.location.hash || ''}`)
    : createLocation('http://localhost:3000/');
  const { location: _ignoredLocation, ...restWindowOverrides } = windowOverrides;
  globalThis.window = {
    location,
    history: { replaceState() {} },
    ...restWindowOverrides,
  };
  Object.defineProperty(globalThis, 'crypto', {
    value: {
      getRandomValues(arr) {
        for (let i = 0; i < arr.length; i++) arr[i] = Math.floor(Math.random() * 256);
        return arr;
      },
      subtle: {
        async digest(_algo, data) {
          return new Uint8Array(data).buffer;
        },
      },
    },
    writable: true,
    configurable: true,
  });
  globalThis.btoa = (str) => Buffer.from(str, 'binary').toString('base64');
  globalThis.atob = (str) => Buffer.from(str, 'base64').toString('binary');
  globalThis.document = { title: 'Test' };
}

function cleanupBrowserGlobals() {
  delete globalThis.localStorage;
  delete globalThis.sessionStorage;
  delete globalThis.window;
  delete globalThis.crypto;
  delete globalThis.btoa;
  delete globalThis.atob;
  delete globalThis.document;
  delete globalThis.fetch;
}

async function importAuth() {
  // Use a cache-busting query to get a fresh module each test
  const url = new URL('../src/auth.js', import.meta.url);
  url.searchParams.set('_t', `${Date.now()}-${Math.random()}`);
  return import(url.href);
}

// --------------- Tests ---------------

test('getSetupState returns empty state when nothing stored', async () => {
  await installBrowserGlobals();
  try {
    const auth = await importAuth();
    const state = auth.getSetupState();
    assert.equal(state.hasClientId, false);
    assert.equal(state.clientIdMasked, '');
    assert.equal(typeof state.redirectUri, 'string');
  } finally {
    cleanupBrowserGlobals();
  }
});

test('saveSetup stores and retrieves client ID', async () => {
  await installBrowserGlobals();
  try {
    const auth = await importAuth();
    const result = auth.saveSetup({
      clientId: 'abcd1234efgh5678ijkl9012mnop3456',
      redirectUri: 'http://127.0.0.1:3000/',
    });
    assert.equal(result.hasClientId, true);
    assert.equal(result.clientIdMasked, 'abcd...3456');

    const state = auth.getSetupState();
    assert.equal(state.hasClientId, true);
  } finally {
    cleanupBrowserGlobals();
  }
});

test('getRecommendedRedirectUri returns callback route on current origin', async () => {
  await installBrowserGlobals({
    window: {
      location: { origin: 'http://127.0.0.1:8888', pathname: '/index.html', href: '', search: '' },
      history: { replaceState() {} },
    },
  });
  try {
    const auth = await importAuth();
    assert.equal(auth.getRecommendedRedirectUri(), 'http://127.0.0.1:8888/api/auth/spotify/callback');
  } finally {
    cleanupBrowserGlobals();
  }
});

test('testSetupConfig rejects malformed client ID', async () => {
  await installBrowserGlobals();
  try {
    const auth = await importAuth();
    assert.throws(
      () => auth.testSetupConfig({ clientId: 'short', redirectUri: 'http://127.0.0.1:8888/api/auth/spotify/callback' }),
      /format looks invalid/i
    );
  } finally {
    cleanupBrowserGlobals();
  }
});

test('testSetupConfig rejects invalid redirect URI', async () => {
  await installBrowserGlobals();
  try {
    const auth = await importAuth();
    assert.throws(
      () => auth.testSetupConfig({ clientId: '1234567890abcdef1234567890abcdef', redirectUri: 'not-a-url' }),
      /valid absolute URL/i
    );
  } finally {
    cleanupBrowserGlobals();
  }
});

test('testSetupConfig rejects localhost redirect host', async () => {
  await installBrowserGlobals({
    window: {
      location: { origin: 'http://localhost:3000', pathname: '/', href: '', search: '' },
      history: { replaceState() {} },
    },
  });
  try {
    const auth = await importAuth();
    assert.throws(
      () => auth.testSetupConfig({
        clientId: '1234567890abcdef1234567890abcdef',
        redirectUri: 'http://localhost:3000/api/auth/spotify/callback',
      }),
      /cannot use localhost/i
    );
  } finally {
    cleanupBrowserGlobals();
  }
});

test('testSetupConfig returns authorize URL for valid setup input', async () => {
  await installBrowserGlobals();
  try {
    const auth = await importAuth();
    const result = auth.testSetupConfig({
      clientId: '1234567890abcdef1234567890abcdef',
      redirectUri: 'http://127.0.0.1:3000/api/auth/spotify/callback',
    });

    assert.equal(result.ok, true);
    assert.equal(result.clientIdMasked, '1234...cdef');
    assert.ok(result.authorizeUrl.includes('https://accounts.spotify.com/authorize?'));
    assert.ok(result.authorizeUrl.includes('redirect_uri=http%3A%2F%2F127.0.0.1%3A3000%2Fapi%2Fauth%2Fspotify%2Fcallback'));
  } finally {
    cleanupBrowserGlobals();
  }
});

test('getSetupState migrates legacy 8888 callback to current loopback callback', async () => {
  await installBrowserGlobals({
    window: {
      location: { origin: 'http://localhost:3000', pathname: '/', href: '', search: '' },
      history: { replaceState() {} },
    },
  });
  try {
    const auth = await importAuth();
    localStorage.setItem('spotifyManager.setup', JSON.stringify({
      clientId: '1234567890abcdef1234567890abcdef',
      redirectUri: 'http://127.0.0.1:8888/callback',
    }));

    const state = auth.getSetupState();
    assert.equal(state.redirectUri, 'http://127.0.0.1:3000/api/auth/spotify/callback');
  } finally {
    cleanupBrowserGlobals();
  }
});

test('getSetupState migrates legacy /callback path to callback route under api/auth', async () => {
  await installBrowserGlobals();
  try {
    const auth = await importAuth();
    localStorage.setItem('spotifyManager.setup', JSON.stringify({
      clientId: '1234567890abcdef1234567890abcdef',
      redirectUri: 'http://127.0.0.1:3000/callback',
    }));

    const state = auth.getSetupState();
    assert.equal(state.redirectUri, 'http://127.0.0.1:3000/api/auth/spotify/callback');
  } finally {
    cleanupBrowserGlobals();
  }
});

test('saveSetup rejects empty client ID', async () => {
  await installBrowserGlobals();
  try {
    const auth = await importAuth();
    assert.throws(() => auth.saveSetup({ clientId: '', redirectUri: '' }), /required/i);
  } finally {
    cleanupBrowserGlobals();
  }
});

test('getAuthState returns unauthenticated when no tokens', async () => {
  await installBrowserGlobals();
  try {
    const auth = await importAuth();
    const state = auth.getAuthState();
    assert.equal(state.authenticated, false);
    assert.equal(state.hasRefreshToken, false);
  } finally {
    cleanupBrowserGlobals();
  }
});

test('getAuthState reflects stored token', async () => {
  await installBrowserGlobals();
  try {
    const auth = await importAuth();
    // Manually seed token storage
    localStorage.setItem('spotifyManager.tokens', JSON.stringify({
      accessToken: 'tok_test',
      refreshToken: 'ref_test',
      expiresAt: Date.now() + 3600 * 1000,
    }));
    const state = auth.getAuthState();
    assert.equal(state.authenticated, true);
    assert.equal(state.hasRefreshToken, true);
  } finally {
    cleanupBrowserGlobals();
  }
});

test('logout clears tokens', async () => {
  await installBrowserGlobals();
  try {
    const auth = await importAuth();
    localStorage.setItem('spotifyManager.tokens', JSON.stringify({
      accessToken: 'tok_test',
      refreshToken: 'ref_test',
      expiresAt: Date.now() + 3600 * 1000,
    }));
    auth.logout();
    const state = auth.getAuthState();
    assert.equal(state.authenticated, false);
    assert.equal(state.hasRefreshToken, false);
  } finally {
    cleanupBrowserGlobals();
  }
});

test('spotifyRequest makes authenticated fetch with bearer token', async () => {
  await installBrowserGlobals();
  try {
    const auth = await importAuth();

    // Seed valid setup and tokens
    localStorage.setItem('spotifyManager.setup', JSON.stringify({
      clientId: 'test_client_id_1234',
      redirectUri: 'http://127.0.0.1:3000/api/auth/spotify/callback',
    }));
    localStorage.setItem('spotifyManager.tokens', JSON.stringify({
      accessToken: 'my_access_token',
      refreshToken: 'my_refresh_token',
      expiresAt: Date.now() + 3600 * 1000,
    }));

    let capturedUrl, capturedOpts;
    globalThis.fetch = async (url, opts) => {
      capturedUrl = url.toString();
      capturedOpts = opts;
      return { ok: true, status: 200, json: async () => ({ items: [] }) };
    };

    const result = await auth.spotifyRequest('GET', '/me/playlists', { limit: 50 });
    assert.deepEqual(result, { items: [] });
    assert.ok(capturedUrl.includes('/me/playlists'));
    assert.ok(capturedUrl.includes('limit=50'));
    assert.equal(capturedOpts.method, 'GET');
    assert.equal(capturedOpts.headers.Authorization, 'Bearer my_access_token');
  } finally {
    cleanupBrowserGlobals();
  }
});

test('handleAuthCallback returns false when no code in URL', async () => {
  await installBrowserGlobals();
  globalThis.window.location.search = '';
  try {
    const auth = await importAuth();
    const result = await auth.handleAuthCallback();
    assert.equal(result, false);
  } finally {
    cleanupBrowserGlobals();
  }
});

test('handleAuthCallback throws on state mismatch', async () => {
  await installBrowserGlobals();
  globalThis.window.location.search = '?code=abc&state=wrong';
  globalThis.window.location.href = 'http://localhost:3000/?code=abc&state=wrong';
  try {
    const auth = await importAuth();
    sessionStorage.setItem('spotify_pkce_state', 'expected_state');
    sessionStorage.setItem('spotify_pkce_verifier', 'verifier_123');

    await assert.rejects(() => auth.handleAuthCallback(), /state mismatch/i);
  } finally {
    cleanupBrowserGlobals();
  }
});

test('handleAuthCallback exchanges code for tokens on valid callback', async () => {
  await installBrowserGlobals();
  globalThis.window.location.search = '?code=valid_code&state=correct_state';
  globalThis.window.location.href = 'http://localhost:3000/?code=valid_code&state=correct_state';
  try {
    const auth = await importAuth();

    localStorage.setItem('spotifyManager.setup', JSON.stringify({
      clientId: 'test_client_id',
      redirectUri: 'http://127.0.0.1:3000/api/auth/spotify/callback',
    }));
    sessionStorage.setItem('spotify_pkce_state', 'correct_state');
    sessionStorage.setItem('spotify_pkce_verifier', 'verifier_abc');

    globalThis.fetch = async (_url, _opts) => ({
      ok: true,
      status: 200,
      json: async () => ({
        access_token: 'new_access',
        refresh_token: 'new_refresh',
        expires_in: 3600,
      }),
    });

    const result = await auth.handleAuthCallback();
    assert.equal(result, true);

    const state = auth.getAuthState();
    assert.equal(state.authenticated, true);
    assert.equal(state.hasRefreshToken, true);
  } finally {
    cleanupBrowserGlobals();
  }
});

test('beginLogin stores PKCE fallback transaction in local storage', async () => {
  await installBrowserGlobals();
  try {
    const auth = await importAuth();
    localStorage.setItem('spotifyManager.setup', JSON.stringify({
      clientId: '1234567890abcdef1234567890abcdef',
      redirectUri: 'http://127.0.0.1:3000/api/auth/spotify/callback',
    }));

    await auth.beginLogin();

    const transaction = JSON.parse(localStorage.getItem('spotifyManager.pkceTransaction'));
    assert.equal(typeof transaction.state, 'string');
    assert.equal(typeof transaction.codeVerifier, 'string');
    assert.equal(transaction.redirectUri, 'http://127.0.0.1:3000/api/auth/spotify/callback');
    assert.ok(window.location.href.includes('https://accounts.spotify.com/authorize?'));
  } finally {
    cleanupBrowserGlobals();
  }
});

test('beginLogin builds authorize URL with PKCE S256 parameters', async () => {
  await installBrowserGlobals();
  try {
    const auth = await importAuth();
    localStorage.setItem('spotifyManager.setup', JSON.stringify({
      clientId: '1234567890abcdef1234567890abcdef',
      redirectUri: 'http://127.0.0.1:3000/api/auth/spotify/callback',
    }));

    await auth.beginLogin();

    const url = new URL(window.location.href);
    assert.equal(url.origin, 'https://accounts.spotify.com');
    assert.equal(url.pathname, '/authorize');
    assert.equal(url.searchParams.get('client_id'), '1234567890abcdef1234567890abcdef');
    assert.equal(url.searchParams.get('response_type'), 'code');
    assert.equal(url.searchParams.get('redirect_uri'), 'http://127.0.0.1:3000/api/auth/spotify/callback');
    assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
    assert.ok((url.searchParams.get('scope') || '').includes('playlist-read-private'));
    assert.ok((url.searchParams.get('state') || '').length >= 20);
    assert.ok((url.searchParams.get('code_challenge') || '').length >= 43);

    const transaction = JSON.parse(localStorage.getItem('spotifyManager.pkceTransaction'));
    assert.ok(transaction.codeVerifier.length >= 43);
    assert.ok(transaction.codeVerifier.length <= 128);
  } finally {
    cleanupBrowserGlobals();
  }
});

test('handleAuthCallback uses local storage fallback when session storage was cleared', async () => {
  await installBrowserGlobals();
  globalThis.window.location.search = '?code=valid_code&state=correct_state';
  globalThis.window.location.href = 'http://localhost:3000/?code=valid_code&state=correct_state';
  try {
    const auth = await importAuth();

    localStorage.setItem('spotifyManager.setup', JSON.stringify({
      clientId: 'test_client_id',
      redirectUri: 'http://127.0.0.1:3000/api/auth/spotify/callback',
    }));
    localStorage.setItem('spotifyManager.pkceTransaction', JSON.stringify({
      state: 'correct_state',
      codeVerifier: 'verifier_from_backup',
      redirectUri: 'http://127.0.0.1:3000/api/auth/spotify/callback',
      createdAt: Date.now(),
    }));

    globalThis.fetch = async (_url, _opts) => ({
      ok: true,
      status: 200,
      json: async () => ({
        access_token: 'new_access',
        refresh_token: 'new_refresh',
        expires_in: 3600,
      }),
    });

    const result = await auth.handleAuthCallback();
    assert.equal(result, true);
    assert.equal(localStorage.getItem('spotifyManager.pkceTransaction'), null);
  } finally {
    cleanupBrowserGlobals();
  }
});

test('handleAuthCallback exchanges code with client id, redirect uri, and code verifier', async () => {
  await installBrowserGlobals();
  globalThis.window.location.search = '?code=valid_code&state=correct_state';
  globalThis.window.location.href = 'http://127.0.0.1:3000/src/renderer/?code=valid_code&state=correct_state';
  try {
    const auth = await importAuth();

    localStorage.setItem('spotifyManager.setup', JSON.stringify({
      clientId: '1234567890abcdef1234567890abcdef',
      redirectUri: 'http://127.0.0.1:3000/api/auth/spotify/callback',
    }));
    sessionStorage.setItem('spotify_pkce_state', 'correct_state');
    sessionStorage.setItem('spotify_pkce_verifier', 'verifier_abc');

    let tokenBody = null;
    globalThis.fetch = async (_url, opts) => {
      tokenBody = opts.body;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          access_token: 'new_access',
          refresh_token: 'new_refresh',
          expires_in: 3600,
        }),
      };
    };

    await auth.handleAuthCallback();

    const params = new URLSearchParams(tokenBody);
    assert.equal(params.get('grant_type'), 'authorization_code');
    assert.equal(params.get('client_id'), '1234567890abcdef1234567890abcdef');
    assert.equal(params.get('code'), 'valid_code');
    assert.equal(params.get('redirect_uri'), 'http://127.0.0.1:3000/api/auth/spotify/callback');
    assert.equal(params.get('code_verifier'), 'verifier_abc');
  } finally {
    cleanupBrowserGlobals();
  }
});

test('ensureCanonicalLoopbackOrigin redirects localhost to 127.0.0.1', async () => {
  await installBrowserGlobals({
    window: {
      location: {
        href: 'http://localhost:3000/?debug=1#table',
      },
      history: { replaceState() {} },
    },
  });
  try {
    const auth = await importAuth();
    const result = auth.ensureCanonicalLoopbackOrigin();

    assert.equal(result.redirected, true);
    assert.equal(window.location.href, 'http://127.0.0.1:3000/?debug=1#table');
  } finally {
    cleanupBrowserGlobals();
  }
});

test('tryAutoRefresh sends refresh_token grant with client id', async () => {
  await installBrowserGlobals();
  try {
    const auth = await importAuth();
    localStorage.setItem('spotifyManager.setup', JSON.stringify({
      clientId: '1234567890abcdef1234567890abcdef',
      redirectUri: 'http://127.0.0.1:3000/api/auth/spotify/callback',
    }));
    localStorage.setItem('spotifyManager.tokens', JSON.stringify({
      accessToken: 'expired_token',
      refreshToken: 'refresh_123',
      expiresAt: Date.now() - 1000,
    }));

    let refreshBody = null;
    globalThis.fetch = async (_url, opts) => {
      refreshBody = opts.body;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          access_token: 'fresh_access',
          expires_in: 3600,
        }),
      };
    };

    const refreshed = await auth.tryAutoRefresh();
    assert.equal(refreshed, true);

    const params = new URLSearchParams(refreshBody);
    assert.equal(params.get('grant_type'), 'refresh_token');
    assert.equal(params.get('client_id'), '1234567890abcdef1234567890abcdef');
    assert.equal(params.get('refresh_token'), 'refresh_123');
  } finally {
    cleanupBrowserGlobals();
  }
});

test('handleAuthCallback explains missing PKCE transaction', async () => {
  await installBrowserGlobals({
    window: {
      location: {
        href: 'http://127.0.0.1:3000/?code=abc&state=state_1234',
      },
      history: { replaceState() {} },
    },
  });
  try {
    const auth = await importAuth();
    localStorage.setItem('spotifyManager.setup', JSON.stringify({
      clientId: '1234567890abcdef1234567890abcdef',
      redirectUri: 'http://127.0.0.1:3000/api/auth/spotify/callback',
    }));

    await assert.rejects(
      () => auth.handleAuthCallback(),
      /No saved PKCE transaction was available/i
    );
  } finally {
    cleanupBrowserGlobals();
  }
});
