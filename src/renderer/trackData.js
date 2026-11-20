const dateFormat = new Intl.DateTimeFormat(undefined, {
  year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
});
const calendarDate = new Intl.DateTimeFormat(undefined, {
  year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC',
});

export function formatAdded(value) {
  if (!value) return '—';
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return '—';
  return (/^\d{4}-\d{2}-\d{2}$/.test(value) ? calendarDate : dateFormat).format(time);
}

export function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const seconds = Math.floor(ms / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

export function parseDuration(input) {
  const value = String(input).trim();
  if (!value) return null;
  const pair = /^(\d+):([0-5]\d)$/.exec(value);
  if (pair) return (Number(pair[1]) * 60 + Number(pair[2])) * 1000;
  return /^\d+(\.\d+)?$/.test(value) ? Number(value) * 1000 : NaN;
}

function csvRows(text) {
  const rows = [];
  let row = [], value = '', quoted = false;
  function endRow() {
    row.push(value);
    if (row.some((cell) => cell.trim())) rows.push(row);
    row = [];
    value = '';
  }
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      if (quoted && text[i + 1] === '"') { value += '"'; i++; }
      else quoted = !quoted;
    } else if (c === ',' && !quoted) {
      row.push(value);
      value = '';
    } else if ((c === '\n' || c === '\r') && !quoted) {
      if (c === '\r' && text[i + 1] === '\n') i++;
      endRow();
    } else value += c;
  }
  if (quoted) throw new Error('A quoted field is incomplete. Export the playlist again and select the new CSV.');
  endRow();
  return rows;
}

const FEATURE_HEADERS = {
  tempo: 'Tempo', key: 'Key', mode: 'Mode', timeSignature: 'Time Signature', loudness: 'Loudness',
  energy: 'Energy', valence: 'Valence', danceability: 'Danceability', acousticness: 'Acousticness',
  instrumentalness: 'Instrumentalness', speechiness: 'Speechiness', liveness: 'Liveness',
};

const enrichmentFields = [...Object.keys(FEATURE_HEADERS), 'bpm', 'genres', 'genreDisplay', 'recordLabel', 'isrc', 'popularity'];
const keyNames = ['C', 'C♯', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'A♭', 'A', 'B♭', 'B'];

export function prepareRows(tracks) {
  return tracks.map((track, rowId) => {
    const keyName = keyNames[track.key];
    const keyModeLabel = keyName && (track.mode === 0 || track.mode === 1)
      ? keyName + (track.mode ? ' major' : ' minor') : null;
    return { ...track, rowId, customOrder: rowId + 1, keyModeLabel,
      addedTime: track.addedAt ? Date.parse(track.addedAt) : NaN,
      searchText: [track.title, track.artistDisplay, track.albumName].join('\n').toLowerCase() };
  });
}

export function parseExportify(text) {
  const [header = [], ...rows] = csvRows(String(text).replace(/^\uFEFF/, ''));
  const headers = new Map(header.map((name, i) => [name.trim().toLowerCase(), i]));
  if (!headers.has('track name') && !headers.has('track uri')) {
    throw new Error('Choose an Exportify playlist CSV with a Track Name or Track URI column.');
  }
  const read = (row, ...names) => {
    for (const name of names) {
      const value = row[headers.get(name.toLowerCase())]?.trim();
      if (value && value !== 'undefined' && value !== 'null') return value;
    }
    return null;
  };
  const number = (value) => value !== null && Number.isFinite(Number(value)) ? Number(value) : null;
  const tracks = [];
  for (const row of rows) {
    const title = read(row, 'Track Name'), uri = read(row, 'Track URI');
    if (!title && !uri) continue;
    const artistText = read(row, 'Artist Name(s)');
    const artists = (artistText || '').split(';').map((v) => v.trim()).filter(Boolean);
    const genres = (read(row, 'Genres', 'Artist Genres') || '').split(/[,;]/).map((v) => v.trim()).filter(Boolean);
    const durationMs = number(read(row, 'Duration (ms)', 'Track Duration (ms)'));
    const explicit = read(row, 'Explicit', 'Explicit?')?.toLowerCase();
    const track = {
      title, uri, artists, primaryArtist: artists[0], artistDisplay: artists.join(', '),
      albumName: read(row, 'Album Name'), albumReleaseDate: read(row, 'Release Date', 'Album Release Date'),
      addedBy: read(row, 'Added By'), addedAt: read(row, 'Added At'), durationMs,
      durationSeconds: durationMs === null ? null : durationMs / 1000, popularity: number(read(row, 'Popularity')),
      explicit: explicit === 'true' ? true : explicit === 'false' ? false : null, isrc: read(row, 'ISRC'),
      recordLabel: read(row, 'Record Label', 'Label'), genres, genreDisplay: genres.join(', '),
    };
    for (const [field, name] of Object.entries(FEATURE_HEADERS)) track[field] = number(read(row, name));
    track.bpm = track.tempo ?? number(read(row, 'BPM'));
    track.tempo = track.bpm;
    tracks.push(track);
  }
  if (!tracks.length) throw new Error('This file has no track rows. Choose a playlist export with at least one track.');
  return tracks;
}

// Only recording-level fields can be shared by repeated occurrences of the same Spotify URI.
export function enrichTracks(base, imported) {
  const byUri = new Map();
  for (const track of imported) {
    if (!track.uri?.startsWith('spotify:track:')) continue;
    const fields = byUri.get(track.uri) || {};
    for (const key of enrichmentFields) {
      const value = track[key];
      if (value != null && value !== '' && (!Array.isArray(value) || value.length)) fields[key] = value;
    }
    if (Object.keys(fields).length) byUri.set(track.uri, fields);
  }
  let matched = 0;
  const tracks = base.map((track) => {
    const fields = byUri.get(track.uri);
    if (!fields) return track;
    matched++;
    return { ...track, ...fields };
  });
  return { tracks, matched };
}
