import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canOverwritePlaylist, describeReplacement, originalPlaylistCsv, playlistSizeError } from '../src/shared/playlistOverwrite.js';
import { createPlaylistFromTracks, inspectPlaylistOverwrite, overwritePlaylistItems } from '../src/spotifyApi.js';
import { parseExportify } from '../src/renderer/trackData.js';

const uri = (i) => 'spotify:track:' + String(i).padStart(22, '0');
const entry = (i) => ({ kind: 'track', uri: uri(i), title: 'Song ' + i });
const row = (i) => ({ item: { type: 'track', uri: uri(i), name: 'Song ' + i, artists: [{ name: 'Band' }] } });

function spotify(t, rows = [], scopes = ['playlist-modify-private']) {
  const data = { rows, writes: [], reads: 0, snapshot: 1, owner: 'me', public: false, collaborative: false };
  const stored = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const tokens = JSON.stringify({ accessToken: 'fixture', expiresAt: Date.now() + 60000, scopes });
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: (key) => key === 'spotifyManager.tokens' ? tokens : null } });
  t.after(() => { if (stored) Object.defineProperty(globalThis, 'localStorage', stored); else delete globalThis.localStorage; });
  t.mock.method(globalThis, 'fetch', (url, { method, body }) => {
    const { pathname, searchParams } = new URL(url);
    if (pathname === '/v1/playlists/test' && method === 'GET') {
      data.reads++;
      data.onHeader?.(data.reads);
      return Response.json({ id: 'test', name: 'Rotation', owner: { id: data.owner }, public: data.public,
        collaborative: data.collaborative, snapshot_id: 'v' + data.snapshot });
    }
    assert.equal(pathname, '/v1/playlists/test/items');
    if (method === 'GET') {
      assert.equal(searchParams.get('additional_types'), 'track,episode');
      const start = Number(searchParams.get('offset')), limit = Number(searchParams.get('limit'));
      return Response.json({ items: data.rows.slice(start, start + limit), total: data.total ?? data.rows.length,
        next: start + limit < data.rows.length ? 'next' : null });
    }
    const payload = JSON.parse(body), { uris } = payload;
    data.writes.push({ method, ...payload });
    if (data.reject) return new Response('Access denied', { status: data.reject });
    if (uris) {
      assert.ok(uris.length <= 100);
      const additions = uris.map((id) => row(Number(id.slice(14))));
      data.rows = method === 'PUT' ? additions : [...data.rows, ...additions];
    } else {
      assert.equal(method, 'PUT');
      assert.equal(payload.snapshot_id, 'v' + data.snapshot);
      const moved = data.rows.splice(payload.range_start, payload.range_length);
      data.rows.splice(payload.insert_before, 0, ...moved);
    }
    const snapshot_id = 'v' + ++data.snapshot;
    data.afterWrite?.(data.writes.length);
    return Response.json({ snapshot_id });
  });
  data.review = (options) => inspectPlaylistOverwrite('test', 'me', options);
  data.save = (target, uris, extra) => overwritePlaylistItems({ target, userId: 'me', uris, ...extra });
  return data;
}

test('the review counts occurrences, relinked recordings and unsupported removals', () => {
  const original = [entry(1), entry(1), { ...entry(2), originalUri: uri(22) },
    { kind: 'episode', title: 'Interview' }, { kind: 'local', uri: uri(7), title: 'Demo' }, { kind: 'unavailable' }];
  const diff = describeReplacement(original, [uri(22), uri(1), uri(7)]);
  assert.deepEqual([diff.kept, diff.added, diff.removed, diff.episodes, diff.unavailable], [2, 1, 4, 1, 2]);
  assert.deepEqual(diff.removedNames, ['Song 1', 'Interview', 'Demo', 'Unavailable item']);
  assert.equal(diff.appendFrom, null);
  assert.equal(describeReplacement(original.slice(0, 3), [uri(1), uri(1), uri(22)]).identical, true);
  const changeOrder = describeReplacement([entry(1), entry(2)], [uri(2), uri(1)]);
  assert.deepEqual([changeOrder.identical, changeOrder.added, changeOrder.removed], [false, 0, 0]);
});

test('the original track list preserves order, repeats, dates, credits and CSV quotes', () => {
  const original = [{ ...entry(1), title: 'A "live", take', artists: 'Band; Guest', addedAt: '2025-08-18T00:00:00Z', addedBy: 'listener' },
    { ...entry(1), title: '=formula' }, { kind: 'episode', title: 'Interview', uri: 'spotify:episode:test' }];
  const csv = originalPlaylistCsv(original);
  assert.ok(csv.startsWith('\uFEFF'));
  assert.match(csv, /"A ""live"", take"/);
  assert.match(csv, /"'=formula"/);
  assert.match(csv, /"2025-08-18T00:00:00Z","listener","track"/);
  assert.deepEqual(parseExportify(csv).map((r) => r.uri), [uri(1), uri(1), 'spotify:episode:test']);
});

test('destination inspection keeps every position across pages, including local files and episodes', async (t) => {
  const s = spotify(t, [...Array.from({ length: 50 }, (_, i) => row(i)), { item: null },
    { track: { type: 'episode', name: 'Interview', uri: 'spotify:episode:test' } }, { ...row(3), is_local: true }]);
  s.rows[0].added_by = { id: 'contributor' };
  const progress = [];
  const target = await s.review({ onProgress: (n) => progress.push(n) });
  assert.deepEqual(progress, [50, 53]);
  assert.deepEqual(target.entries.slice(50).map((item) => item.kind), ['unavailable', 'episode', 'local']);
  assert.equal(target.entries[0].addedBy, 'contributor');
  assert.equal(target.snapshotId, 'v1');
  assert.equal(s.writes.length, 0);
  assert.equal(await s.review({ isCurrent: () => false }), null);
  s.total = 54;
  await assert.rejects(s.review(), /incomplete/);
});

test('ownership and public/private scopes gate overwrites, and Spotify can deny collaborative edits', async (t) => {
  const s = spotify(t, [row(7)]);
  assert.equal(canOverwritePlaylist({ id: 'x', ownerId: 'me' }, ''), false);
  s.owner = 'someone';
  await assert.rejects(s.review(), /own or can edit/);
  s.collaborative = true;
  const target = await s.review();
  s.public = true;
  await assert.rejects(s.save(target, [uri(1)]), /playlist-modify-public/);
  assert.equal(s.writes.length, 0);
  s.public = false;
  s.reject = 403;
  await assert.rejects(s.save(target, [uri(1)]), /Spotify denied edit access/);
  assert.equal(s.writes.length, 1);
  assert.equal(s.rows[0].item.uri, uri(7));
});

test('a public playlist uses its matching scope and unchanged playlists skip writes', async (t) => {
  const s = spotify(t, [row(1), row(1)], ['playlist-modify-public']);
  s.public = true;
  const target = await s.review();
  await s.save(target, [uri(1), uri(1)]);
  assert.equal(s.writes.length, 0);
  await s.save(target, [uri(1)]);
  assert.deepEqual(s.writes, [{ method: 'PUT', uris: [uri(1)] }]);
});

test('changed versions during inspection and before confirmation prevent writes', async (t) => {
  const s = spotify(t, [row(1)]);
  s.onHeader = (n) => { if (n === 2) s.snapshot++; };
  await assert.rejects(s.review(), /changed on Spotify/);
  const target = await s.review();
  s.snapshot++;
  await assert.rejects(s.save(target, [uri(2)]), /changed on Spotify/);
  assert.equal(s.writes.length, 0);
});

test('moving a block uses Spotify’s snapshot-aware reorder and preserves the entry credits', async (t) => {
  const initial = [1, 2, 3, 4, 2, 5].map((n, i) => ({ ...row(n), added_by: { id: 'listener-' + i } }));
  const s = spotify(t, initial.slice());
  const proposed = [1, 4, 2, 2, 3, 5].map(uri);
  const target = await s.review();
  await s.save(target, proposed);
  assert.deepEqual(s.writes, [{ method: 'PUT', range_start: 3, range_length: 2, insert_before: 1, snapshot_id: 'v1' }]);
  assert.deepEqual(s.rows, [initial[0], initial[3], initial[4], initial[1], initial[2], initial[5]]);
  assert.deepEqual(s.rows.map((r) => r.item.uri), proposed);
});

test('a complex reorder falls back to a verified replacement in the requested order', async (t) => {
  const s = spotify(t, [1, 2, 3, 4, 5].map(row));
  const proposed = [3, 2, 4, 1, 5].map(uri);
  await s.save(await s.review(), proposed);
  assert.deepEqual(s.writes, [{ method: 'PUT', uris: proposed }]);
});

test('overwriting writes batches in reviewed order including duplicates', async (t) => {
  const s = spotify(t, [row(99)]);
  const proposed = Array.from({ length: 201 }, (_, i) => uri(i % 117));
  const target = await s.review();
  const progress = [];
  const saved = await s.save(target, proposed, { onProgress: (n) => progress.push(n) });
  assert.deepEqual(s.writes.map((write) => [write.method, write.uris.length]), [['PUT', 100], ['POST', 100], ['POST', 1]]);
  assert.deepEqual(s.rows.map((r) => r.item.uri), proposed);
  assert.deepEqual(progress, [100, 200, 201]);
  assert.equal(saved.id, 'test');
  assert.equal(saved.snapshotId, 'v4');
});

test('a change between batches stops further writes and reports confirmed progress', async (t) => {
  const s = spotify(t, [row(900)]);
  const target = await s.review();
  s.afterWrite = () => { s.rows.push(row(456)); s.snapshot++; };
  await assert.rejects(s.save(target, Array.from({ length: 122 }, (_, i) => uri(i))), /changed on Spotify.*100 of 122/);
  assert.equal(s.writes.length, 1);
  assert.equal(s.rows.at(-1).item.uri, uri(456));
});

test('a lost response requires a new review and resuming preserves the accepted prefix', async (t) => {
  const s = spotify(t, [row(999)]);
  const proposed = Array.from({ length: 204 }, (_, i) => uri(i));
  s.afterWrite = (n) => { if (n === 2) throw new Error('Connection interrupted'); };
  await assert.rejects(s.save(await s.review(), proposed), /interrupted.*100 of 204/);
  assert.equal(s.writes.length, 2);
  const remaining = await s.review();
  assert.equal(remaining.entries.length, 200);
  await s.save(remaining, proposed);
  assert.deepEqual(s.writes.at(-1), { method: 'POST', uris: proposed.slice(200) });
  assert.deepEqual(s.rows.map((r) => r.item.uri), proposed);
});

test('only an explicitly empty proposal can clear a destination', async (t) => {
  const s = spotify(t, [row(1)]), target = await s.review();
  await assert.rejects(s.save(target, []), /valid track list/);
  await assert.rejects(s.save(target, ['spotify:local:x'], { allowEmpty: true }), /valid track list/);
  assert.equal(s.writes.length, 0);
  await s.save(target, [], { allowEmpty: true });
  assert.deepEqual(s.writes, [{ method: 'PUT', uris: [] }]);
  await s.save(await s.review(), [], { allowEmpty: true });
  assert.equal(s.writes.length, 1);
});

test('oversized comparison selections are rejected before creating or overwriting a playlist', async (t) => {
  const s = spotify(t, [row(1)]), target = await s.review();
  const proposed = Array(10001).fill(uri(1)), reads = s.reads;
  assert.equal(playlistSizeError(10000), '');
  await assert.rejects(s.save(target, proposed), /10,000/);
  await assert.rejects(createPlaylistFromTracks({ name: 'Combined', trackUris: proposed }), /10,000/);
  assert.equal(s.reads, reads);
  assert.equal(s.writes.length, 0);
});
