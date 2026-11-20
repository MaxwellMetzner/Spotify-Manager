import { indexPlaylist } from '../shared/playlistComparison.js';
import { bindComparisonResults } from './comparisonResults.js';
import { $, runWorker } from './ui.js';

export function bindComparison({ context, workingTracks, readSpotify, save }) {
  const host = $('compareSources');
  const slots = ['A', 'B'].map((letter) => {
    const card = document.createElement('div');
    card.className = 'panel compare-source';
    card.innerHTML = `<a class="compare-art" target="_blank" rel="noopener noreferrer"><span aria-hidden="true">${letter}</span><img alt="" hidden></a>
      <div><div class="compare-source-top"><label for="compareSource${letter}">Playlist ${letter}</label>
        <button type="button" class="text-btn" aria-label="Import CSV for playlist ${letter}">Import CSV</button></div>
      <select id="compareSource${letter}"></select><input type="file" accept=".csv,text/csv" aria-label="CSV for playlist ${letter}" hidden>
      <small role="status"></small> <button type="button" class="text-btn retry-source" hidden>Retry</button></div>`;
    host.append(card);
    const select = card.querySelector('select'), file = card.querySelector('[type=file]'), image = card.querySelector('img');
    const slot = { select, image, art: card.querySelector('.compare-art'), info: card.querySelector('small'), retry: card.querySelector('.retry-source'),
      key: '', csv: null, ticket: 0, source: null, index: null, error: '' };
    image.onerror = () => { image.hidden = true; };
    card.querySelector('button').onclick = () => file.click();
    select.onchange = () => { slot.key = select.value; if (letter === 'A') autoUseWorking = false; pendingPrefs = null; sync(); };
    file.onchange = () => {
      const picked = file.files[0];
      if (!picked) return;
      if (letter === 'A') autoUseWorking = false;
      slot.csv = { name: picked.name.replace(/\.csv$/i, '').replace(/_/g, ' '), file: picked };
      slot.key = 'csv'; file.value = ''; pendingPrefs = null; sync();
    };
    slot.retry.onclick = () => { slot.source = null; sync(); };
    return slot;
  });
  const results = bindComparisonResults(save, () => slots.map((slot) => slot.source.name));
  let comparedA, comparedB, pendingPrefs, autoUseWorking = true;

  function showInfo(slot) {
    const index = slot.index;
    const notes = [];
    if (index) {
      const size = index.recordings.size;
      notes.push(size.toLocaleString() + (size === 1 ? ' distinct track' : ' distinct tracks'));
      if (index.repeats) notes.push(index.repeats.toLocaleString() + (index.repeats === 1 ? ' repeat' : ' repeats'));
      if (index.skipped) notes.push(index.skipped.toLocaleString() + ' without a Spotify track ID');
    }
    slot.info.textContent = slot.error || (index ? notes.join(' · ') : slot.source ? 'Loading tracks…' : '');
    slot.info.classList.toggle('error', !!slot.error);
    slot.retry.hidden = !slot.error;
  }

  function refreshReport() {
    const [a, b] = slots;
    const complete = !!(a.index && b.index);
    $('compareEmpty').hidden = complete;
    $('compareReport').hidden = !complete;
    if (!complete) {
      comparedA = null; comparedB = null; results.clear();
      $('compareEmpty').textContent = slots.some((s) => s.error) ? 'Choose another source or retry the playlist above.' :
        slots.some((s) => s.source && !s.index) ? 'Waiting for playlist tracks…' : 'Choose a playlist or import an Exportify CSV for each side.';
    } else if (!$('compareView').hidden && (a.index !== comparedA || b.index !== comparedB)) {
      comparedA = a.index; comparedB = b.index;
      results.show(a.index, b.index, pendingPrefs || {});
      pendingPrefs = null;
    }
  }

  function showArtwork(slot, source) {
    if (source?.id) {
      slot.art.href = 'https://open.spotify.com/playlist/' + encodeURIComponent(source.id);
      slot.art.setAttribute('aria-label', 'Open ' + source.name + ' on Spotify');
    } else { slot.art.removeAttribute('href'); slot.art.removeAttribute('aria-label'); }
    const url = source?.imageUrl;
    slot.image.hidden = !url?.startsWith('https://');
    if (!slot.image.hidden) slot.image.src = url;
    else slot.image.removeAttribute('src');
  }

  async function load(slot, source) {
    const ticket = ++slot.ticket;
    slot.source = source; slot.index = null; slot.error = '';
    showArtwork(slot, source);
    showInfo(slot);
    if (!source) return;
    try {
      let rows;
      if (source.key === 'csv') {
        const csv = slot.csv;
        rows = csv.tracks || await runWorker({ action: 'csv', file: csv.file, allowEmpty: true });
        if (ticket !== slot.ticket) return;
        csv.tracks = rows; delete csv.file;
      } else if (source.key === 'working') rows = workingTracks();
      else rows = await readSpotify(source.id, () => ticket === slot.ticket);
      if (ticket !== slot.ticket) return;
      slot.index = indexPlaylist(rows);
    } catch (error) {
      if (ticket !== slot.ticket) return;
      slot.error = String(error.message).includes('403') ? 'Spotify denied access. Import this playlist as a CSV.' : error.message;
    }
    showInfo(slot);
  }

  function sync() {
    const { meta, playlists, revision, libraryRevision, authenticated } = context();
    $('compareConnect').hidden = authenticated;
    if (autoUseWorking && meta && !slots[0].key && slots[1].key !== 'working') {
      slots[0].key = 'working'; autoUseWorking = false;
    }
    const working = meta && { ...meta, key: 'working', label: meta.name + ' · Working copy', version: revision };
    const library = playlists.filter((p) => p.id && p.canLoad !== false).map((p) => ({
      ...p, key: 'spotify:' + p.id, label: p.owner ? p.name + ' · ' + p.owner : p.name, version: p.snapshotId || libraryRevision,
    }));
    for (const slot of slots) {
      const other = slots.find((s) => s !== slot);
      const csv = slot.csv && { key: 'csv', name: slot.csv.name, label: slot.csv.name + ' · CSV', version: slot.csv };
      const choices = [working, csv, ...library].filter(Boolean);
      slot.select.replaceChildren(new Option('Choose a playlist', ''));
      for (const item of choices) {
        const option = new Option(item.label, item.key);
        option.disabled = item.key !== 'csv' && item.key === other.key;
        slot.select.add(option);
      }
      const source = choices.find((item) => item.key === slot.key) || null;
      slot.key = source?.key || ''; slot.select.value = slot.key;
      slot.select.disabled = !choices.length;
      if (source?.key !== slot.source?.key || source?.version !== slot.source?.version) load(slot, source).then(refreshReport);
      else if (source && (source.name !== slot.source.name || source.imageUrl !== slot.source.imageUrl)) {
        slot.source = source; showArtwork(slot, source);
      }
    }
    refreshReport();
  }

  return {
    show: sync,
    snapshot: () => slots.some((s) => s.key || s.csv)
      ? { sources: slots.map((s) => ({ key: s.key, csv: s.csv })), prefs: results.snapshot() || pendingPrefs } : null,
    restore(saved) {
      autoUseWorking = false;
      slots.forEach((slot, i) => { slot.key = saved.sources[i]?.key || ''; slot.csv = saved.sources[i]?.csv || null; });
      pendingPrefs = saved.prefs;
    },
    signOut(keepWorkingCsv) {
      for (const slot of slots) {
        if (slot.key.startsWith('spotify:') || (slot.key === 'working' && !keepWorkingCsv)) { slot.key = ''; load(slot, null); }
      }
      pendingPrefs = null; refreshReport();
    },
  };
}
