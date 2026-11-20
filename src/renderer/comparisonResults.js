import { comparePlaylists } from '../shared/playlistComparison.js';
import { formatDuration } from './trackData.js';
import { $, notify, showDialog } from './ui.js';

const number = (value) => value.toLocaleString();
const spotifyLink = (uri) => 'https://open.spotify.com/track/' + uri.slice('spotify:track:'.length);
function sharedPercent(shared, total) {
  const percent = 100 * shared / total;
  if (percent < 1) return '<1%';
  if (percent > 99 && shared < total) return '>99%';
  return Math.round(percent) + '%';
}

function overlapHeadline(a, b, shared) {
  if (!a.recordings.size || !b.recordings.size) {
    if (!a.recordings.size && !b.recordings.size) return 'Neither playlist has recordings with a Spotify track ID';
    const [letter, empty] = a.recordings.size ? ['B', b] : ['A', a];
    return 'Playlist ' + letter + (empty.entries ? ' has no recordings with a Spotify track ID' : ' is empty');
  }
  return shared ? sharedPercent(shared, a.recordings.size) + ' of A and ' + sharedPercent(shared, b.recordings.size) + ' of B are shared' : 'No shared recordings';
}
const position = (cell) => {
  const entry = cell.getValue();
  return entry ? '#' + number(entry.position) + (entry.count > 1 ? ' ×' + entry.count : '') : '—';
};

export function bindComparisonResults(save, sourceNames) {
  const search = $('compareSearch'), artists = $('compareArtists'), master = $('compareCheckAll');
  const buttons = [...$('compareGroups').querySelectorAll('button')];
  let report, group, table, ready = false, visible = [], excluded = new Set();

  function makeTable() {
    table = new Tabulator($('compareTable'), {
      index: 'uri', layout: 'fitColumns', height: '100%', rowHeight: 44, renderVertical: 'virtual', renderVerticalBuffer: 190,
      columnDefaults: { headerSort: false, resizable: false, vertAlign: 'middle' }, placeholder: 'No recordings match this view.',
      columns: [
        { title: '', field: 'uri', width: 33, minWidth: 30, hozAlign: 'center', formatter(cell) {
          const row = cell.getRow().getData(), input = document.createElement('input');
          input.type = 'checkbox'; input.checked = !excluded.has(row.uri); input.dataset.uri = row.uri;
          input.setAttribute('aria-label', 'Select ' + (row.title || 'untitled track'));
          return input;
        } },
        { title: 'Track / artist', field: 'title', minWidth: 96, widthGrow: 4, formatter(cell) {
          const row = cell.getRow().getData(), info = document.createElement('div');
          const link = document.createElement('a'), title = document.createElement('strong'), artist = document.createElement('small');
          info.className = 'compare-track'; title.textContent = row.title || 'Untitled'; artist.textContent = row.artist || 'Unknown artist';
          info.title = [title.textContent, artist.textContent, row.album].filter(Boolean).join(' · ');
          link.href = spotifyLink(row.uri);
          link.target = '_blank'; link.rel = 'noopener noreferrer'; link.title = 'Open ' + title.textContent + ' on Spotify';
          link.append(title); info.append(link, artist); return info;
        } },
        { title: 'In A', field: 'left', widthGrow: 1, minWidth: 48, formatter: position, headerTooltip: 'First position and number of copies in playlist A' },
        { title: 'In B', field: 'right', widthGrow: 1, minWidth: 48, formatter: position, headerTooltip: 'First position and number of copies in playlist B' },
        { title: 'Duration', field: 'durationMs', width: 79, formatter: (cell) => formatDuration(cell.getValue()) },
      ],
    });
    table.on('tableBuilt', () => { ready = true; table.setData(visible); });
  }

  function selection() {
    let count = 0, timed = 0, ms = 0;
    for (const row of visible) {
      if (excluded.has(row.uri)) continue;
      count++;
      if (row.durationMs !== null) { timed++; ms += row.durationMs; }
    }
    master.checked = count > 0 && count === visible.length;
    master.indeterminate = count > 0 && count < visible.length;
    master.disabled = !visible.length;
    $('compareSave').disabled = !count;
    $('compareCopy').disabled = !count;
    const runtime = ms >= 3600000 ? Math.floor(ms / 3600000) + ' hr ' + Math.floor(ms / 60000) % 60 + ' min' : formatDuration(ms);
    $('compareSelection').textContent = number(count) + ' of ' + number(visible.length) + ' selected' +
      (timed ? ' · ' + runtime + (timed < count ? ' known runtime' : ' runtime') : '');
  }

  function filter() {
    if (!report) return;
    const text = search.value.trim().toLowerCase();
    const rows = report.groups[group];
    visible = text || artists.checked ? rows.filter((r) => (!artists.checked || r.sharedArtist) && r.searchText.includes(text)) : rows;
    if (!table) makeTable();
    else if (ready) table.setData(visible);
    for (const button of buttons) button.setAttribute('aria-pressed', String(button.dataset.group === group));
    selection();
  }
  search.oninput = filter; artists.onchange = filter;
  $('compareGroups').onclick = (event) => {
    const button = event.target.closest('button');
    if (button) { group = button.dataset.group; filter(); }
  };
  $('compareTable').onchange = ({ target }) => {
    if (!target.dataset.uri) return;
    if (target.checked) excluded.delete(target.dataset.uri);
    else excluded.add(target.dataset.uri);
    selection();
  };
  master.onchange = () => {
    for (const row of visible) {
      if (master.checked) excluded.delete(row.uri);
      else excluded.add(row.uri);
    }
    if (ready) table.setData(visible);
    selection();
  };
  const selectedUris = () => visible.filter((row) => !excluded.has(row.uri)).map((row) => row.uri);
  $('compareSave').onclick = () => {
    const names = sourceNames();
    const labels = { shared: 'Shared · ' + names.join(' & '), a: names[0] + ' only', b: names[1] + ' only', all: names.join(' + ') };
    save(selectedUris(), labels[group]);
  };
  $('compareCopy').onclick = async () => {
    const links = selectedUris().map(spotifyLink), text = links.join('\n');
    try {
      await navigator.clipboard.writeText(text);
      notify('Copied ' + number(links.length) + (links.length === 1 ? ' track link.' : ' track links.'));
    } catch {
      $('compareLinksText').value = text; showDialog('compareLinksModal');
      $('compareLinksText').focus(); $('compareLinksText').select();
    }
  };

  return {
    clear() {
      if (!report) return;
      report = null; visible = []; excluded.clear();
      if (ready) table.setData(visible);
    },
    show(a, b, prefs = {}) {
      report = comparePlaylists(a, b);
      const { groups, sharedArtistCount, sameOrder } = report;
      const shared = groups.shared.length;
      $('compareHeadline').textContent = overlapHeadline(a, b, shared);
      const order = shared > 1 ? (sameOrder ? 'Shared tracks follow the same order.' : 'Shared tracks appear in a different order.') : '';
      $('compareInsights').textContent = number(sharedArtistCount) + (sharedArtistCount === 1 ? ' artist name appears' : ' artist names appear') + ' in both playlists.' + (order ? ' ' + order : '');
      const band = document.querySelectorAll('.compare-band i');
      ['a', 'shared', 'b'].forEach((key, i) => { band[i].style.flexGrow = groups[key].length; });
      for (const btn of buttons) btn.querySelector('b').textContent = number(groups[btn.dataset.group].length);
      group = Object.hasOwn(groups, prefs.group) ? prefs.group : shared ? 'shared' : groups.a.length ? 'a' : groups.b.length ? 'b' : 'all';
      search.value = prefs.query || ''; artists.checked = !!prefs.artists;
      excluded = new Set(prefs.excluded || []);
      filter();
    },
    snapshot: () => report ? { group, query: search.value, artists: artists.checked, excluded: [...excluded] } : null,
  };
}
