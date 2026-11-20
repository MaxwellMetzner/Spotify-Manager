import { test } from 'node:test';
import assert from 'node:assert/strict';
import { comparePlaylists, indexPlaylist, spotifyTrackUri } from '../src/shared/playlistComparison.js';
import { createPlaylistFromTracks, fetchComparisonTracks } from '../src/spotifyApi.js';

function track(n, title, artist, durationMs = 180000) {
  return { uri: 'spotify:track:' + String(n).padStart(22, '0'), title, artists: [artist], durationMs };
}

test('exact Spotify IDs define membership and first appearances define order', () => {
  const song = track(1, 'Home', 'A'), live = track(2, 'Home', 'A');
  const common = track(3, 'After Dark', 'B'), other = track(4, 'New Day', 'C');
  const a = indexPlaylist([null, song, live, song, common]);
  const b = indexPlaylist([other, common, song, common]);
  const { groups, sameOrder } = comparePlaylists(a, b);
  assert.equal(a.skipped, 1); assert.equal(a.repeats, 1);
  assert.deepEqual(groups.shared.map((r) => r.uri), [song.uri, common.uri]);
  assert.deepEqual(groups.a.map((r) => r.uri), [live.uri]);
  assert.deepEqual(groups.b.map((r) => r.uri), [other.uri]);
  assert.deepEqual(groups.all.map((r) => r.uri), [song.uri, live.uri, common.uri, other.uri]);
  assert.deepEqual(groups.shared.map((r) => [r.left.position, r.left.count, r.right.position, r.right.count]), [[2, 2, 3, 1], [5, 1, 2, 2]]);
  assert.equal(sameOrder, false);
  assert.equal(comparePlaylists(a, indexPlaylist([other, song, live, common])).sameOrder, true);
});

test('artist overlap also finds different recordings with a shared credited artist', () => {
  const a = indexPlaylist([{ ...track(1, 'First', 'One'), artists: ['One', ' Café '] }, track(2, 'Second', 'Solo')]);
  const b = indexPlaylist([track(3, 'Third', 'CAFE\u0301'), track(4, 'Fourth', 'Elsewhere')]);
  const report = comparePlaylists(a, b);
  assert.equal(report.groups.shared.length, 0);
  assert.equal(report.sharedArtistCount, 1);
  assert.deepEqual(report.groups.all.filter((r) => r.sharedArtist).map((r) => r.title), ['First', 'Third']);
});

test('missing IDs, local items and non-track URIs are counted outside the overlap', () => {
  const t = track(99, 'Night', 'Example');
  assert.equal(spotifyTrackUri({ trackId: t.uri.slice(14) }), t.uri);
  assert.equal(spotifyTrackUri({ uri: t.uri.replace('track:', 'episode:'), trackId: t.uri.slice(14) }), null);
  const a = indexPlaylist([null, { title: 'Night' }, { uri: 'spotify:local:x' }, { uri: t.uri.replace('track:', 'episode:') }, { ...t, isLocal: true }]);
  assert.equal(a.skipped, 5);
  const report = comparePlaylists(a, indexPlaylist([t]));
  assert.equal(report.groups.all.length, 1);
  assert.equal(report.groups.b.length, 1);
  assert.equal(comparePlaylists(a, a).groups.all.length, 0);
});

test('shared tracks use available display metadata and preserve a measured zero duration', () => {
  const t = track(1, 'Song', 'Band', 0);
  const a = indexPlaylist([{ uri: t.uri }]), b = indexPlaylist([{ ...t, albumName: 'Debut' }]);
  const [row] = comparePlaylists(a, b).groups.shared;
  assert.equal(row.durationMs, 0);
  assert.equal(row.title, 'Song');
  assert.equal(row.artist, 'Band');
  assert.match(row.searchText, /debut/);
  assert.equal(comparePlaylists(a, a).groups.shared[0].durationMs, null);
  const repeated = indexPlaylist([{ uri: t.uri }, t]);
  const [laterCredit] = comparePlaylists(repeated, b).groups.shared;
  assert.equal(laterCredit.left.position, 1); assert.equal(laterCredit.left.count, 2);
  assert.equal(laterCredit.durationMs, 0); assert.equal(laterCredit.sharedArtist, true);
});

function mockSpotify(t, handler) {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const token = JSON.stringify({ accessToken: 'test', expiresAt: Date.now() + 60000, scopes: ['playlist-modify-private'] });
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: (key) => key === 'spotifyManager.tokens' ? token : null } });
  t.after(() => {
    if (original) Object.defineProperty(globalThis, 'localStorage', original);
    else delete globalThis.localStorage;
  });
  t.mock.method(globalThis, 'fetch', (url, options) => handler(new URL(url), options));
}

test('Spotify comparison reads only item pages and preserves positions across missing entries', async (t) => {
  const offsets = [];
  const song = { type: 'track', id: '1'.repeat(22), name: 'Song', artists: [{ name: 'Band' }], duration_ms: 120000 };
  mockSpotify(t, (url) => {
    assert.equal(url.pathname, '/v1/playlists/list/items');
    assert.ok(url.searchParams.get('fields').includes('next,items('));
    const offset = Number(url.searchParams.get('offset')); offsets.push(offset);
    return Response.json(offset === 0
      ? { items: [{ item: song }, ...Array(49).fill({ item: null })], next: 'page2' }
      : { items: [{ item: { type: 'episode' } }, { is_local: true, track: song }, { track: song }], next: null });
  });
  const rows = await fetchComparisonTracks('list');
  assert.deepEqual(offsets, [0, 50]);
  assert.equal(rows.length, 53);
  assert.deepEqual(rows[52].artists, ['Band']);
  assert.equal(indexPlaylist(rows).skipped, 51);
  assert.deepEqual(await fetchComparisonTracks('list', () => false), []);
  assert.deepEqual(offsets, [0, 50]);
});

test('comparison can read an older playlist response when Spotify rejects the field selection', async (t) => {
  let requests = 0;
  mockSpotify(t, (url) => {
    requests++;
    if (url.searchParams.has('fields')) return new Response('Unknown field', { status: 400 });
    return Response.json({ items: [{ track: { type: 'track', id: '2'.repeat(22), name: 'Older entry' } }], next: null });
  });
  const rows = await fetchComparisonTracks('old');
  assert.equal(requests, 2); assert.equal(rows[0].title, 'Older entry');
});

test('retrying a later save batch appends to the tracks already written', async (t) => {
  const uris = Array.from({ length: 125 }, (_, i) => track(i, '', '').uri), written = [];
  let failedOnce = false;
  mockSpotify(t, (url, { method, body }) => {
    if (url.pathname === '/v1/me') return Response.json({ id: 'owner' });
    if (url.pathname === '/v1/me/playlists') return Response.json({ id: 'new', name: 'Combined' });
    if (url.pathname === '/v1/playlists/new') return Response.json({ id: 'new' });
    assert.equal(url.pathname, '/v1/playlists/new/items'); assert.equal(method, 'POST');
    if (written.length === 100 && !failedOnce) { failedOnce = true; return new Response('Retry', { status: 403 }); }
    written.push(...JSON.parse(body).uris);
    return Response.json({ snapshot_id: 'next' });
  });
  const result = await createPlaylistFromTracks({ name: 'Combined', public: false, trackUris: uris });
  assert.ok(failedOnce); assert.equal(result.totalTracks, 125); assert.deepEqual(written, uris);
});
