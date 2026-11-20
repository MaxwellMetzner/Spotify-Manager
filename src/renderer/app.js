import * as auth from '../auth.js';
import * as api from '../spotifyApi.js';
import { clearDebugLogEntries, createLogger, getDebugLogEntries, getDebugState, setDebugState, subscribeDebugLogs } from '../debug.js';
import { prepareRows, enrichTracks } from './trackData.js';
import { createTrackTable, defaultColumns } from './tableView.js';
import { bindTableControls } from './tableControls.js';
import { bindAnalysisPanels } from './analysisPanels.js';
import { bindLibrary } from './library.js';
import { bindComparison } from './comparisonView.js';
import { spotifyTrackUri } from '../shared/playlistComparison.js';
import { bindSpotifySave } from './spotifySave.js';
import { saveLoginDraft, restoreLoginDraft } from './loginDraft.js';
import { $, notify, runWorker, showDialog, status } from './ui.js';

const analysis = globalThis.PlaylistAnalysis;
const log = createLogger('workspace');
const state = {
  meta: null, source: 'spotify', tracks: [], order: [], past: [], future: [],
  coverage: { audio: 0, tempo: 0, genres: 0 }, duration: 0, durationKnown: false,
  view: 'tracks', playlists: [], user: null, authenticated: false,
};
let table, tableReady, controls, panels, library, comparison, request = 0, revision = 0, libraryRequest = 0;
let saver, setupExport = null;
const views = { tracks: 'Tracklist', mix: 'Mix Assist', analyze: 'Analyzer', compare: 'Compare' };
const workingTracks = () => state.order.map((id) => state.tracks[id]);
function visibleTracks() {
  if (!state.meta || !table) return [];
  controls?.flush();
  // The mix and export views only read the active rows. Use their underlying
  // records so opening a view does not deep-copy every track and its metadata.
  return table.getRows('active').map((row) => row.getData());
}

function mobileLibrary(open) {
  const wasOpen = document.body.classList.contains('library-open');
  document.body.classList.toggle('library-open', open);
  const toggle = document.querySelector('.mobile-menu');
  toggle.setAttribute('aria-expanded', String(open));
  if (open) $('playlistSearch').focus();
  else if (wasOpen) toggle.focus({ preventScroll: true });
}
function chooseView(view) {
  state.view = view;
  mobileLibrary(false);
  $('viewName').textContent = views[view];
  for (const tab of document.querySelectorAll('[data-view]')) {
    if (tab.dataset.view === view) tab.setAttribute('aria-current', 'page');
    else tab.removeAttribute('aria-current');
  }
  $('welcome').hidden = !!state.meta || view !== 'tracks';
  $('playlistHeader').hidden = !state.meta || view === 'compare';
  $('importCsvBtn').hidden = view === 'compare';
  $('tracksView').hidden = view !== 'tracks' || !state.meta;
  $('mixView').hidden = view !== 'mix';
  $('analyzeView').hidden = view !== 'analyze';
  $('compareView').hidden = view !== 'compare';
  if (view === 'compare') comparison.show();
  if (view === 'mix') panels?.showMix();
  if (view === 'analyze') panels?.showAnalyzer();
  if (view === 'tracks' && state.meta && table?.initialized) table.redraw();
}

function updateCount(count) {
  $('filterCount').textContent = count === state.order.length
    ? count.toLocaleString() + ' tracks' : count.toLocaleString() + ' of ' + state.order.length.toLocaleString() + ' tracks';
}
function updateSelection(count) {
  $('removeSelectedBtn').disabled = !count;
  $('selectionCount').textContent = count ? count + ' selected' : 'Click a header to sort or filter';
}
function ensureGrid() {
  if (!table) {
    const grid = createTrackTable($('tracksTable'), {
      onFilter: (field, rect) => controls.openFilter(field, rect), onRemove: removeRows,
      onSelection: updateSelection, onCount: updateCount,
    });
    table = grid.table;
    tableReady = grid.ready;
    controls = bindTableControls(table, workingTracks, () => state.coverage.audio > 0);
  }
  return tableReady;
}
function updateHeader() {
  if (!state.meta) return;
  const { audio, tempo } = state.coverage;
  $('sourceLabel').textContent = { spotify: 'Spotify library', csv: 'CSV import', enriched: 'Spotify + Exportify' }[state.source];
  $('playlistTitle').textContent = state.meta.name;
  const info = [state.meta.owner, state.order.length.toLocaleString() + ' tracks'];
  if (state.durationKnown) {
    const minutes = Math.floor(state.duration / 60000);
    info.push(minutes >= 60 ? Math.floor(minutes / 60) + ' hr ' + (minutes % 60) + ' min' : minutes + ' min');
  }
  $('playlistMeta').textContent = info.filter(Boolean).join('  ·  ');
  $('trackNotice').hidden = audio > 0 && tempo === state.order.length;
  $('trackNoticeText').textContent = audio
    ? tempo + ' of ' + state.order.length + ' tracks have BPM. Import a CSV to fill gaps.'
    : 'Import an Exportify CSV for tempo, Mix Assist, and outlier detection.';
  $('undoBtn').disabled = !state.past.length;
  $('redoBtn').disabled = !state.future.length;
  $('exportBtn').disabled = !state.tracks.length;
  $('reloadPlaylistBtn').hidden = !state.meta.id;
}
function measure(rows) {
  state.coverage = analysis.getAudioCoverage(rows);
  state.duration = 0; state.durationKnown = false;
  for (const row of rows) {
    if (Number.isFinite(row.durationMs)) { state.duration += row.durationMs; state.durationKnown = true; }
  }
}
function indexRows() {
  const rows = workingTracks();
  rows.forEach((track, i) => { track.customOrder = i + 1; });
  return rows;
}
async function installDataset(meta, tracks, source, snapshot = {}) {
  const version = ++revision;
  state.meta = meta; state.source = source; state.tracks = prepareRows(tracks);
  state.order = snapshot.order ?? state.tracks.map((track) => track.rowId);
  state.past = snapshot.past || []; state.future = snapshot.future || [];
  const rows = indexRows();
  measure(rows);
  panels.invalidate(); updateHeader();
  library.select(meta.id || null, meta.id ? '' : meta.name);
  chooseView('tracks');
  await ensureGrid();
  if (version !== revision) return;
  if (snapshot.columnLayout?.length) table.setColumnLayout(snapshot.columnLayout);
  else controls.setColumns(defaultColumns(state.coverage.audio > 0));
  controls.restore(snapshot.tableFilters);
  if (table.getSorters().length) table.clearSort();
  await table.setData(rows);
  if (version !== revision) return;
  if (snapshot.sort?.length) table.setSort(snapshot.sort);
  if (snapshot.mixOptions) panels.restoreOptions(snapshot.mixOptions);
  updateCount(table.getDataCount('active'));
  if (snapshot.view && snapshot.view !== 'tracks') chooseView(snapshot.view);
}
function closeDataset() {
  revision++;
  state.meta = null; state.tracks = []; state.order = []; state.past = []; state.future = [];
  state.coverage = { audio: 0, tempo: 0, genres: 0 };
  library.select(null, ''); panels.invalidate();
  chooseView('tracks');
  if (table?.initialized) { controls.restore(); table.clearData(); }
}
function applyOrder(order, label, record = true) {
  if (record) {
    state.past.push({ order: state.order, label });
    if (state.past.length > 50) state.past.shift();
    state.future = [];
  }
  const changedMembership = state.order.length !== order.length;
  state.order = order;
  revision++;
  const rows = indexRows();
  if (changedMembership) measure(rows);
  panels.invalidate(state.view === 'analyze');
  if (table.getSorters().length) table.clearSort();
  table.setData(rows);
  updateHeader(); updateCount(table.getDataCount('active'));
  if (state.view === 'mix') panels.showMix();
  if (state.view === 'analyze') panels.showAnalyzer();
  notify(label);
}
function removeRows(ids) {
  const remove = new Set(ids);
  if (!remove.size || !state.meta) return;
  const next = state.order.filter((id) => !remove.has(id));
  if (next.length !== state.order.length) applyOrder(next, 'Removed ' + (state.order.length - next.length) + ' track(s).');
}
function history(back) {
  const from = back ? state.past : state.future;
  if (!from.length || !state.meta) return;
  const item = from.pop();
  (back ? state.future : state.past).push({ order: state.order, label: item.label });
  applyOrder(item.order, (back ? 'Undid' : 'Redid') + ' the last edit.', false);
}
function busy(title, detail) { $('busyOverlayTitle').textContent = title; $('busyOverlayStatus').textContent = detail; showDialog('busyOverlay'); }
async function sequence(action, options) {
  const tracks = visibleTracks();
  if (tracks.length < 2) return;
  const version = revision;
  busy('Sequencing playlist', 'Comparing ' + tracks.length.toLocaleString() + ' visible tracks…');
  try {
    const ordered = await runWorker({ action, tracks, options });
    if (version !== revision) return;
    const visible = new Set(ordered);
    let i = 0;
    applyOrder(state.order.map((id) => visible.has(id) ? ordered[i++] : id),
      action === 'genre' ? 'Applied genre sequence.' : 'Applied Mix Assist order.');
  } catch (error) { notify(error.message, true); }
  finally { $('busyOverlay').close(); }
}

function openImport(failed = false) {
  if (!failed) {
    status('csvImportStatus');
    $('importMode').value = state.meta?.id ? 'enrich' : 'new';
  }
  $('importModeField').hidden = !state.meta?.id;
  $('copyPlaylistName').hidden = !state.meta?.id;
  importContext();
  showDialog('csvImportModal');
}
function importContext() {
  $('importContext').textContent = state.meta?.id && $('importMode').value === 'enrich'
    ? 'Match recordings in “' + state.meta.name + '” by Spotify URI and keep your working order.'
    : 'The CSV opens as its own working playlist.';
}
async function importFile(file) {
  if (!file) return;
  const enrich = !!state.meta?.id && $('importMode').value === 'enrich';
  const desiredView = state.view;
  const ticket = ++request;
  $('csvImportModal').close();
  busy('Importing CSV', file.name);
  try {
    const imported = await runWorker({ action: 'csv', file });
    if (ticket !== request) return;
    if (enrich) {
      const result = enrichTracks(state.tracks, imported);
      if (!result.matched) throw new Error('No matching Spotify track URIs with extra metadata. Choose the same playlist export or open this CSV as a separate playlist.');
      const hadAudio = state.coverage.audio > 0;
      state.tracks = prepareRows(result.tracks); state.source = 'enriched'; revision++;
      const rows = indexRows(); measure(rows); panels.invalidate();
      if (!hadAudio && state.coverage.audio) controls.setColumns(new Set([...controls.visibleColumns(), 'bpm', 'keyModeLabel', 'genreDisplay']));
      await table.replaceData(rows);
      updateHeader(); chooseView(desiredView);
      notify('CSV matched ' + result.matched + ' of ' + state.tracks.length + ' original playlist entries.');
    } else {
      const name = file.name.replace(/\.csv$/i, '').replace(/_/g, ' ');
      await installDataset({ name }, imported, 'csv', { view: desiredView });
      notify('Imported ' + imported.length.toLocaleString() + ' tracks. ' + state.coverage.tempo.toLocaleString() + ' have BPM.');
    }
  } catch (error) {
    $('busyOverlay').close();
    if (ticket === request) { openImport(true); status('csvImportStatus', error.message, true); }
  } finally { $('csvFileInput').value = ''; if ($('busyOverlay').open) $('busyOverlay').close(); }
}

async function loadPlaylists() {
  const ticket = ++libraryRequest;
  if (!state.authenticated) { state.playlists = []; library.setPlaylists([]); return; }
  const lists = await api.fetchCurrentUserPlaylists();
  if (ticket !== libraryRequest) return;
  state.playlists = lists;
  library.setPlaylists(lists);
  if (state.view === 'compare') comparison.show();
}
async function loadPlaylist(id) {
  const ticket = ++request;
  mobileLibrary(false);
  const name = state.playlists.find((p) => p.id === id)?.name || 'playlist';
  notify('Loading ' + name + '…');
  try {
    const result = await api.fetchPlaylistWithMetadata(id, (event) => {
      if (ticket === request && event.message) notify(event.message);
    });
    if (ticket !== request) return;
    await installDataset(result.playlist, result.tracks, 'spotify');
    if (ticket !== request) return;
    notify('Loaded ' + result.tracks.length.toLocaleString() + ' tracks.');
    state.playlists = state.playlists.map((p) => p.id === id ? { ...p, totalTracks: result.tracks.length } : p);
    library.setPlaylists(state.playlists);
  } catch (error) {
    if (ticket === request) notify(String(error.message).includes('403')
      ? 'Spotify denied access to this playlist. Try an Exportify CSV or choose another playlist.' : error.message, true);
  }
}

function accountUI() {
  state.authenticated = auth.getAuthState().authenticated;
  const display = state.user?.display_name || state.user?.id || 'Connected';
  $('authStatus').textContent = state.authenticated ? display : 'Disconnected';
  $('connectionDot').classList.toggle('online', state.authenticated);
  $('loginBtn').hidden = state.authenticated;
  $('logoutBtn').hidden = !state.authenticated;
  $('welcomeSpotify').textContent = state.authenticated ? 'Browse library →' : 'Connect Spotify →';
  $('refreshPlaylistsBtn').disabled = !state.authenticated;
  library.setAccount(state.authenticated ? state.user?.id || null : null);
}
function openSetup() {
  setupExport = null;
  const setup = auth.getSetupState();
  $('setupClientId').value = '';
  $('setupClientId').placeholder = setup.hasClientId ? 'Saved · ' + setup.clientIdMasked : 'Paste your Spotify Client ID';
  $('setupRedirectUri').value = setup.redirectUri;
  $('setupRedirectHintInline').textContent = setup.redirectUri;
  $('setupGuide').open = !setup.hasClientId;
  status('setupModalStatus');
  showDialog('setupModal');
}
function saveSetup() {
  const saved = auth.getSavedSetupConfig();
  const clientId = $('setupClientId').value.trim() || saved.clientId;
  const redirectUri = $('setupRedirectUri').value.trim();
  const validated = auth.testSetupConfig({ clientId, redirectUri });
  auth.saveSetup({ clientId, redirectUri: validated.redirectUri });
  $('setupClientId').value = '';
  $('setupClientId').placeholder = 'Saved · ' + validated.clientIdMasked;
  $('setupRedirectHintInline').textContent = validated.redirectUri;
  status('setupModalStatus', 'Settings saved. You can connect Spotify.');
}
async function connect(fromSettings = false, exportAfterLogin = null) {
  if (state.authenticated) {
    if (matchMedia('(max-width:800px)').matches) mobileLibrary(true);
    else $('playlistSearch').focus();
    return;
  }
  try {
    if (fromSettings) { exportAfterLogin = setupExport; saveSetup(); }
    if (!auth.getSetupState().hasClientId) { openSetup(); setupExport = exportAfterLogin; return; }
    const comparisonDraft = comparison.snapshot();
    if (state.meta || state.view === 'compare' || comparisonDraft) {
      const draft = state.meta ? { meta: state.meta, source: state.source, tracks: state.tracks, order: state.order,
        past: state.past, future: state.future, view: state.view, mixOptions: panels.options(),
        columnLayout: table.getColumns().map((column) => ({ field: column.getField(), width: column.getWidth(), visible: column.isVisible() })),
        tableFilters: controls.snapshot(), sort: table.getSorters().map((s) => ({ column: s.field, dir: s.dir })) } : { view: state.view };
      if (comparisonDraft) draft.comparison = comparisonDraft;
      if (exportAfterLogin) draft.exportReview = exportAfterLogin;
      await saveLoginDraft(draft);
    }
    notify('Connecting to Spotify…');
    await auth.beginLogin();
  } catch (error) {
    if (!$('setupModal').open) openSetup();
    setupExport = exportAfterLogin;
    status('setupModalStatus', error.message, true);
  }
}
function reviewExport() {
  if (!state.meta) return;
  const tracks = visibleTracks();
  const uris = tracks.map(spotifyTrackUri).filter(Boolean);
  const skipped = tracks.length - uris.length;
  const source = '“' + state.meta.name + '”';
  const hidden = state.order.length - tracks.length;
  const review = { uris, skipped, preferredId: state.meta.id, baseSnapshot: state.meta.snapshotId,
    allowEmpty: !!state.tracks.length && !state.order.length, name: state.meta.name + ' - export',
    sourceDescription: uris.length.toLocaleString() + (uris.length === 1 ? ' track from ' : ' tracks from ') + source + ' in displayed order.' +
      (hidden ? ' Filters exclude ' + hidden.toLocaleString() + ' working entries.' : ''),
    summary: 'Create a private playlist with ' + uris.length +
    (uris.length === 1 ? ' track' : ' tracks') + ' in the visible table order.' +
    (skipped ? ' Skipping ' + skipped + ' without a valid Spotify track URI.' : '') };
  if (hidden) {
    const all = workingTracks().map(spotifyTrackUri).filter(Boolean);
    review.full = { uris: all, skipped: state.order.length - all.length,
      sourceDescription: 'The whole working playlist from ' + source + ' in working order, including tracks hidden by filters.' };
  }
  openExportReview(review);
}
function saveComparison(uris, name) {
  if (!uris.length) return;
  const selected = uris.length.toLocaleString() + (uris.length === 1 ? ' selected recording' : ' selected recordings') + ' in comparison order.';
  openExportReview({ uris, name, sourceDescription: 'From Compare · ' + selected, summary: 'Create a private playlist with ' + selected });
}
function openExportReview(review) {
  if (state.authenticated) saver.open(review);
  else connect(false, review);
}
function updateLibraryPlaylist(playlist) {
  // Discard an older library refresh if a save or live review has overtaken it.
  libraryRequest++;
  const index = state.playlists.findIndex((p) => p.id === playlist.id);
  if (index < 0) state.playlists.unshift(playlist);
  else state.playlists[index] = { ...state.playlists[index], ...playlist };
  library.setPlaylists(state.playlists);
  if (state.view === 'compare') comparison.show();
}

function debugControls() {
  function render() {
    $('toggleDebugBtn').textContent = getDebugState() ? 'Debug on' : 'Debug off';
    if ($('debugPanel').open) $('debugLogOutput').textContent = getDebugLogEntries().map((e) =>
      '[' + e.stamp + '] ' + e.scope + ' · ' + e.event + ' ' + JSON.stringify(e.payload ?? '')).join('\n');
  }
  subscribeDebugLogs(() => { if ($('setupModal').open && $('debugPanel').open) render(); });
  $('debugPanel').ontoggle = render;
  $('toggleDebugBtn').onclick = () => { setDebugState(!getDebugState()); render(); };
  $('copyDebugLogBtn').onclick = () => copy($('debugLogOutput').textContent, 'setupModalStatus');
  $('clearDebugLogBtn').onclick = () => { clearDebugLogEntries(); render(); };
  window.SpotifyManagerDebug = {
    get enabled() { return getDebugState(); }, setEnabled: setDebugState, entries: getDebugLogEntries,
    clear: clearDebugLogEntries, showPanel() { openSetup(); $('debugPanel').open = true; },
    hidePanel() { $('debugPanel').open = false; },
    snapshot: () => ({ debugEnabled: getDebugState(), sourceMode: state.source, selectedPlaylistId: state.meta?.id,
      workingTracks: state.order.length, renderedTracks: table?.getDataCount('active') || 0, tableInitialized: !!table?.initialized, tableReadyPending: !!tableReady && !table?.initialized }),
  };
}
async function copy(text, id) {
  try { await navigator.clipboard.writeText(text); status(id, 'Copied to clipboard.'); }
  catch { status(id, 'Clipboard unavailable. Select the text to copy it.', true); }
}
function bind() {
  document.addEventListener('click', (event) => {
    const element = event.target.closest('button, [data-view]');
    const menu = document.querySelector('.tools-menu');
    if (!event.target.closest('.tools-menu') || element?.closest('.menu-items')) menu.open = false;
    if (!element) return;
    if (element.hasAttribute('data-close')) { element.closest('dialog').close(); return; }
    if (element.dataset.view) { chooseView(element.dataset.view); return; }
    if (element.dataset.action === 'library') mobileLibrary(!document.body.classList.contains('library-open'));
    if (element.dataset.action === 'import') openImport();
    if (element.dataset.action === 'connect') connect();
  });
  $('busyOverlay').oncancel = (event) => event.preventDefault();
  $('openSetupWizardBtn').onclick = openSetup;
  $('createEnvBtn').onclick = () => { try { saveSetup(); } catch (e) { status('setupModalStatus', e.message, true); } };
  $('setupRedirectHintInline').onclick = () => copy($('setupRedirectUri').value, 'setupModalStatus');
  $('loginBtn').onclick = () => connect(true);
  $('logoutBtn').onclick = () => {
    auth.logout(); request++; libraryRequest++; state.user = null; state.playlists = []; accountUI();
    comparison.signOut(state.source === 'csv');
    if (state.source !== 'csv') closeDataset();
    else if (state.view === 'compare') comparison.show();
    $('setupModal').close(); notify('Signed out.');
  };
  $('refreshPlaylistsBtn').onclick = () => loadPlaylists().then(() => notify('Library refreshed.'), (e) => notify(e.message, true));
  $('reloadPlaylistBtn').onclick = () => { if (state.meta?.id) loadPlaylist(state.meta.id); };
  $('importMode').onchange = importContext;
  $('copyPlaylistName').onclick = () => copy(state.meta.name, 'csvImportStatus');
  $('csvDropzone').onclick = () => $('csvFileInput').click();
  $('csvFileInput').onchange = () => importFile($('csvFileInput').files[0]);
  const zone = $('csvDropzone');
  zone.ondragover = (e) => { e.preventDefault(); zone.classList.add('dragging'); };
  zone.ondragleave = () => zone.classList.remove('dragging');
  zone.ondrop = (e) => { e.preventDefault(); zone.classList.remove('dragging'); importFile(e.dataTransfer.files[0]); };
  $('shuffleBtn').onclick = () => applyOrder(analysis.shufflePasses(state.order, 1), 'Shuffled the working playlist.');
  $('resetOrderBtn').onclick = () => { controls.restore(); applyOrder(state.tracks.map((t) => t.rowId), 'Restored the original tracklist.'); };
  $('removeSelectedBtn').onclick = () => removeRows(table.getSelectedData().map((t) => t.rowId));
  $('undoBtn').onclick = () => history(true); $('redoBtn').onclick = () => history(false);
  $('exportBtn').onclick = reviewExport;
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && document.body.classList.contains('library-open')) { mobileLibrary(false); return; }
    if (!state.meta || state.view === 'compare' || document.querySelector('dialog[open]') || event.target.closest('input,textarea,select,[contenteditable=true]')) return;
    const key = event.key.toLowerCase();
    if (key === 'delete' && state.view === 'tracks') { event.preventDefault(); $('removeSelectedBtn').click(); }
    if ((event.ctrlKey || event.metaKey) && (key === 'z' || key === 'y')) { event.preventDefault(); history(key === 'z' && !event.shiftKey); }
  });
}
async function init() {
  if (auth.ensureCanonicalLoopbackOrigin()?.redirected) return;
  let initialWeights = analysis.DEFAULT_WEIGHTS;
  try {
    const config = await fetch(new URL('../../config/mix-weights.json', import.meta.url));
    if (config.ok) initialWeights = await config.json();
  } catch { /* The built-in Beatmatch weights are identical to the shipped configuration. */ }
  panels = bindAnalysisPanels({ visibleTracks, workingTracks, hasPlaylist: () => !!state.meta, removeRows, sequence, initialWeights });
  library = bindLibrary({ load: loadPlaylist, showTracks: () => chooseView('tracks') });
  saver = bindSpotifySave({ context: () => ({ user: state.user, playlists: state.playlists }), updatePlaylist: updateLibraryPlaylist });
  comparison = bindComparison({ context: () => ({ meta: state.meta, playlists: state.playlists, revision,
    libraryRevision: libraryRequest, authenticated: state.authenticated }), workingTracks,
    readSpotify: api.fetchComparisonTracks, save: saveComparison });
  bind(); debugControls(); chooseView('tracks'); accountUI();
  try {
    try { await auth.handleAuthCallback(); } catch (error) { notify(error.message, true); }
    await auth.tryAutoRefresh();
    if (auth.getAuthState().authenticated) state.user = await auth.loadCurrentUser();
    accountUI();
  } catch (error) { notify(error.message, true); }
  let restoreCompare = false, exportReview;
  try {
    await restoreLoginDraft(async (d) => {
      restoreCompare = d.view === 'compare';
      if (d.meta) await installDataset(d.meta, d.tracks, d.source, restoreCompare ? { ...d, view: 'tracks' } : d);
      if (d.comparison) comparison.restore(d.comparison);
      exportReview = d.exportReview;
    });
  }
  catch (error) { notify('Could not reopen the playlist after sign-in. ' + error.message, true); }
  try { await loadPlaylists(); }
  finally {
    if (restoreCompare) chooseView('compare');
    if (state.authenticated && exportReview?.uris) openExportReview(exportReview);
  }
  log('ready', { authenticated: state.authenticated });
}
init().catch((error) => notify(error.message, true));
