import test from 'node:test';
import assert from 'node:assert/strict';

/**
 * Unit tests for src/spotifyApi.js — browser Spotify API layer.
 *
 * We mock `spotifyRequest` at the module level by intercepting the import of
 * auth.js via a global fetch mock and seeding valid tokens. Each test configures
 * the mock to return specific API responses.
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

function installBrowserGlobals() {
  globalThis.localStorage = createStorageMock();
  globalThis.sessionStorage = createStorageMock();
  globalThis.window = {
    location: { origin: 'http://localhost:3000', pathname: '/', href: '', search: '' },
    history: { replaceState() {} },
  };
  Object.defineProperty(globalThis, 'crypto', {
    value: {
      getRandomValues(arr) {
        for (let i = 0; i < arr.length; i++) arr[i] = Math.floor(Math.random() * 256);
        return arr;
      },
      subtle: { async digest(_algo, data) { return new Uint8Array(data).buffer; } },
    },
    writable: true,
    configurable: true,
  });
  globalThis.btoa = (str) => Buffer.from(str, 'binary').toString('base64');
  globalThis.atob = (str) => Buffer.from(str, 'base64').toString('binary');
  globalThis.document = { title: 'Test' };

  // Seed valid setup + tokens so spotifyRequest works
  localStorage.setItem('spotifyManager.setup', JSON.stringify({
    clientId: 'test_client_id_1234',
    redirectUri: 'http://localhost:3000/',
  }));
  localStorage.setItem('spotifyManager.tokens', JSON.stringify({
    accessToken: 'mock_access_token',
    refreshToken: 'mock_refresh_token',
    expiresAt: Date.now() + 3600 * 1000,
    scopes: [
      'playlist-read-private',
      'playlist-read-collaborative',
      'playlist-modify-private',
      'playlist-modify-public',
      'user-read-private',
    ],
  }));
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

async function importApi() {
  const url = new URL('../src/spotifyApi.js', import.meta.url);
  url.searchParams.set('_t', `${Date.now()}-${Math.random()}`);
  return import(url.href);
}

// Helper to create a mock fetch that routes by URL path
function createRoutedFetch(routes) {
  return async (urlOrStr, opts) => {
    const url = urlOrStr instanceof URL ? urlOrStr : new URL(urlOrStr);
    for (const [pattern, handler] of Object.entries(routes)) {
      if (url.pathname.includes(pattern)) {
        const result = typeof handler === 'function' ? handler(url, opts) : handler;
        return { ok: true, status: 200, json: async () => result };
      }
    }
    return { ok: false, status: 404, text: async () => 'Not found' };
  };
}

// --------------- Tests ---------------

test('fetchCurrentUserPlaylists returns mapped playlist list', async () => {
  installBrowserGlobals();
  try {
    globalThis.fetch = createRoutedFetch({
      '/me/playlists': {
        items: [
          {
            id: 'pl1', name: 'My Playlist', type: 'playlist',
            description: 'A great playlist',
            tracks: { total: 25 },
            owner: { display_name: 'user123', id: 'user123' },
            collaborative: false, public: true,
            snapshot_id: 'snap1',
            images: [{ url: 'https://img.example.com/1.jpg' }],
            external_urls: { spotify: 'https://open.spotify.com/playlist/pl1' },
          },
        ],
        next: null,
      },
    });

    const api = await importApi();
    const playlists = await api.fetchCurrentUserPlaylists();

    assert.equal(playlists.length, 1);
    assert.equal(playlists[0].id, 'pl1');
    assert.equal(playlists[0].name, 'My Playlist');
    assert.equal(playlists[0].totalTracks, 25);
    assert.equal(playlists[0].owner, 'user123');
    assert.equal(playlists[0].canLoad, true);
  } finally {
    cleanupBrowserGlobals();
  }
});

test('fetchPlaylistWithMetadata hydrates tracks with audio features and artist genres', async () => {
  installBrowserGlobals();
  try {
    const trackItem = {
      track: {
        id: 'tr1', type: 'track', name: 'Test Song', uri: 'spotify:track:tr1',
        artists: [{ id: 'ar1', name: 'Artist One' }],
        album: { id: 'al1', name: 'Album One', release_date: '2020-05-10', album_type: 'album' },
        duration_ms: 210000, explicit: false, popularity: 75,
        disc_number: 1, track_number: 3,
        external_ids: { isrc: 'US1234567890' },
      },
      added_at: '2021-01-15T12:00:00Z',
      added_by: { id: 'user1' },
      is_local: false,
    };

    globalThis.fetch = createRoutedFetch({
      '/playlists/pl1/items': {
        items: [trackItem],
        total: 1,
        next: null,
      },
      '/playlists/pl1': {
        id: 'pl1', name: 'Test PL', description: '', tracks: { total: 1 },
        owner: { display_name: 'owner', id: 'owner' },
        public: true, collaborative: false, snapshot_id: 'snap',
        followers: { total: 10 },
        images: [{ url: 'https://img.example.com/pl.jpg' }],
        external_urls: { spotify: 'https://open.spotify.com/playlist/pl1' },
      },
      '/audio-features': {
        audio_features: [{
          id: 'tr1', tempo: 128, key: 7, mode: 0,
          energy: 0.8, danceability: 0.7, valence: 0.6,
          loudness: -5.5, acousticness: 0.1,
          instrumentalness: 0.01, speechiness: 0.04,
          liveness: 0.15, time_signature: 4,
          analysis_url: 'https://api.spotify.com/v1/audio-analysis/tr1',
        }],
      },
      '/artists': {
        artists: [{ id: 'ar1', name: 'Artist One', genres: ['electronic', 'house'] }],
      },
    });

    const api = await importApi();
    const result = await api.fetchPlaylistWithMetadata('pl1');

    assert.equal(result.playlist.name, 'Test PL');
    assert.equal(result.tracks.length, 1);

    const track = result.tracks[0];
    assert.equal(track.title, 'Test Song');
    assert.equal(track.artistDisplay, 'Artist One');
    assert.equal(track.bpm, 128);
    assert.equal(track.energy, 0.8);
    assert.deepEqual(track.genres, ['electronic', 'house']);
    assert.equal(track.camelot, '6A');
    assert.equal(track.albumReleaseYear, 2020);
    assert.equal(track.isrc, 'US1234567890');
    assert.equal(track.metadataSource.audioFeatures, true);
    assert.equal(track.metadataSource.artistGenres, true);
  } finally {
    cleanupBrowserGlobals();
  }
});

test('reorderPlaylist sends PUT with track URIs', async () => {
  installBrowserGlobals();
  try {
    let capturedBody;
    globalThis.fetch = async (urlOrStr, opts) => {
      const url = urlOrStr instanceof URL ? urlOrStr : new URL(urlOrStr);
      if (url.pathname.includes('/playlists/') && opts.method === 'PUT') {
        capturedBody = JSON.parse(opts.body);
        return { ok: true, status: 200, json: async () => ({ snapshot_id: 'new_snap' }) };
      }
      return { ok: true, status: 200, json: async () => ({}) };
    };

    const api = await importApi();
    const result = await api.reorderPlaylist('pl1', ['spotify:track:a', 'spotify:track:b']);

    assert.equal(result.snapshotId, 'new_snap');
    assert.deepEqual(capturedBody.uris, ['spotify:track:a', 'spotify:track:b']);
  } finally {
    cleanupBrowserGlobals();
  }
});

test('createPlaylistFromTracks creates playlist and adds tracks', async () => {
  installBrowserGlobals();
  try {
    const calls = [];
    globalThis.fetch = async (urlOrStr, opts) => {
      const url = urlOrStr instanceof URL ? urlOrStr : new URL(urlOrStr);
      calls.push({ path: url.pathname, method: opts.method });

      if (opts.method === 'POST' && url.pathname === '/v1/me/playlists') {
        return {
          ok: true, status: 200,
          json: async () => ({
            id: 'new_pl', name: 'Created Playlist',
            external_urls: { spotify: 'https://open.spotify.com/playlist/new_pl' },
          }),
        };
      }
      if (opts.method === 'POST' && url.pathname.includes('/tracks')) {
        return { ok: true, status: 200, json: async () => ({ snapshot_id: 's' }) };
      }
      return { ok: true, status: 200, json: async () => ({}) };
    };

    const api = await importApi();
    const result = await api.createPlaylistFromTracks({
      name: 'Test Export',
      description: 'desc',
      public: false,
      trackUris: ['spotify:track:x', 'spotify:track:y'],
    });

    assert.equal(result.id, 'new_pl');
    assert.equal(result.name, 'Created Playlist');
    assert.ok(calls.some((c) => c.method === 'POST' && c.path === '/v1/me/playlists'));
  } finally {
    cleanupBrowserGlobals();
  }
});

test('createPlaylistFromTracks falls back to PUT when first add-tracks POST is forbidden', async () => {
  installBrowserGlobals();
  try {
    const calls = [];
    globalThis.fetch = async (urlOrStr, opts) => {
      const url = urlOrStr instanceof URL ? urlOrStr : new URL(urlOrStr);
      calls.push({ path: url.pathname, method: opts.method });

      if (opts.method === 'POST' && url.pathname === '/v1/me/playlists') {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            id: 'new_pl',
            name: 'Created Playlist',
            external_urls: { spotify: 'https://open.spotify.com/playlist/new_pl' },
          }),
        };
      }

      if (opts.method === 'POST' && url.pathname === '/v1/playlists/new_pl/tracks') {
        return {
          ok: false,
          status: 403,
          text: async () => '{"error":{"status":403,"message":"Forbidden"}}',
        };
      }

      if (opts.method === 'PUT' && url.pathname === '/v1/playlists/new_pl/tracks') {
        return { ok: true, status: 200, json: async () => ({ snapshot_id: 'seeded' }) };
      }

      return { ok: true, status: 200, json: async () => ({}) };
    };

    const api = await importApi();
    const result = await api.createPlaylistFromTracks({
      name: 'Test Export',
      description: 'desc',
      public: false,
      trackUris: ['spotify:track:x'],
    });

    assert.equal(result.id, 'new_pl');
    assert.ok(calls.some((c) => c.method === 'POST' && c.path === '/v1/playlists/new_pl/tracks'));
    assert.ok(calls.some((c) => c.method === 'PUT' && c.path === '/v1/playlists/new_pl/tracks'));
  } finally {
    cleanupBrowserGlobals();
  }
});

test('createPlaylistFromTracks retries forbidden add-tracks requests before failing', async () => {
  installBrowserGlobals();
  try {
    let postAttempts = 0;
    globalThis.fetch = async (urlOrStr, opts) => {
      const url = urlOrStr instanceof URL ? urlOrStr : new URL(urlOrStr);

      if (opts.method === 'GET' && url.pathname === '/v1/me') {
        return {
          ok: true,
          status: 200,
          json: async () => ({ id: 'user1', product: 'premium' }),
        };
      }

      if (opts.method === 'POST' && url.pathname === '/v1/me/playlists') {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            id: 'new_pl',
            name: 'Created Playlist',
            external_urls: { spotify: 'https://open.spotify.com/playlist/new_pl' },
          }),
        };
      }

      if (url.pathname === '/v1/playlists/new_pl/tracks' && opts.method === 'PUT') {
        return {
          ok: false,
          status: 403,
          text: async () => '{"error":{"status":403,"message":"Forbidden"}}',
        };
      }

      if (url.pathname === '/v1/playlists/new_pl/tracks' && opts.method === 'POST') {
        postAttempts += 1;
        if (postAttempts < 3) {
          return {
            ok: false,
            status: 403,
            text: async () => '{"error":{"status":403,"message":"Forbidden"}}',
          };
        }
        return { ok: true, status: 200, json: async () => ({ snapshot_id: 'done' }) };
      }

      return { ok: false, status: 404, text: async () => 'Not found' };
    };

    const api = await importApi();
    const result = await api.createPlaylistFromTracks({
      name: 'Retry Export',
      description: 'desc',
      public: false,
      trackUris: ['spotify:track:x'],
    });

    assert.equal(result.id, 'new_pl');
    assert.equal(postAttempts, 3);
  } finally {
    cleanupBrowserGlobals();
  }
});

test('fetchPlaylistWithMetadata tolerates forbidden audio-features responses', async () => {
  installBrowserGlobals();
  try {
    globalThis.fetch = async (urlOrStr, opts) => {
      const url = urlOrStr instanceof URL ? urlOrStr : new URL(urlOrStr);
      if (url.pathname === '/v1/playlists/pl3') {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            id: 'pl3', name: 'Test PL', description: '', tracks: { total: 1 },
            owner: { display_name: 'owner', id: 'owner' },
            public: true, collaborative: false, snapshot_id: 'snap',
            followers: { total: 10 }, images: [], external_urls: { spotify: '' },
          }),
        };
      }
      if (url.pathname === '/v1/playlists/pl3/items') {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            items: [{
              track: {
                id: 'tr1', type: 'track', name: 'Song', uri: 'spotify:track:tr1',
                artists: [{ id: 'ar1', name: 'Artist' }],
                album: { id: 'al1', name: 'Album', release_date: '2024-01-01', album_type: 'album' },
                duration_ms: 123000, explicit: false, popularity: 50,
              },
              added_at: '2024-01-01T00:00:00Z',
              added_by: { id: 'user1' },
              is_local: false,
            }],
            total: 1,
            next: null,
          }),
        };
      }
      if (url.pathname === '/v1/audio-features') {
        return {
          ok: false,
          status: 403,
          text: async () => '{"error":{"status":403,"message":"Forbidden"}}',
        };
      }
      if (url.pathname === '/v1/artists') {
        return {
          ok: true,
          status: 200,
          json: async () => ({ artists: [{ id: 'ar1', genres: ['indie'] }] }),
        };
      }
      return { ok: false, status: 404, text: async () => 'Not found' };
    };

    const api = await importApi();
    const result = await api.fetchPlaylistWithMetadata('pl3');

    assert.equal(result.tracks.length, 1);
    assert.equal(result.tracks[0].title, 'Song');
    assert.equal(result.tracks[0].analysisAvailable, false);
    assert.equal(result.tracks[0].bpm, null);
  } finally {
    cleanupBrowserGlobals();
  }
});

test('fetchPlaylistWithMetadata calls progress callback at each stage', async () => {
  installBrowserGlobals();
  try {
    globalThis.fetch = createRoutedFetch({
      '/playlists/pl2/items': { items: [], total: 0, next: null },
      '/playlists/pl2': {
        id: 'pl2', name: 'Empty', description: '', tracks: { total: 0 },
        owner: { display_name: 'o', id: 'o' }, public: true, collaborative: false,
        snapshot_id: 's', followers: { total: 0 }, images: [],
        external_urls: { spotify: '' },
      },
    });

    const api = await importApi();
    const stages = [];
    await api.fetchPlaylistWithMetadata('pl2', (ev) => stages.push(ev.stage));

    assert.ok(stages.includes('start'));
    assert.ok(stages.includes('playlist-header'));
    assert.ok(stages.includes('complete'));
  } finally {
    cleanupBrowserGlobals();
  }
});
