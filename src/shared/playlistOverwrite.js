export function playlistSizeError(size) {
  return size > 10000 ? 'Spotify supports up to 10,000 tracks per playlist. Select fewer tracks to save.' : '';
}

export function canOverwritePlaylist(playlist, userId) {
  return Boolean(userId && playlist?.id && (playlist.ownerId === userId || playlist.collaborative === true));
}

// A block move rotates the span between its old and new positions. Verify the
// entire span before using Spotify's reorder operation, including repeated URIs.
function findBlockMove(entries, at) {
  let first = 0, last = entries.length - 1;
  while (entries[first].uri === at(first)) first++;
  while (entries[last].uri === at(last)) last--;
  let start = first + 1;
  while (start <= last && entries[start].uri !== at(first)) start++;
  if (start > last) return null;
  let source = start;
  for (let i = first; i <= last; i++) {
    if (entries[source].uri !== at(i)) return null;
    source = source === last ? first : source + 1;
  }
  return { range_start: start, range_length: last - start + 1, insert_before: first };
}

export function describeReplacement(entries, uris) {
  // Spotify can return the playable version of a recording in the user's market.
  const aliases = new Map();
  for (const item of entries) if (item.kind === 'track' && item.originalUri && item.uri) aliases.set(item.originalUri, item.uri);
  const counts = new Map();
  const at = (i) => aliases.get(uris[i]) || uris[i];
  for (const uri of uris) {
    const key = aliases.get(uri) || uri;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  let kept = 0, prefix = entries.length <= uris.length, episodes = 0, unavailable = 0;
  const removedNames = [];
  entries.forEach((item, index) => {
    const key = item.kind === 'track' ? item.uri : null;
    if (!key || key !== at(index)) prefix = false;
    const count = counts.get(key) || 0;
    if (count) { counts.set(key, count - 1); kept++; }
    else {
      if (item.kind === 'episode') episodes++;
      if (item.kind === 'local' || item.kind === 'unavailable') unavailable++;
      if (removedNames.length < 5) removedNames.push(item.title || key || 'Unavailable item');
    }
  });
  const added = uris.length - kept, removed = entries.length - kept;
  const identical = prefix && entries.length === uris.length;
  const move = !identical && !added && !removed ? findBlockMove(entries, at) : null;
  return { added, removed, kept, episodes, unavailable, removedNames, identical, move, appendFrom: prefix ? entries.length : null };
}

export function originalPlaylistCsv(entries) {
  function cell(value) {
    let text = String(value ?? '');
    if (/^[\s]*[=+@-]|^[\t\r\n]/.test(text)) text = "'" + text;
    return '"' + text.replaceAll('"', '""') + '"';
  }
  const rows = [['Original Position', 'Track URI', 'Track Name', 'Artist Name(s)', 'Added At', 'Added By', 'Item Type']];
  entries.forEach((item, i) => rows.push([i + 1, item.originalUri || item.uri, item.title, item.artists, item.addedAt, item.addedBy, item.kind]));
  return '\uFEFF' + rows.map((row) => row.map(cell).join(',')).join('\r\n') + '\r\n';
}
