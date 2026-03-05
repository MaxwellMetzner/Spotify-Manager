const analysis = window.PlaylistAnalysis;

const STORAGE_KEYS = {
  filterPresets: 'spotifyManager.filterPresets.v1',
  weightPresets: 'spotifyManager.weightPresets.v1',
};

const VIRTUALIZATION_THRESHOLD = 250;
const ROW_HEIGHT = 29;
const OVERSCAN_ROWS = 16;

const FILTER_FIELD_IDS = [
  'filterTitle',
  'filterArtist',
  'filterGenre',
  'filterYearMin',
  'filterYearMax',
  'filterBpmMin',
  'filterBpmMax',
  'filterEnergyMin',
  'filterEnergyMax',
  'filterDanceMin',
  'filterDanceMax',
  'filterValenceMin',
  'filterValenceMax',
];

const state = {
  auth: null,
  user: null,
  playlists: [],
  selectedPlaylistId: null,
  selectedPlaylistMeta: null,
  baseTracks: [],
  workingTracks: [],
  filteredTracks: [],
  filterActive: false,
  duplicateReport: null,
  renderTracks: [],
  filterPresets: {},
  weightPresets: {},
};

const columns = [
  ['customOrder', 'Order'],
  ['title', 'Title'],
  ['artistDisplay', 'Artists'],
  ['albumName', 'Album'],
  ['albumReleaseDate', 'Album Date'],
  ['albumReleaseYear', 'Year'],
  ['addedAt', 'Added At'],
  ['addedBy', 'Added By'],
  ['bpm', 'BPM'],
  ['camelot', 'Camelot'],
  ['energy', 'Energy'],
  ['danceability', 'Danceability'],
  ['valence', 'Valence'],
  ['loudness', 'Loudness'],
  ['acousticness', 'Acousticness'],
  ['instrumentalness', 'Instrumentalness'],
  ['speechiness', 'Speechiness'],
  ['liveness', 'Liveness'],
  ['keyModeLabel', 'Key/Mode'],
  ['timeSignature', 'Time Sig'],
  ['popularity', 'Popularity'],
  ['genreDisplay', 'Genres'],
  ['durationSeconds', 'Seconds'],
  ['explicit', 'Explicit'],
  ['isrc', 'ISRC'],
  ['analysisAvailable', 'Analysis URL?'],
  ['uri', 'URI'],
];

const sortFields = columns.map(([field, label]) => ({ field, label }));

function get(id) {
  return document.getElementById(id);
}

function setMessage(text, isError = false) {
  const el = get('messages');
  el.textContent = text;
  el.style.color = isError ? '#ff9175' : '#9fd6c5';
}

function fmt(value, digits = 3) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') {
    if (Number.isInteger(value)) return String(value);
    return value.toFixed(digits);
  }
  if (Array.isArray(value)) return value.join(', ');
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  return String(value);
}

function loadObjectFromStorage(storageKey) {
  try {
    const raw = localStorage.getItem(storageKey);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return parsed;
  } catch {
    return {};
  }
}

function saveObjectToStorage(storageKey, payload) {
  localStorage.setItem(storageKey, JSON.stringify(payload));
}

function refreshPresetSelect(selectId, presets, placeholder) {
  const select = get(selectId);
  const names = Object.keys(presets).sort((a, b) => a.localeCompare(b));
  const options = [`<option value="">${placeholder}</option>`];
  names.forEach((name) => options.push(`<option value="${name}">${name}</option>`));
  select.innerHTML = options.join('');
}

function syncPresetStateFromStorage() {
  state.filterPresets = loadObjectFromStorage(STORAGE_KEYS.filterPresets);
  state.weightPresets = loadObjectFromStorage(STORAGE_KEYS.weightPresets);
  refreshPresetSelect('filterPresetSelect', state.filterPresets, 'Choose filter preset');
  refreshPresetSelect('weightPresetSelect', state.weightPresets, 'Choose weights preset');
}

function renderSortFields() {
  const select = get('sortField');
  select.innerHTML = sortFields
    .map((entry) => `<option value="${entry.field}">${entry.label}</option>`)
    .join('');
}

function buildRow(track, absoluteIndex) {
  const cells = columns.map(([field]) => `<td>${fmt(track[field])}</td>`).join('');
  const parityClass = absoluteIndex % 2 === 0 ? 'row-even' : '';
  return `<tr class="${parityClass}">${cells}</tr>`;
}

function renderVisibleRows() {
  const body = get('tracksTableBody');
  const hint = get('virtualizationHint');
  const wrap = get('tracksTableWrap');
  const tracks = state.renderTracks;

  if (!tracks.length) {
    hint.textContent = 'No tracks to display.';
    body.innerHTML = '';
    return;
  }

  if (tracks.length < VIRTUALIZATION_THRESHOLD) {
    hint.textContent = `Rendering all ${tracks.length} rows.`;
    body.innerHTML = tracks.map((track, index) => buildRow(track, index)).join('');
    return;
  }

  const viewportHeight = wrap.clientHeight || 600;
  const start = Math.max(0, Math.floor(wrap.scrollTop / ROW_HEIGHT) - OVERSCAN_ROWS);
  const visibleCount = Math.ceil(viewportHeight / ROW_HEIGHT) + OVERSCAN_ROWS * 2;
  const end = Math.min(tracks.length, start + visibleCount);

  const topPad = start * ROW_HEIGHT;
  const bottomPad = (tracks.length - end) * ROW_HEIGHT;

  const rows = [];
  if (topPad > 0) {
    rows.push(
      `<tr class="pad-row"><td colspan="${columns.length}" style="height:${topPad}px"></td></tr>`
    );
  }
  for (let index = start; index < end; index += 1) {
    rows.push(buildRow(tracks[index], index));
  }
  if (bottomPad > 0) {
    rows.push(
      `<tr class="pad-row"><td colspan="${columns.length}" style="height:${bottomPad}px"></td></tr>`
    );
  }

  body.innerHTML = rows.join('');
  hint.textContent = `Virtualized ${tracks.length} rows. Showing ${start + 1}-${end}.`;
}

function renderTable(tracks, options = {}) {
  const { resetScroll = true } = options;
  const head = get('tracksHeadRow');
  head.innerHTML = columns.map(([, label]) => `<th>${label}</th>`).join('');

  state.renderTracks = tracks;
  if (resetScroll) {
    get('tracksTableWrap').scrollTop = 0;
  }
  renderVisibleRows();
}

function selectedTracks() {
  return state.filterActive ? state.filteredTracks : state.workingTracks;
}

function getCurrentFilterSnapshot() {
  const snapshot = {};
  FILTER_FIELD_IDS.forEach((id) => {
    snapshot[id] = get(id).value;
  });
  return snapshot;
}

function applyFilterSnapshot(snapshot) {
  FILTER_FIELD_IDS.forEach((id) => {
    get(id).value = snapshot?.[id] ?? '';
  });
}

function applyCurrentFilters() {
  const filters = [];
  const addContains = (field, elementId) => {
    const value = get(elementId).value.trim();
    if (value) filters.push({ field, kind: 'contains', query: value });
  };
  const addRange = (field, minId, maxId) => {
    const min = get(minId).value.trim();
    const max = get(maxId).value.trim();
    if (min || max) filters.push({ field, kind: 'range', min, max });
  };

  addContains('title', 'filterTitle');
  addContains('artistDisplay', 'filterArtist');
  addContains('genreDisplay', 'filterGenre');

  const yearMin = get('filterYearMin').value.trim();
  const yearMax = get('filterYearMax').value.trim();
  if (yearMin || yearMax) {
    filters.push({ field: 'albumReleaseYear', kind: 'yearRange', min: yearMin, max: yearMax });
  }

  addRange('bpm', 'filterBpmMin', 'filterBpmMax');
  addRange('energy', 'filterEnergyMin', 'filterEnergyMax');
  addRange('danceability', 'filterDanceMin', 'filterDanceMax');
  addRange('valence', 'filterValenceMin', 'filterValenceMax');

  state.filterActive = filters.length > 0;
  state.filteredTracks = analysis.applyFilters(state.workingTracks, filters);

  const shown = selectedTracks();
  get('filterCount').textContent = state.filterActive
    ? `Filtered tracks: ${shown.length}`
    : `Filtered tracks: 0`;
  renderTable(shown);
}

function renderPlaylists() {
  const list = get('playlistList');
  list.innerHTML = state.playlists
    .map((playlist) => {
      const active = playlist.id === state.selectedPlaylistId ? 'active' : '';
      return `<li><button class="${active}" data-playlist-id="${playlist.id}">${playlist.name} <span class="subtle">(${playlist.totalTracks})</span></button></li>`;
    })
    .join('');

  list.querySelectorAll('button[data-playlist-id]').forEach((button) => {
    button.addEventListener('click', () => loadPlaylist(button.dataset.playlistId));
  });
}

function renderAuthState() {
  const auth = state.auth;
  get('authStatus').textContent = auth?.authenticated ? 'Connected' : 'Disconnected';
  get('loginBtn').disabled = Boolean(auth?.authenticated);
  get('logoutBtn').disabled = !auth?.authenticated;
}

function renderPlaylistHeader() {
  if (!state.selectedPlaylistMeta) return;
  const p = state.selectedPlaylistMeta;
  get('playlistTitle').textContent = p.name;
  get('playlistMeta').textContent = `${p.owner} | ${p.totalTracks} tracks | followers: ${p.followers ?? 'n/a'}`;
}

function reindexWorkingTracks() {
  state.workingTracks.forEach((track, index) => {
    track.customOrder = index;
  });
}

function rerenderTrackViews() {
  if (state.filterActive) {
    applyCurrentFilters();
    return;
  }
  renderTable(state.workingTracks);
}

async function refreshAuthAndUser() {
  state.auth = await window.spotifyManager.authState();
  renderAuthState();

  if (state.auth.authenticated) {
    state.user = await window.spotifyManager.getUser();
    get('userLabel').textContent = `${state.user.display_name || state.user.id}`;
  } else {
    state.user = null;
    get('userLabel').textContent = '';
  }
}

async function loadPlaylists() {
  if (!state.auth?.authenticated) {
    state.playlists = [];
    renderPlaylists();
    return;
  }
  state.playlists = await window.spotifyManager.getPlaylists();
  renderPlaylists();
}

async function loadPlaylist(playlistId) {
  state.selectedPlaylistId = playlistId;
  setMessage('Loading playlist metadata...');
  const payload = await window.spotifyManager.getPlaylistDetails(playlistId);
  state.selectedPlaylistMeta = payload.playlist;
  state.baseTracks = payload.tracks.map((track, index) => ({ ...track, customOrder: index }));
  state.workingTracks = [...state.baseTracks];
  state.filteredTracks = [];
  state.filterActive = false;
  state.duplicateReport = null;
  applyFilterSnapshot({});
  get('filterCount').textContent = 'Filtered tracks: 0';
  renderPlaylists();
  renderPlaylistHeader();
  renderTable(state.workingTracks);
  renderDuplicates();
  setMessage(`Loaded ${state.workingTracks.length} tracks with metadata.`);
}

function resetToOriginalOrder() {
  state.workingTracks = [...state.baseTracks];
  reindexWorkingTracks();
  state.filteredTracks = [];
  state.filterActive = false;
  applyFilterSnapshot({});
  renderTable(state.workingTracks);
  get('filterCount').textContent = 'Filtered tracks: 0';
  setMessage('Reset to original Spotify order.');
}

function parseWeights() {
  const raw = get('weightsInput').value;
  if (!raw.trim()) return analysis.DEFAULT_WEIGHTS;
  try {
    const parsed = JSON.parse(raw);
    return { ...analysis.DEFAULT_WEIGHTS, ...parsed };
  } catch (error) {
    throw new Error(`Invalid weights JSON: ${error.message}`);
  }
}

function renderOutliers() {
  const report = analysis.detectOutliers(state.workingTracks).slice(0, 12);
  const html = report
    .map(
      ({ track, outlierScore, reasons }) =>
        `<div><strong>${track.title}</strong> - ${track.artistDisplay} | score: ${outlierScore}<br/>${
          reasons.length ? reasons.join(' ') : 'No strong reason labels.'
        }</div>`
    )
    .join('<hr/>');
  get('outliersResult').innerHTML = html || 'No outliers detected.';
}

function renderDuplicates() {
  if (!state.duplicateReport) {
    get('dedupeResults').textContent = 'No dedupe analysis run yet.';
    return;
  }
  const { exactGroups, nearGroups } = state.duplicateReport;
  const section = [];
  section.push(`<div>Exact duplicate groups: ${exactGroups.length}</div>`);
  exactGroups.forEach((group) => {
    section.push(
      `<div>${group
        .map((entry) => `${entry.track.title} (${entry.track.artistDisplay})`)
        .join(' | ')}</div>`
    );
  });
  section.push(`<div>Near duplicate groups: ${nearGroups.length}</div>`);
  nearGroups.forEach((group) => {
    section.push(
      `<div>${group
        .map((entry) => `${entry.track.title} (${entry.track.albumName || 'Unknown album'})`)
        .join(' | ')}</div>`
    );
  });
  get('dedupeResults').innerHTML = section.join('<hr/>');
}

function showNearDuplicateModal() {
  const modal = get('nearDuplicateModal');
  modal.classList.remove('hidden');
}

function hideNearDuplicateModal() {
  const modal = get('nearDuplicateModal');
  modal.classList.add('hidden');
}

function renderNearDuplicateModal() {
  const root = get('nearDuplicateGroups');
  if (!state.duplicateReport?.nearGroups?.length) {
    root.innerHTML = '<div class="subtle">No near-duplicate groups found for this playlist.</div>';
    return;
  }

  root.innerHTML = state.duplicateReport.nearGroups
    .map((group, groupIndex) => {
      const items = group
        .map((entry, trackIndex) => {
          const id = `nearDup-${groupIndex}-${trackIndex}`;
          return `
            <label class="modal-track-row" for="${id}">
              <input id="${id}" type="checkbox" data-group-index="${groupIndex}" data-track-index="${trackIndex}" checked />
              <span>${entry.track.title} - ${entry.track.artistDisplay} | ${entry.track.albumName || 'Unknown album'}</span>
            </label>
          `;
        })
        .join('');
      return `
        <div class="modal-group">
          <strong>Group ${groupIndex + 1}</strong>
          ${items}
        </div>
      `;
    })
    .join('');
}

function applyNearDuplicateChoices() {
  if (!state.duplicateReport?.nearGroups?.length) {
    hideNearDuplicateModal();
    return;
  }

  const unchecked = Array.from(
    get('nearDuplicateGroups').querySelectorAll('input[type="checkbox"]:not(:checked)')
  );
  const removeSet = new Set();

  unchecked.forEach((checkbox) => {
    const groupIndex = Number(checkbox.dataset.groupIndex);
    const trackIndex = Number(checkbox.dataset.trackIndex);
    const entry = state.duplicateReport?.nearGroups?.[groupIndex]?.[trackIndex];
    if (entry?.track) {
      removeSet.add(entry.track);
    }
  });

  if (!removeSet.size) {
    setMessage('No near-duplicate tracks were removed.');
    hideNearDuplicateModal();
    return;
  }

  state.workingTracks = state.workingTracks.filter((track) => !removeSet.has(track));
  reindexWorkingTracks();
  state.duplicateReport = analysis.findDuplicates(state.workingTracks);
  renderDuplicates();
  rerenderTrackViews();
  hideNearDuplicateModal();
  setMessage(`Removed ${removeSet.size} near-duplicate track(s).`);
}

async function saveOrderToSpotify() {
  if (!state.selectedPlaylistId || !state.workingTracks.length) return;
  const uris = state.workingTracks.map((track) => track.uri).filter(Boolean);
  await window.spotifyManager.reorderPlaylist(state.selectedPlaylistId, uris);
  setMessage('Saved current order to Spotify playlist.');
}

async function createPlaylistFromFiltered() {
  if (!state.selectedPlaylistId) return;
  applyCurrentFilters();
  if (!state.filteredTracks.length) {
    setMessage('No tracks match current filters.', true);
    return;
  }

  const nameInput = get('newPlaylistName').value.trim();
  const defaultName = `${state.selectedPlaylistMeta?.name || 'Playlist'} - filtered`;
  const name = nameInput || defaultName;

  const result = await window.spotifyManager.createPlaylist({
    name,
    description: 'Filtered with Spotify Manager',
    public: false,
    trackUris: state.filteredTracks.map((track) => track.uri),
  });

  setMessage(`Created playlist: ${result.name}`);
}

function saveWeightPreset() {
  const name = get('weightPresetName').value.trim();
  if (!name) {
    setMessage('Enter a weight preset name first.', true);
    return;
  }
  const weights = parseWeights();
  state.weightPresets[name] = weights;
  saveObjectToStorage(STORAGE_KEYS.weightPresets, state.weightPresets);
  refreshPresetSelect('weightPresetSelect', state.weightPresets, 'Choose weights preset');
  get('weightPresetSelect').value = name;
  setMessage(`Saved weights preset: ${name}`);
}

function loadWeightPreset() {
  const name = get('weightPresetSelect').value;
  if (!name || !state.weightPresets[name]) {
    setMessage('Choose a weights preset to load.', true);
    return;
  }
  get('weightsInput').value = JSON.stringify(state.weightPresets[name], null, 2);
  setMessage(`Loaded weights preset: ${name}`);
}

function deleteWeightPreset() {
  const name = get('weightPresetSelect').value;
  if (!name || !state.weightPresets[name]) {
    setMessage('Choose a weights preset to delete.', true);
    return;
  }
  delete state.weightPresets[name];
  saveObjectToStorage(STORAGE_KEYS.weightPresets, state.weightPresets);
  refreshPresetSelect('weightPresetSelect', state.weightPresets, 'Choose weights preset');
  setMessage(`Deleted weights preset: ${name}`);
}

function saveFilterPreset() {
  const name = get('filterPresetName').value.trim();
  if (!name) {
    setMessage('Enter a filter preset name first.', true);
    return;
  }
  state.filterPresets[name] = getCurrentFilterSnapshot();
  saveObjectToStorage(STORAGE_KEYS.filterPresets, state.filterPresets);
  refreshPresetSelect('filterPresetSelect', state.filterPresets, 'Choose filter preset');
  get('filterPresetSelect').value = name;
  setMessage(`Saved filter preset: ${name}`);
}

function loadFilterPreset() {
  const name = get('filterPresetSelect').value;
  if (!name || !state.filterPresets[name]) {
    setMessage('Choose a filter preset to load.', true);
    return;
  }
  applyFilterSnapshot(state.filterPresets[name]);
  applyCurrentFilters();
  setMessage(`Loaded filter preset: ${name}`);
}

function deleteFilterPreset() {
  const name = get('filterPresetSelect').value;
  if (!name || !state.filterPresets[name]) {
    setMessage('Choose a filter preset to delete.', true);
    return;
  }
  delete state.filterPresets[name];
  saveObjectToStorage(STORAGE_KEYS.filterPresets, state.filterPresets);
  refreshPresetSelect('filterPresetSelect', state.filterPresets, 'Choose filter preset');
  setMessage(`Deleted filter preset: ${name}`);
}

async function analyzeAndPrepareDuplicates() {
  if (!state.workingTracks.length) return;
  state.duplicateReport = analysis.findDuplicates(state.workingTracks);
  renderDuplicates();
  renderNearDuplicateModal();
}

async function bindEvents() {
  get('loginBtn').addEventListener('click', async () => {
    try {
      setMessage('Opening Spotify sign-in...');
      await window.spotifyManager.login();
      await refreshAuthAndUser();
      await loadPlaylists();
      setMessage('Signed in successfully.');
    } catch (error) {
      setMessage(error.message, true);
    }
  });

  get('logoutBtn').addEventListener('click', async () => {
    await window.spotifyManager.logout();
    await refreshAuthAndUser();
    state.playlists = [];
    state.selectedPlaylistId = null;
    state.workingTracks = [];
    renderPlaylists();
    renderTable([]);
    setMessage('Signed out.');
  });

  get('refreshPlaylistsBtn').addEventListener('click', async () => {
    try {
      await loadPlaylists();
      setMessage('Playlists refreshed.');
    } catch (error) {
      setMessage(error.message, true);
    }
  });

  get('reloadPlaylistBtn').addEventListener('click', async () => {
    if (!state.selectedPlaylistId) return;
    try {
      await loadPlaylist(state.selectedPlaylistId);
    } catch (error) {
      setMessage(error.message, true);
    }
  });

  get('analyzeDuplicatesBtn').addEventListener('click', async () => {
    await analyzeAndPrepareDuplicates();
    const nearCount = state.duplicateReport?.nearGroups?.length || 0;
    setMessage(`Duplicate analysis complete. Near-duplicate groups: ${nearCount}.`);
    if (nearCount > 0) {
      showNearDuplicateModal();
    }
  });

  get('resolveNearDuplicatesBtn').addEventListener('click', async () => {
    if (!state.workingTracks.length) return;
    await analyzeAndPrepareDuplicates();
    showNearDuplicateModal();
  });

  get('applyExactDedupeBtn').addEventListener('click', async () => {
    if (!state.workingTracks.length) return;
    if (!state.duplicateReport) {
      await analyzeAndPrepareDuplicates();
    }
    state.workingTracks = analysis.dedupeKeepHighestPopularity(state.workingTracks, state.duplicateReport);
    reindexWorkingTracks();
    state.duplicateReport = analysis.findDuplicates(state.workingTracks);
    renderDuplicates();
    rerenderTrackViews();
    setMessage('Exact dedupe applied (kept highest popularity versions).');
  });

  get('shuffleBtn').addEventListener('click', () => {
    if (!state.workingTracks.length) return;
    const passes = Number(get('shufflePasses').value || 1);
    state.workingTracks = analysis.shufflePasses(state.workingTracks, passes);
    reindexWorkingTracks();
    rerenderTrackViews();
    setMessage(`Shuffled with ${passes} pass(es).`);
  });

  get('mixAssistBtn').addEventListener('click', () => {
    try {
      if (!state.workingTracks.length) return;
      const weights = parseWeights();
      state.workingTracks = analysis.optimizeMixOrder(state.workingTracks, weights);
      reindexWorkingTracks();
      rerenderTrackViews();
      setMessage('Mix Assist ordering complete.');
    } catch (error) {
      setMessage(error.message, true);
    }
  });

  get('outliersBtn').addEventListener('click', () => {
    if (!state.workingTracks.length) return;
    renderOutliers();
    setMessage('Outlier report generated.');
  });

  get('sortBtn').addEventListener('click', () => {
    if (!state.workingTracks.length) return;
    const field = get('sortField').value;
    const dir = get('sortDir').value;
    state.workingTracks = analysis.sortTracks(state.workingTracks, field, dir);
    reindexWorkingTracks();
    rerenderTrackViews();
    setMessage(`Sorted by ${field} (${dir}).`);
  });

  get('resetOrderBtn').addEventListener('click', resetToOriginalOrder);
  get('saveOrderBtn').addEventListener('click', () =>
    saveOrderToSpotify().catch((error) => setMessage(error.message, true))
  );

  FILTER_FIELD_IDS.forEach((id) => {
    get(id).addEventListener('input', applyCurrentFilters);
  });

  get('saveFilterPresetBtn').addEventListener('click', saveFilterPreset);
  get('loadFilterPresetBtn').addEventListener('click', loadFilterPreset);
  get('deleteFilterPresetBtn').addEventListener('click', deleteFilterPreset);

  get('saveWeightPresetBtn').addEventListener('click', () => {
    try {
      saveWeightPreset();
    } catch (error) {
      setMessage(error.message, true);
    }
  });
  get('loadWeightPresetBtn').addEventListener('click', loadWeightPreset);
  get('deleteWeightPresetBtn').addEventListener('click', deleteWeightPreset);

  get('createFilteredPlaylistBtn').addEventListener('click', () =>
    createPlaylistFromFiltered().catch((error) => setMessage(error.message, true))
  );

  get('closeNearDuplicateModalBtn').addEventListener('click', hideNearDuplicateModal);
  get('applyNearDuplicateChoicesBtn').addEventListener('click', applyNearDuplicateChoices);

  get('tracksTableWrap').addEventListener('scroll', renderVisibleRows);
}

async function init() {
  renderSortFields();
  syncPresetStateFromStorage();
  const savedWeights = await window.spotifyManager.getMixWeights();
  get('weightsInput').value = JSON.stringify(savedWeights || analysis.DEFAULT_WEIGHTS, null, 2);
  await bindEvents();
  try {
    await refreshAuthAndUser();
    await loadPlaylists();
  } catch (error) {
    setMessage(error.message, true);
  }
}

init();
