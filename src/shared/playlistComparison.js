const trackId = /^[a-zA-Z0-9]{22}$/;
const trackUri = /^spotify:track:[a-zA-Z0-9]{22}$/;
export const isSpotifyTrackUri = (uri) => typeof uri === 'string' && trackUri.test(uri);

export function spotifyTrackUri(track) {
  if (!track || track.isLocal) return null;
  if (track.uri) return isSpotifyTrackUri(track.uri) ? track.uri : null;
  return trackId.test(track.trackId || '') ? 'spotify:track:' + track.trackId : null;
}

const artistKey = (name) => typeof name === 'string' ? name.normalize('NFKC').trim().toLowerCase() : '';

export function indexPlaylist(tracks) {
  const recordings = new Map(), artists = new Set();
  let skipped = 0, repeats = 0;
  tracks.forEach((track, i) => {
    const uri = spotifyTrackUri(track);
    if (!uri) { skipped++; return; }
    let entry = recordings.get(uri);
    if (entry) { repeats++; }
    else {
      entry = { position: i + 1, count: 0, title: '', album: '', names: [], keys: [], durationMs: null };
      recordings.set(uri, entry);
    }
    entry.count++;
    entry.title ||= track.title || '';
    entry.album ||= track.albumName || '';
    if (entry.durationMs === null && Number.isFinite(track.durationMs) && track.durationMs >= 0) entry.durationMs = track.durationMs;
    const names = track.artists?.length ? track.artists : [track.primaryArtist || track.artistDisplay || ''];
    for (const name of names) {
      const key = artistKey(name);
      if (key && !entry.keys.includes(key)) { entry.keys.push(key); entry.names.push(name); artists.add(key); }
    }
  });
  return { recordings, artists, entries: tracks.length, skipped, repeats };
}

// Keep first appearances in A order, followed by B's additional recordings in B order.
export function comparePlaylists(a, b) {
  const groups = { a: [], shared: [], b: [], all: [] };
  const sharedArtists = new Set([...a.artists].filter((key) => b.artists.has(key)));
  let lastPosition = 0, sameOrder = true;
  function add(uri, left, right, group) {
    const title = left?.title || right?.title || '';
    const artist = (left?.names.length ? left.names : right?.names || []).join(', ');
    const album = left?.album || right?.album || '';
    const durationMs = left?.durationMs ?? right?.durationMs ?? null;
    const row = { uri, title, artist, album, durationMs, left, right,
      sharedArtist: !!(left?.keys.some((key) => sharedArtists.has(key)) || right?.keys.some((key) => sharedArtists.has(key))),
      searchText: [title, artist, album].join('\n').toLowerCase() };
    groups[group].push(row);
    groups.all.push(row);
  }
  for (const [uri, left] of a.recordings) {
    const right = b.recordings.get(uri);
    if (right) {
      if (right.position < lastPosition) sameOrder = false;
      lastPosition = right.position;
    }
    add(uri, left, right, right ? 'shared' : 'a');
  }
  for (const [uri, right] of b.recordings) {
    if (!a.recordings.has(uri)) add(uri, null, right, 'b');
  }
  return { groups, sharedArtistCount: sharedArtists.size, sameOrder };
}
