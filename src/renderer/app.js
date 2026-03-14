import * as auth from '../auth.js';
import * as api from '../spotifyApi.js';
import {
  clearDebugLogEntries,
  createLogger,
  getDebugLogEntries,
  getDebugState,
  setDebugState,
  subscribeDebugLogs,
} from '../debug.js';
import { applyTableData, createTableRenderQueue } from './tableView.js';

const analysis = window.PlaylistAnalysis;
const dlog = createLogger('renderer');

const STORAGE_KEYS = {
  weightPresets: 'spotifyManager.weightPresets.v2',
};

const DEFAULT_ARTIST_AVOIDANCE = {
  enabled: true,
  strength: 1,
};

const FILTER_FIELD_IDS = [
  'filterTitle',
  'filterArtist',
  'filterGenre',
  'filterKeyMode',
  'filterTimeSig',
  'filterDurationMsMin',
  'filterDurationMsMax',
  'filterBpmMin',
  'filterBpmMax',
  'filterTempoMin',
  'filterTempoMax',
  'filterEnergyMin',
  'filterEnergyMax',
  'filterDanceMin',
  'filterDanceMax',
  'filterValenceMin',
  'filterValenceMax',
  'filterLoudnessMin',
  'filterLoudnessMax',
  'filterAcousticMin',
  'filterAcousticMax',
  'filterInstrMin',
  'filterInstrMax',
  'filterSpeechMin',
  'filterSpeechMax',
  'filterLiveMin',
  'filterLiveMax',
  'filterPopularityMin',
  'filterPopularityMax',
  // Legacy inputs retained in hidden create panel for compatibility.
  'filterGenreLegacy',
  'filterBpmMinLegacy',
  'filterBpmMaxLegacy',
  'filterEnergyMinLegacy',
  'filterEnergyMaxLegacy',
  'filterDanceMinLegacy',
  'filterDanceMaxLegacy',
  'filterValenceMinLegacy',
  'filterValenceMaxLegacy',
];

const state = {
  setup: null,
  auth: null,
  user: null,
  playlists: [],
  playlistTrackCountHints: {},
  selectedPlaylistId: null,
  selectedPlaylistMeta: null,
  baseTracks: [],
  workingTracks: [],
  filteredTracks: [],
  filterActive: false,
  duplicateReport: null,
  renderTracks: [],
  weightPresets: {},
  history: {
    past: [],
    future: [],
  },
  columnConfig: {},
  tableSort: {
    field: null,
    direction: null,
  },
  filterNegations: {},
  sourceMode: 'spotify',
  inlineHeaderFilters: {},
  playlistLoadRequestId: 0,
  tableRenderRequestId: 0,
};

let tracksTable = null;
let tracksTableReady = null;
let tracksTableInitialized = false;
let duplicateAnalysisTimer = null;
const queueTableRender = createTableRenderQueue(async (tracks, options = {}) => {
  const { resetScroll = true, rebuildColumns = false } = options;
  const renderRequestId = state.tableRenderRequestId + 1;
  state.tableRenderRequestId = renderRequestId;
  const debugLabel = `render#${renderRequestId}`;
  dlog('renderTable:start', {
    debugLabel,
    rows: tracks?.length || 0,
    resetScroll,
    rebuildColumns,
    sourceMode: state.sourceMode,
    selectedPlaylistId: state.selectedPlaylistId,
    tableInitialized: tracksTableInitialized,
  });

  try {
    initializeTable(tracks);
    renderColumnControls();

    const activeTracks = await applyTableData({
      table: tracksTable,
      tracks: tracks || [],
      ready: tracksTableInitialized ? null : tracksTableReady,
      rebuildColumns,
      columns: rebuildColumns ? buildTabulatorColumns() : null,
      sort: state.tableSort,
      resetScroll,
      forceRedraw: rebuildColumns,
      getActiveData: getActiveTableData,
      log: dlog,
      debugLabel,
    });

    state.renderTracks = activeTracks;
    refreshHeaderFilterVisuals();
    dlog('renderTable:done', {
      debugLabel,
      rows: tracks?.length || 0,
      activeRows: activeTracks?.length || 0,
    });
    return activeTracks;
  } catch (error) {
    dlog('renderTable:error', {
      debugLabel,
      rows: tracks?.length || 0,
      message: String(error?.message || error),
    });
    throw error;
  }
}, { log: dlog, label: 'renderQueue' });

const MIX_WEIGHT_FIELDS = [
  ['bpm', 'BPM'],
  ['harmonic', 'Harmonic'],
  ['energy', 'Energy'],
  ['danceability', 'Danceability'],
  ['valence', 'Valence'],
  ['loudness', 'Loudness'],
  ['instrumentalness', 'Instrumentalness'],
  ['acousticness', 'Acousticness'],
  ['speechiness', 'Speechiness'],
  ['liveness', 'Liveness'],
  ['genre', 'Genre'],
];

const columns = [
  ['customOrder', 'Order'],
  ['title', 'Title'],
  ['artistDisplay', 'Artists'],
  ['albumName', 'Album'],
  ['recordLabel', 'Label'],
  ['albumReleaseDate', 'Album Date'],
  ['addedAt', 'Added At'],
  ['addedBy', 'Added By'],
  ['durationMs', 'Duration (ms)'],
  ['bpm', 'BPM'],
  ['tempo', 'Tempo'],
  ['key', 'Key'],
  ['mode', 'Mode'],
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
  ['uri', 'URI'],
];

const SPOTIFY_DEFAULT_COLUMNS = new Set([
  'customOrder',
  'title',
  'artistDisplay',
  'albumName',
  'albumReleaseDate',
  'addedAt',
  'addedBy',
  'durationMs',
]);

function buildDefaultColumnConfig() {
  const config = {};
  columns.forEach(([field]) => {
    config[field] = {
      visible: true,
      width: 140,
    };
  });
  config.title.width = 260;
  config.artistDisplay.width = 220;
  config.genreDisplay.width = 220;
  config.uri.visible = true;
  return config;
}

function applyColumnPresetForSource(mode) {
  dlog('applyColumnPresetForSource', { mode });
  if (mode === 'spotify') {
    columns.forEach(([field]) => {
      state.columnConfig[field].visible = SPOTIFY_DEFAULT_COLUMNS.has(field);
    });
  } else {
    columns.forEach(([field]) => {
      state.columnConfig[field].visible = true;
    });
  }
}

function setAdvancedTabsEnabled(enabled) {
  const mixTab = get('tabMix');
  const analyzeTab = get('tabAnalyze');
  if (!mixTab || !analyzeTab) return;
  mixTab.disabled = !enabled;
  analyzeTab.disabled = !enabled;
  mixTab.classList.toggle('disabled-tab', !enabled);
  analyzeTab.classList.toggle('disabled-tab', !enabled);

  if (!enabled && (mixTab.classList.contains('active') || analyzeTab.classList.contains('active'))) {
    get('tabHome').click();
  }
}

function setSourceMode(mode) {
  dlog('setSourceMode', { mode });
  state.sourceMode = mode;
  applyColumnPresetForSource(mode);
  renderColumnControls();
  setAdvancedTabsEnabled(mode !== 'spotify');
  if (tracksTable) {
    return renderCurrentView({ resetScroll: false, rebuildColumns: true });
  }
  return Promise.resolve();
}

function get(id) {
  return document.getElementById(id);
}

function cloneTracks(tracks) {
  if (typeof structuredClone === 'function') {
    return structuredClone(tracks || []);
  }
  return JSON.parse(JSON.stringify(tracks || []));
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function setPlaylistTrackCountHint(playlistId, totalTracks) {
  if (!playlistId || !Number.isFinite(totalTracks)) return;
  state.playlistTrackCountHints[playlistId] = totalTracks;
  if (state.selectedPlaylistId === playlistId && state.selectedPlaylistMeta) {
    state.selectedPlaylistMeta.totalTracks = totalTracks;
  }
}

function applyPlaylistTrackCountHints(playlists) {
  return (playlists || []).map((playlist) => {
    const hintedCount = state.playlistTrackCountHints[playlist.id];
    if (!Number.isFinite(hintedCount)) {
      return playlist;
    }
    const playlistCount = Number(playlist?.totalTracks);
    if (Number.isFinite(playlistCount) && playlistCount >= hintedCount) {
      return playlist;
    }
    return {
      ...playlist,
      totalTracks: hintedCount,
    };
  });
}

function upsertPlaylistSummary(summary) {
  if (!summary?.id) return;
  if (Number.isFinite(summary.totalTracks)) {
    setPlaylistTrackCountHint(summary.id, summary.totalTracks);
  }

  const normalized = applyPlaylistTrackCountHints([
    {
      description: '',
      owner: state.user?.display_name || state.user?.id || 'You',
      collaborative: false,
      isPublic: false,
      snapshotId: null,
      imageUrl: null,
      href: null,
      canLoad: true,
      ...summary,
    },
  ])[0];

  const existingIndex = state.playlists.findIndex((playlist) => playlist.id === normalized.id);
  if (existingIndex >= 0) {
    state.playlists[existingIndex] = {
      ...state.playlists[existingIndex],
      ...normalized,
    };
  } else {
    state.playlists = [normalized, ...state.playlists];
  }
}

function setStatusBubble(id, text, { tone = 'info' } = {}) {
  const el = get(id);
  if (!el) return;
  const normalizedText = String(text || '').trim();
  el.textContent = normalizedText;
  el.classList.remove('is-info', 'is-success', 'is-error');
  if (!normalizedText) {
    return;
  }
  el.classList.add(
    tone === 'error' ? 'is-error' : tone === 'success' ? 'is-success' : 'is-info'
  );
}

function setMessage(text, isError = false) {
  dlog('status', { text, isError });
  setStatusBubble('messages', text, { tone: isError ? 'error' : 'success' });
}

function readDebugQueryOverride() {
  try {
    const value = new URLSearchParams(window.location.search).get('debug');
    if (value === null) return null;
    const normalized = String(value).trim().toLowerCase();
    if (['1', 'true', 'on', 'yes'].includes(normalized)) return true;
    if (['0', 'false', 'off', 'no'].includes(normalized)) return false;
  } catch {
    // Ignore malformed URLs and keep the current persisted setting.
  }
  return null;
}

function formatDebugPayload(payload) {
  if (payload === null || payload === undefined) return '';
  if (typeof payload === 'string') return payload;
  try {
    return JSON.stringify(payload);
  } catch {
    return String(payload);
  }
}

function updateDebugControls() {
  const enabled = getDebugState();
  const panel = get('debugPanel');
  const visible = Boolean(panel && !panel.classList.contains('hidden'));
  const toggleBtn = get('toggleDebugBtn');
  const panelToggleBtn = get('toggleDebugPanelBtn');

  if (toggleBtn) {
    toggleBtn.textContent = enabled ? 'Debug On' : 'Debug Off';
    toggleBtn.classList.toggle('btn-primary', enabled);
  }
  if (panelToggleBtn) {
    panelToggleBtn.textContent = visible ? 'Hide Log' : 'Debug Log';
  }

  get('copyDebugLogBtn')?.classList.toggle('hidden', !visible);
  get('clearDebugLogBtn')?.classList.toggle('hidden', !visible);
}

function renderDebugLog() {
  const output = get('debugLogOutput');
  const summary = get('debugLogSummary');
  if (!output || !summary) return;

  const entries = getDebugLogEntries();
  summary.textContent = `${entries.length} entr${entries.length === 1 ? 'y' : 'ies'}`;
  output.textContent = entries.length
    ? entries
        .map((entry) => {
          const payload = formatDebugPayload(entry.payload);
          return payload
            ? `[${entry.stamp}] [${entry.scope}] ${entry.event} ${payload}`
            : `[${entry.stamp}] [${entry.scope}] ${entry.event}`;
        })
        .join('\n')
    : 'Debug log is empty.';
  output.scrollTop = output.scrollHeight;
  updateDebugControls();
}

function showDebugPanel() {
  const panel = get('debugPanel');
  if (!panel) return;
  panel.classList.remove('hidden');
  renderDebugLog();
}

function hideDebugPanel() {
  const panel = get('debugPanel');
  if (!panel) return;
  panel.classList.add('hidden');
  updateDebugControls();
}

function installDebugControls() {
  const queryOverride = readDebugQueryOverride();
  if (queryOverride !== null) {
    setDebugState(queryOverride);
  }

  subscribeDebugLogs(() => {
    const panel = get('debugPanel');
    if (panel && !panel.classList.contains('hidden')) {
      renderDebugLog();
    } else {
      updateDebugControls();
    }
  });

  window.SpotifyManagerDebug = {
    get enabled() {
      return getDebugState();
    },
    setEnabled(enabled, persist = true) {
      const next = setDebugState(enabled, { persist });
      dlog('debug:setEnabled', { enabled: next, persist });
      updateDebugControls();
      if (next) {
        showDebugPanel();
      }
      return next;
    },
    showPanel() {
      showDebugPanel();
    },
    hidePanel() {
      hideDebugPanel();
    },
    clear() {
      clearDebugLogEntries();
      renderDebugLog();
    },
    snapshot() {
      return {
        debugEnabled: getDebugState(),
        sourceMode: state.sourceMode,
        selectedPlaylistId: state.selectedPlaylistId,
        workingTracks: state.workingTracks.length,
        renderedTracks: state.renderTracks.length,
        tableInitialized: tracksTableInitialized,
        tableReadyPending: Boolean(tracksTableReady && !tracksTableInitialized),
      };
    },
    entries() {
      return getDebugLogEntries();
    },
  };

  window.addEventListener('error', (event) => {
    dlog('window:error', {
      message: event.message,
      filename: event.filename || null,
      line: event.lineno || null,
      column: event.colno || null,
      stack: event.error?.stack || null,
    });
  });
  window.addEventListener('unhandledrejection', (event) => {
    dlog('window:unhandledrejection', {
      reason: String(event.reason?.message || event.reason),
      stack: event.reason?.stack || null,
    });
  });

  updateDebugControls();
}

function setSetupMessage(text, isError = false) {
  setStatusBubble('setupModalStatus', text, { tone: isError ? 'error' : 'success' });
}

function fmt(value, digits = 3) {
  if (value === null || value === undefined) return 'N/A';
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
  state.weightPresets = loadObjectFromStorage(STORAGE_KEYS.weightPresets);
  refreshPresetSelect('weightPresetSelect', state.weightPresets, 'Choose weights preset');
}

function getCurrentSliderWeights() {
  const result = {};
  MIX_WEIGHT_FIELDS.forEach(([field]) => {
    const input = get(`mixWeight_${field}`);
    const rawPercent = Number(input?.value || 0);
    result[field] = Math.max(0, rawPercent) / 100;
  });
  return result;
}

function refreshMixSliderValueLabels() {
  MIX_WEIGHT_FIELDS.forEach(([field]) => {
    const input = get(`mixWeight_${field}`);
    const valueEl = get(`mixWeight_${field}_value`);
    if (!input || !valueEl) return;
    valueEl.textContent = `${input.value}%`;
  });
}

function getArtistAvoidanceOptions() {
  const enabled = Boolean(get('artistAvoidanceEnabled')?.checked);
  const rawStrength = Number(get('artistAvoidanceStrength')?.value || 0);
  return {
    enabled,
    strength: Math.max(0, Math.min(1, rawStrength / 100)),
  };
}

function refreshArtistAvoidanceControl() {
  const options = getArtistAvoidanceOptions();
  const input = get('artistAvoidanceStrength');
  const valueEl = get('artistAvoidanceStrengthValue');
  const host = input?.closest('.mix-slider-item-artist');
  if (input) {
    input.disabled = !options.enabled;
  }
  if (host) {
    host.classList.toggle('is-disabled', !options.enabled);
  }
  if (valueEl) {
    valueEl.textContent = options.enabled ? `${Math.round(options.strength * 100)}%` : 'Off';
  }
}

function setArtistAvoidanceOptions(options) {
  const normalized = { ...DEFAULT_ARTIST_AVOIDANCE, ...(options || {}) };
  const checkbox = get('artistAvoidanceEnabled');
  const slider = get('artistAvoidanceStrength');
  if (checkbox) {
    checkbox.checked = Boolean(normalized.enabled);
  }
  if (slider) {
    const numericStrength = Number(normalized.strength ?? DEFAULT_ARTIST_AVOIDANCE.strength);
    slider.value = String(Math.round(Math.max(0, Math.min(1, numericStrength)) * 100));
  }
  refreshArtistAvoidanceControl();
}

function setSliderWeights(weights) {
  MIX_WEIGHT_FIELDS.forEach(([field]) => {
    const input = get(`mixWeight_${field}`);
    if (!input) return;
    const fallbackValue = field === 'harmonic' ? weights?.camelot : undefined;
    const value = Number(weights?.[field] ?? fallbackValue ?? 0);
    input.value = String(Math.round(Math.max(0, value) * 100));
  });
  refreshMixSliderValueLabels();
}

function normalizeWeightsIfNeeded(weights) {
  const total = Object.values(weights).reduce((sum, value) => sum + Number(value || 0), 0);
  if (total <= 1) return { normalized: weights, total };
  const normalized = {};
  Object.keys(weights).forEach((field) => {
    normalized[field] = weights[field] / total;
  });
  return { normalized, total };
}

function updateMixWeightSummary() {
  const weights = getCurrentSliderWeights();
  const totalPercent = Object.values(weights).reduce((sum, value) => sum + value * 100, 0);
  const summary = get('mixWeightTotal');
  const artistAvoidance = getArtistAvoidanceOptions();
  const artistText = artistAvoidance.enabled
    ? ` | artist repeat penalty: ${(artistAvoidance.strength * 100).toFixed(0)}%`
    : ' | artist repeat penalty: off';
  if (totalPercent <= 100) {
    summary.textContent = `Total: ${totalPercent.toFixed(1)}%${artistText}`;
  } else {
    summary.textContent = `Total: ${totalPercent.toFixed(1)}% (will normalize to 100%)${artistText}`;
  }
}

function renderMixWeightSliders(initialWeights) {
  const host = get('mixWeightSliders');
  const weightTiles = MIX_WEIGHT_FIELDS.map(
    ([field, label]) => `
      <label class="mix-slider-item" for="mixWeight_${field}">
        <span>${label}</span>
        <input id="mixWeight_${field}" type="range" min="0" max="100" step="1" />
        <span id="mixWeight_${field}_value" class="subtle"></span>
      </label>
    `
  );

  weightTiles.push(`
    <div class="mix-slider-item mix-slider-item-artist">
      <div class="mix-slider-heading-row">
        <span>Artist Repeat Penalty</span>
      </div>
      <input id="artistAvoidanceStrength" type="range" min="0" max="100" step="1" value="100" />
      <div class="mix-slider-meta-row">
        <span id="artistAvoidanceStrengthValue" class="subtle"></span>
        <label class="mix-toggle-inline" for="artistAvoidanceEnabled">
          <span>Enable</span>
          <input id="artistAvoidanceEnabled" type="checkbox" checked />
        </label>
      </div>
    </div>
  `);

  host.innerHTML = weightTiles.join('');

  setSliderWeights(initialWeights || analysis.DEFAULT_WEIGHTS);
  setArtistAvoidanceOptions(DEFAULT_ARTIST_AVOIDANCE);

  MIX_WEIGHT_FIELDS.forEach(([field]) => {
    const input = get(`mixWeight_${field}`);
    const sync = () => {
      refreshMixSliderValueLabels();
      updateMixWeightSummary();
    };
    input.addEventListener('input', sync);
    sync();
  });
}

function applyModePresetToSliders(mode) {
  const defaults = analysis.DEFAULT_WEIGHTS || {};
  const preset = analysis.MIX_MODES?.[mode] || {};
  setSliderWeights({ ...defaults, ...preset });
  updateMixWeightSummary();
}

function activeColumns() {
  return columns.filter(([field]) => state.columnConfig[field]?.visible !== false);
}

function getColumnLabel(field) {
  return columns.find(([columnField]) => columnField === field)?.[1] || field;
}

function buildHeaderTitle(label, field) {
  const config = getHeaderFilterConfig(field);
  if (config.kind === 'none') {
    return `<span class="header-title">${label}</span>`;
  }
  const activeClass = isHeaderFieldFiltered(field) ? 'is-active' : '';
  return `<span class="header-title">${label}<span class="header-filter-icon ${activeClass}" title="Click to filter"></span></span>`;
}

function resolveHeaderFilterPopupPosition(event, column) {
  if (Number.isFinite(event?.clientX) && Number.isFinite(event?.clientY)) {
    return { left: event.clientX, top: event.clientY };
  }

  const rect = column?.getElement?.()?.getBoundingClientRect?.();
  if (rect) {
    return {
      left: rect.left + rect.width / 2,
      top: rect.bottom + 8,
    };
  }

  return {
    left: window.innerWidth / 2,
    top: 140,
  };
}

function handleHeaderFilterClick(field, event, column) {
  const filterConfig = getHeaderFilterConfig(field);
  if (filterConfig.kind === 'none') {
    return;
  }
  if (!event?.target?.closest?.('.header-filter-icon')) {
    return;
  }
  event.preventDefault();
  event.stopPropagation();
  const position = resolveHeaderFilterPopupPosition(event, column);
  openHeaderFilterPopup(field, position.left, position.top);
}

function buildTabulatorColumns() {
  return activeColumns().map(([field, label]) => {
    const width = state.columnConfig[field]?.width || 140;
    return {
      title: buildHeaderTitle(label, field),
      field,
      width,
      headerSort: true,
      resizable: true,
      headerClick: (event, column) => {
        handleHeaderFilterClick(field, event, column);
      },
      formatter: (cell) => fmt(cell.getValue()),
    };
  });
}

function syncColumnConfigFromTable() {
  if (!tracksTable) return;
  tracksTable.getColumns().forEach((column) => {
    const field = column.getField();
    if (!field || !state.columnConfig[field]) return;
    const width = column.getWidth();
    if (Number.isFinite(width)) {
      state.columnConfig[field].width = width;
    }
    state.columnConfig[field].visible = column.isVisible();
  });
}

function refreshHeaderFilterVisuals() {
  if (!tracksTable || typeof tracksTable.getColumns !== 'function') return;

  tracksTable.getColumns().forEach((col) => {
    const field = col.getField();
    if (!field) return;
    const icon = col.getElement()?.querySelector('.header-filter-icon');
    if (!icon) return;
    icon.classList.toggle('is-active', isHeaderFieldFiltered(field));
  });
}

function getActiveTableData() {
  if (!tracksTable) return [];
  try {
    return tracksTable.getData('active');
  } catch (error) {
    dlog('getActiveTableData:error', {
      message: String(error?.message || error),
      stack: error?.stack || null,
      tableInitialized: tracksTableInitialized,
    });
    return [];
  }
}

function registerTableEventHandlers(resolveReady) {
  if (!tracksTable || typeof tracksTable.on !== 'function') {
    dlog('initializeTable:eventBindingUnavailable', {
      hasTable: Boolean(tracksTable),
      hasOn: Boolean(tracksTable && tracksTable.on),
    });
    if (tracksTable) {
      tracksTableInitialized = Boolean(tracksTable.initialized);
      resolveReady();
    }
    return;
  }

  let readyResolved = false;
  const markReady = (source) => {
    if (readyResolved) return;
    readyResolved = true;
    tracksTableInitialized = true;
    dlog('initializeTable:ready', {
      source,
      initializedFlag: Boolean(tracksTable?.initialized),
    });
    resolveReady();
  };

  tracksTable.on('tableBuilt', () => {
    markReady('tableBuilt');
    dlog('initializeTable:built', {
      columns: buildTabulatorColumns().length,
      activeRows: getActiveTableData().length,
    });
  });

  tracksTable.on('renderStarted', () => {
    dlog('table:renderStarted', {
      selectedPlaylistId: state.selectedPlaylistId,
      sourceMode: state.sourceMode,
    });
  });

  tracksTable.on('renderComplete', () => {
    dlog('table:renderComplete', {
      activeRows: getActiveTableData().length,
    });
  });

  tracksTable.on('dataLoaded', (data) => {
    dlog('table:dataLoaded', {
      rows: Array.isArray(data) ? data.length : null,
    });
  });

  tracksTable.on('dataProcessed', () => {
    dlog('table:dataProcessed', {
      activeRows: getActiveTableData().length,
    });
  });

  tracksTable.on('dataSorted', (sorters) => {
    const sorter = sorters?.[0] || null;
    state.tableSort = sorter
      ? { field: sorter.field, direction: sorter.dir }
      : { field: null, direction: null };
    state.renderTracks = getActiveTableData();
  });

  tracksTable.on('dataFiltered', () => {
    state.renderTracks = getActiveTableData();
  });

  tracksTable.on('columnMoved', () => {
    syncColumnConfigFromTable();
    renderColumnControls();
  });

  tracksTable.on('columnResized', () => {
    syncColumnConfigFromTable();
  });

  queueMicrotask(() => {
    if (tracksTable?.initialized) {
      markReady('initialized-flag');
    }
  });
}

function getVisibleTracks() {
  if (Array.isArray(state.renderTracks) && state.renderTracks.length) {
    return state.renderTracks;
  }
  return selectedTracks();
}

function clearFieldFilter(field) {
  const config = getHeaderFilterConfig(field);
  if (!config) return;
  delete state.filterNegations[field];
  if (config.kind === 'inline') {
    delete state.inlineHeaderFilters[field];
  } else if (config.kind === 'range') {
    setFilterInputValue(config.minId, '');
    setFilterInputValue(config.maxId, '');
  } else if (config.kind === 'none') {
    return;
  } else {
    setFilterInputValue(config.inputId, '');
  }
  applyCurrentFilters();
  setMessage(`Cleared header filter on ${getColumnLabel(field)}.`);
}

function renderActiveFilterPills(filters) {
  const host = get('activeFilterPills');
  if (!host) return;
  if (!filters.length) {
    host.innerHTML = '';
    return;
  }
  host.innerHTML = filters
    .map((filter) => {
      const prefix = filter.negate ? 'NOT ' : '';
      if (filter.kind === 'range' || filter.kind === 'yearRange') {
        return `<button class="filter-pill" type="button" data-filter-field="${filter.field}" title="Clear ${getColumnLabel(filter.field)} filter">${prefix}${getColumnLabel(filter.field)}: ${filter.min || '-inf'} to ${filter.max || 'inf'}</button>`;
      }
      if (filter.kind === 'set') {
        return `<button class="filter-pill" type="button" data-filter-field="${filter.field}" title="Clear ${getColumnLabel(filter.field)} filter">${prefix}${getColumnLabel(filter.field)}: ${filter.values.join(', ')}</button>`;
      }
      return `<button class="filter-pill" type="button" data-filter-field="${filter.field}" title="Clear ${getColumnLabel(filter.field)} filter">${prefix}${getColumnLabel(filter.field)}: ${filter.query}</button>`;
    })
    .join('');
}

function initializeTable(initialTracks = []) {
  if (tracksTable) return;
  dlog('initializeTable:start', { initialRows: initialTracks?.length || 0 });
  tracksTableReady = new Promise((resolve, reject) => {
    try {
      tracksTable = new Tabulator('#tracksTable', {
        data: initialTracks || [],
        columns: buildTabulatorColumns(),
        layout: 'fitDataTable',
        height: '54vh',
        rowHeight: 34,
        autoResize: false,
        movableColumns: true,
        resizableColumns: true,
        resizableColumnFit: false,
        selectableRows: true,
        selectableRowsRangeMode: 'click',
        placeholder: 'No tracks to display.',
        rowContextMenu: [
          {
            label: 'Remove Song',
            action: (_, row) => removeTracksByReference([row.getData()]),
          },
        ],
      });

      registerTableEventHandlers(resolve);
    } catch (error) {
      dlog('initializeTable:failed', {
        message: String(error?.message || error),
        stack: error?.stack || null,
      });
      reject(error);
    }
  });
}

function renderColumnControls() {
  const host = get('columnControls');
  const controls = columns
    .map(([field, label]) => {
      const cfg = state.columnConfig[field] || { visible: true, width: 140 };
      return `
        <div class="column-control">
          <input type="checkbox" data-col-field="${field}" ${cfg.visible ? 'checked' : ''} />
          <span>${label}</span>
        </div>
      `;
    })
    .join('');
  host.innerHTML = controls;

  host.querySelectorAll('input[data-col-field]').forEach((input) => {
    input.addEventListener('change', () => {
      state.columnConfig[input.dataset.colField].visible = input.checked;
    });
  });
}

function setAllColumnVisibility(visible) {
  columns.forEach(([field]) => {
    state.columnConfig[field].visible = visible;
  });
  renderColumnControls();
  applyColumnVisibility();
}

function applyColumnVisibility() {
  renderCurrentView({ resetScroll: false, rebuildColumns: true });
}

function getHeaderFilterConfig(field) {
  if (field === 'customOrder') {
    return { kind: 'none' };
  }

  const rangeMap = {
    durationMs: { minId: 'filterDurationMsMin', maxId: 'filterDurationMsMax' },
    bpm: { minId: 'filterBpmMin', maxId: 'filterBpmMax' },
    tempo: { minId: 'filterTempoMin', maxId: 'filterTempoMax' },
    energy: { minId: 'filterEnergyMin', maxId: 'filterEnergyMax' },
    danceability: { minId: 'filterDanceMin', maxId: 'filterDanceMax' },
    valence: { minId: 'filterValenceMin', maxId: 'filterValenceMax' },
    loudness: { minId: 'filterLoudnessMin', maxId: 'filterLoudnessMax' },
    acousticness: { minId: 'filterAcousticMin', maxId: 'filterAcousticMax' },
    instrumentalness: { minId: 'filterInstrMin', maxId: 'filterInstrMax' },
    speechiness: { minId: 'filterSpeechMin', maxId: 'filterSpeechMax' },
    liveness: { minId: 'filterLiveMin', maxId: 'filterLiveMax' },
    popularity: { minId: 'filterPopularityMin', maxId: 'filterPopularityMax' },
  };
  if (rangeMap[field]) {
    return {
      kind: 'range',
      ...rangeMap[field],
    };
  }

  if (field === 'timeSignature') {
    return { kind: 'set', inputId: 'filterTimeSig' };
  }

  if (field === 'keyModeLabel') {
    return { kind: 'set', inputId: 'filterKeyMode' };
  }

  const textMap = {
    title: 'filterTitle',
    artistDisplay: 'filterArtist',
    genreDisplay: 'filterGenre',
  };
  if (textMap[field]) {
    return { kind: 'contains', inputId: textMap[field] };
  }

  return { kind: 'inline', field };
}

function isHeaderFieldFiltered(field) {
  const config = getHeaderFilterConfig(field);
  if (!config) return false;
  if (config.kind === 'none') return false;
  if (config.kind === 'inline') {
    return Boolean((state.inlineHeaderFilters[field] || '').trim() || state.filterNegations[field]);
  }
  if (config.kind === 'range') {
    const min = get(config.minId)?.value?.trim() || '';
    const max = get(config.maxId)?.value?.trim() || '';
    return Boolean(min || max || state.filterNegations[field]);
  }
  const value = get(config.inputId)?.value?.trim() || '';
  return Boolean(value || state.filterNegations[field]);
}

function setTableLoading(loading) {
  const wrap = get('tracksTableWrap');
  if (!wrap) return;
  wrap.classList.toggle('table-loading', loading);
}

function renderTable(tracks, options = {}) {
  return queueTableRender(tracks, options);
}

function getDisplayedTracks() {
  return selectedTracks();
}

function scheduleDuplicateAnalysis() {
  if (duplicateAnalysisTimer) {
    clearTimeout(duplicateAnalysisTimer);
  }
  duplicateAnalysisTimer = setTimeout(() => {
    duplicateAnalysisTimer = null;
    state.duplicateReport = analysis.findDuplicates(state.workingTracks);
    renderDuplicates();
  }, 0);
}

function renderCurrentView(options = {}) {
  const { resetScroll = false, rebuildColumns = false } = options;
  dlog('renderCurrentView', {
    resetScroll,
    rebuildColumns,
    displayedTracks: getDisplayedTracks().length,
    sourceMode: state.sourceMode,
  });
  return renderTable(getDisplayedTracks(), { resetScroll, rebuildColumns });
}

function setFilterInputValue(id, value) {
  const el = get(id);
  if (el) {
    el.value = value;
  }
}

function getInputTrim(id) {
  const el = get(id);
  if (!el || typeof el.value !== 'string') return '';
  return el.value.trim();
}

function parseMaybeNegatedQuery(raw) {
  const text = String(raw || '').trim();
  if (!text) return { query: '', negate: false };
  if (text.startsWith('!')) {
    return { query: text.slice(1).trim(), negate: true };
  }
  return { query: text, negate: false };
}

function parseSetValues(raw) {
  return String(raw || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function getSetOptionsForField(field) {
  const values = new Set();
  state.workingTracks.forEach((track) => {
    const value = track?.[field];
    if (value === null || value === undefined || value === '') return;
    values.add(String(value));
  });
  return [...values].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
}

function renderHeaderFilterSetOptions(field, selectedValues) {
  const host = get('headerFilterSetRow');
  const options = getSetOptionsForField(field);
  if (!options.length) {
    host.innerHTML = '<div class="subtle">No values available.</div>';
    return;
  }
  const selected = new Set(selectedValues || []);
  host.innerHTML = options
    .map((value, index) => {
      const id = `headerFilterSetOption_${field}_${index}`;
      return `
        <label class="popup-set-option" for="${id}">
          <input id="${id}" type="checkbox" value="${value}" ${selected.has(value) ? 'checked' : ''} />
          <span>${value}</span>
        </label>
      `;
    })
    .join('');
}

function openHeaderFilterPopup(field, clientX, clientY) {
  const config = getHeaderFilterConfig(field);
  if (!config || config.kind === 'none') return;

  const popup = get('headerFilterPopup');
  popup.dataset.field = field;
  popup.dataset.kind = config.kind;
  get('headerFilterTitle').textContent = `Filter: ${getColumnLabel(field)}`;

  const minRow = get('headerFilterMinRow');
  const maxRow = get('headerFilterMaxRow');
  const minLabel = minRow.querySelector('span');
  const maxLabel = maxRow.querySelector('span');
  const minInput = get('headerFilterMin');
  const maxInput = get('headerFilterMax');
  const setRow = get('headerFilterSetRow');
  const notToggle = get('headerFilterNot');

  notToggle.checked = Boolean(state.filterNegations[field]);
  setRow.classList.add('hidden');

  if (config.kind === 'range') {
    minRow.classList.remove('hidden');
    maxRow.classList.remove('hidden');
    minLabel.textContent = 'Min';
    maxLabel.textContent = 'Max';
    minInput.value = get(config.minId)?.value || '';
    maxInput.value = get(config.maxId)?.value || '';
  } else if (config.kind === 'set') {
    minRow.classList.add('hidden');
    maxRow.classList.add('hidden');
    const selected = parseSetValues(get(config.inputId)?.value || '');
    renderHeaderFilterSetOptions(field, selected);
    setRow.classList.remove('hidden');
  } else if (config.kind === 'exact') {
    minRow.classList.remove('hidden');
    maxRow.classList.add('hidden');
    minLabel.textContent = 'Value';
    minInput.value = get(config.inputId)?.value || '';
    maxInput.value = '';
  } else {
    minRow.classList.remove('hidden');
    maxRow.classList.add('hidden');
    minLabel.textContent = 'Contains';
    minInput.value =
      config.kind === 'inline'
        ? state.inlineHeaderFilters[field] || ''
        : get(config.inputId)?.value || '';
    maxInput.value = '';
  }

  const left = Math.max(8, Math.min(clientX, window.innerWidth - 260));
  const top = Math.max(8, Math.min(clientY, window.innerHeight - 180));
  popup.style.left = `${left}px`;
  popup.style.top = `${top}px`;
  popup.classList.remove('hidden');
  if (config.kind !== 'set') {
    minInput.focus();
  }
}

function closeHeaderFilterPopup() {
  get('headerFilterPopup').classList.add('hidden');
}

function applyHeaderFilterPopup() {
  const popup = get('headerFilterPopup');
  const field = popup.dataset.field;
  const config = getHeaderFilterConfig(field);
  if (!config) return;

  const min = get('headerFilterMin').value.trim();
  const max = get('headerFilterMax').value.trim();
  const negate = get('headerFilterNot').checked;

  if (config.kind === 'range') {
    setFilterInputValue(config.minId, min);
    setFilterInputValue(config.maxId, max);
    if (negate) {
      state.filterNegations[field] = true;
    } else {
      delete state.filterNegations[field];
    }
  } else if (config.kind === 'set') {
    const checkedValues = Array.from(
      get('headerFilterSetRow').querySelectorAll('input[type="checkbox"]:checked')
    ).map((item) => item.value);
    setFilterInputValue(config.inputId, checkedValues.join(', '));
    if (negate) {
      state.filterNegations[field] = true;
    } else {
      delete state.filterNegations[field];
    }
  } else if (config.kind === 'inline') {
    if (min) {
      state.inlineHeaderFilters[field] = min;
    } else {
      delete state.inlineHeaderFilters[field];
    }
    if (negate) {
      state.filterNegations[field] = true;
    } else {
      delete state.filterNegations[field];
    }
  } else if (config.kind === 'exact') {
    setFilterInputValue(config.inputId, min);
    if (negate) {
      state.filterNegations[field] = true;
    } else {
      delete state.filterNegations[field];
    }
  } else {
    setFilterInputValue(config.inputId, min);
    if (negate) {
      state.filterNegations[field] = true;
    } else {
      delete state.filterNegations[field];
    }
  }
  applyCurrentFilters();
  closeHeaderFilterPopup();
  refreshHeaderFilterVisuals();
  setMessage(`Applied header filter on ${field}.`);
}

function clearHeaderFilterPopup() {
  const popup = get('headerFilterPopup');
  const field = popup.dataset.field;
  const config = getHeaderFilterConfig(field);
  if (!config) return;
  clearFieldFilter(field);
  closeHeaderFilterPopup();
}

function bindHeaderFilterPopupEvents() {
  get('headerFilterApplyBtn').addEventListener('click', applyHeaderFilterPopup);
  get('headerFilterClearBtn').addEventListener('click', clearHeaderFilterPopup);
  get('headerFilterCancelBtn').addEventListener('click', closeHeaderFilterPopup);

  get('headerFilterPopup').addEventListener('click', (event) => {
    event.stopPropagation();
  });

  get('headerFilterMin').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') applyHeaderFilterPopup();
  });

  get('headerFilterMax').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') applyHeaderFilterPopup();
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      closeHeaderFilterPopup();
    }
  });

  document.addEventListener('click', (event) => {
    const popup = get('headerFilterPopup');
    if (popup.classList.contains('hidden')) return;
    if (!popup.contains(event.target)) {
      closeHeaderFilterPopup();
    }
  });
}

function selectedTracks() {
  return state.filterActive ? state.filteredTracks : state.workingTracks;
}

function getCurrentFilterSnapshot() {
  const snapshot = {};
  FILTER_FIELD_IDS.forEach((id) => {
    snapshot[id] = get(id)?.value ?? '';
  });
  return snapshot;
}

function applyFilterSnapshot(snapshot) {
  state.inlineHeaderFilters = {};
  state.filterNegations = {};
  FILTER_FIELD_IDS.forEach((id) => {
    const el = get(id);
    if (el) {
      el.value = snapshot?.[id] ?? '';
    }
  });
  renderActiveFilterPills(buildFiltersFromInputs());
  refreshHeaderFilterVisuals();
}

function buildFiltersFromInputs() {
  const filters = [];
  const addNegation = (field, filter) => {
    const withNegation = { ...filter };
    if (state.filterNegations[field]) {
      withNegation.negate = true;
    }
    filters.push(withNegation);
  };

  const getValue = (primaryId, legacyId) => {
    const primary = getInputTrim(primaryId);
    if (primary) return primary;
    return legacyId ? getInputTrim(legacyId) : '';
  };

  const addContains = (field, elementId) => {
    const value = getValue(elementId);
    const { query, negate } = parseMaybeNegatedQuery(value);
    if (!query) return;
    addNegation(field, { field, kind: 'contains', query, negate: negate || state.filterNegations[field] });
  };

  const addSet = (field, elementId) => {
    const values = parseSetValues(getValue(elementId));
    if (!values.length) return;
    addNegation(field, { field, kind: 'set', values });
  };

  const addRange = (field, minId, maxId, legacyMinId, legacyMaxId) => {
    const min = getValue(minId, legacyMinId);
    const max = getValue(maxId, legacyMaxId);
    if (min || max || state.filterNegations[field]) {
      addNegation(field, { field, kind: 'range', min, max });
    }
  };

  addContains('title', 'filterTitle');
  addContains('artistDisplay', 'filterArtist');
  addContains('genreDisplay', 'filterGenre');
  addSet('keyModeLabel', 'filterKeyMode');

  addRange('durationMs', 'filterDurationMsMin', 'filterDurationMsMax');
  addRange('bpm', 'filterBpmMin', 'filterBpmMax', 'filterBpmMinLegacy', 'filterBpmMaxLegacy');
  addRange('tempo', 'filterTempoMin', 'filterTempoMax');
  addRange(
    'energy',
    'filterEnergyMin',
    'filterEnergyMax',
    'filterEnergyMinLegacy',
    'filterEnergyMaxLegacy'
  );
  addRange(
    'danceability',
    'filterDanceMin',
    'filterDanceMax',
    'filterDanceMinLegacy',
    'filterDanceMaxLegacy'
  );
  addRange(
    'valence',
    'filterValenceMin',
    'filterValenceMax',
    'filterValenceMinLegacy',
    'filterValenceMaxLegacy'
  );
  addRange('loudness', 'filterLoudnessMin', 'filterLoudnessMax');
  addRange('acousticness', 'filterAcousticMin', 'filterAcousticMax');
  addRange('instrumentalness', 'filterInstrMin', 'filterInstrMax');
  addRange('speechiness', 'filterSpeechMin', 'filterSpeechMax');
  addRange('liveness', 'filterLiveMin', 'filterLiveMax');
  addRange('popularity', 'filterPopularityMin', 'filterPopularityMax');

  addSet('timeSignature', 'filterTimeSig');

  Object.entries(state.inlineHeaderFilters || {}).forEach(([field, query]) => {
    const value = String(query || '').trim();
    if (!value) return;
    addNegation(field, { field, kind: 'contains', query: value });
  });
  return filters;
}

function applyCurrentFilters() {
  dlog('applyCurrentFilters:start');
  const filters = buildFiltersFromInputs();
  state.filterActive = filters.length > 0;
  state.filteredTracks = analysis.applyFilters(state.workingTracks, filters);
  renderActiveFilterPills(filters);

  const shown = selectedTracks();
  const filterCount = get('filterCount');
  if (filterCount) {
    filterCount.textContent = state.filterActive
      ? `Filtered tracks: ${shown.length}`
      : 'Filtered tracks: 0';
  }
  renderCurrentView({ resetScroll: false });
  refreshHeaderFilterVisuals();
  dlog('applyCurrentFilters:done', { total: state.workingTracks.length, shown: shown.length });
}

function renderPlaylists() {
  const list = get('playlistList');
  list.innerHTML = state.playlists
    .map((playlist) => {
      const active = playlist.id === state.selectedPlaylistId ? 'active' : '';
      const disabled = playlist.canLoad === false ? 'disabled' : '';
      const countText = Number.isFinite(playlist.totalTracks) ? playlist.totalTracks : '?';
      return `
        <li>
          <button class="${active}" data-playlist-id="${playlist.id}" aria-pressed="${String(active === 'active')}" ${disabled}>
            <span class="playlist-item-main">
              <span class="playlist-name">${escapeHtml(playlist.name)}</span>
            </span>
            <span class="playlist-count-badge">${escapeHtml(countText)}</span>
          </button>
        </li>
      `;
    })
    .join('');

  list.querySelectorAll('button[data-playlist-id]').forEach((button) => {
    button.addEventListener('click', () => loadPlaylist(button.dataset.playlistId));
  });
}

function renderAuthState() {
  const auth = state.auth;
  const loginBtn = get('loginBtn');
  const logoutBtn = get('logoutBtn');
  const isConfigured = Boolean(state.setup?.hasClientId);
  const canLogin = isConfigured && !auth?.authenticated;
  const authStatusText = auth?.authenticated
    ? 'Connected to Spotify'
    : isConfigured
      ? 'Not signed in'
      : 'Configure Spotify app details to sign in';
  setStatusBubble('authStatus', authStatusText, { tone: auth?.authenticated ? 'success' : 'info' });
  loginBtn.disabled = !canLogin;
  logoutBtn.disabled = !auth?.authenticated;

  if (auth?.authenticated) {
    const label = state.user?.display_name || state.user?.id || 'Signed In';
    loginBtn.textContent = label;
    loginBtn.classList.remove('btn-primary');
  } else {
    loginBtn.textContent = 'Sign In With Spotify';
    loginBtn.classList.add('btn-primary');
  }
}

function renderSetupState() {
  const setup = state.setup;
  if (!setup) return;
  const setupBtn = get('openSetupWizardBtn');
  const recommendedRedirect = auth.getHostedRedirectUriForSetup();
  const recommendedWebsite = auth.getHostedWebsiteUrl();
  setStatusBubble(
    'setupStatus',
    setup.hasClientId ? `Configured Client ID: ${setup.clientIdMasked}` : 'Spotify app setup required.',
    { tone: setup.hasClientId ? 'info' : 'error' }
  );
  setupBtn.classList.remove('hidden');
  get('setupRedirectUri').value = setup.redirectUri || recommendedRedirect;

  const setupHint = get('setupRedirectHintInline');
  if (setupHint) {
    const redirectText = setup.redirectUri || recommendedRedirect;
    setupHint.textContent = redirectText;
    setupHint.dataset.copy = redirectText;
  }

  const websiteHint = get('setupWebsiteHintInline');
  if (websiteHint) {
    websiteHint.textContent = recommendedWebsite;
    websiteHint.dataset.copy = recommendedWebsite;
  }
}

function bindRibbonTabs() {
  document.querySelectorAll('.ribbon-tab').forEach((tabButton) => {
    tabButton.addEventListener('click', () => {
      if (tabButton.disabled) return;
      const target = tabButton.dataset.tab;
      document.querySelectorAll('.ribbon-tab').forEach((tab) => {
        tab.classList.toggle('active', tab === tabButton);
      });
      document.querySelectorAll('.ribbon-panel').forEach((panel) => {
        panel.classList.toggle('active', panel.dataset.panel === target);
      });
    });
  });
}

function renderPlaylistHeader() {
  if (!state.selectedPlaylistMeta) return;
  const p = state.selectedPlaylistMeta;
  get('playlistTitle').textContent = p.name;
  if (state.sourceMode === 'csv') {
    get('playlistMeta').textContent = `${p.owner} | ${p.totalTracks} tracks`;
  } else {
    get('playlistMeta').textContent = `${p.owner} | ${p.totalTracks} tracks | followers: ${p.followers ?? 'n/a'}`;
  }
}

function removeTracksByReference(trackRefs) {
  const removeKeys = new Set(
    (trackRefs || [])
      .map((track) => track?.trackId || track?.uri || `${track?.title || ''}::${track?.artistDisplay || ''}::${track?.customOrder ?? ''}`)
      .filter(Boolean)
  );
  if (!removeKeys.size) return;
  const nextTracks = state.workingTracks.filter((track) => {
    const key = track?.trackId || track?.uri || `${track?.title || ''}::${track?.artistDisplay || ''}::${track?.customOrder ?? ''}`;
    return !removeKeys.has(key);
  });
  const removedCount = state.workingTracks.length - nextTracks.length;
  if (!removedCount) return;
  commitWorkingTracks(nextTracks, `Removed ${removedCount} track(s)`);
  setMessage(`Removed ${removedCount} track(s).`);
}

function removeSelectedRows() {
  if (!tracksTable) return;
  const selectedRows = tracksTable.getSelectedData();
  if (!selectedRows.length) {
    setMessage('Select one or more rows first.', true);
    return;
  }
  removeTracksByReference(selectedRows);
}

function reindexWorkingTracks() {
  state.workingTracks.forEach((track, index) => {
    track.customOrder = index;
  });
}

function updateHistoryButtons() {
  get('undoBtn').disabled = state.history.past.length === 0;
  get('redoBtn').disabled = state.history.future.length === 0;
}

function pushHistory(label) {
  state.history.past.push({ label, tracks: cloneTracks(state.workingTracks) });
  state.history.future = [];
  if (state.history.past.length > 50) {
    state.history.past.shift();
  }
  updateHistoryButtons();
}

function commitWorkingTracks(newTracks, label) {
  pushHistory(label);
  state.workingTracks = cloneTracks(newTracks);
  reindexWorkingTracks();
  scheduleDuplicateAnalysis();
  if (state.filterActive) {
    applyCurrentFilters();
  } else {
    renderCurrentView({ resetScroll: false });
  }
  renderTransitionDiagnostics();
}

function undoLastOperation() {
  if (!state.history.past.length) return;
  const previous = state.history.past.pop();
  state.history.future.push({ label: 'redo', tracks: cloneTracks(state.workingTracks) });
  state.workingTracks = cloneTracks(previous.tracks);
  reindexWorkingTracks();
  scheduleDuplicateAnalysis();
  if (state.filterActive) {
    applyCurrentFilters();
  } else {
    renderCurrentView({ resetScroll: false });
  }
  renderTransitionDiagnostics();
  setMessage(`Undo: ${previous.label}`);
  updateHistoryButtons();
}

function redoLastOperation() {
  if (!state.history.future.length) return;
  const next = state.history.future.pop();
  state.history.past.push({ label: 'undo', tracks: cloneTracks(state.workingTracks) });
  state.workingTracks = cloneTracks(next.tracks);
  reindexWorkingTracks();
  scheduleDuplicateAnalysis();
  if (state.filterActive) {
    applyCurrentFilters();
  } else {
    renderCurrentView({ resetScroll: false });
  }
  renderTransitionDiagnostics();
  setMessage('Redo applied.');
  updateHistoryButtons();
}

function openSetupModal() {
  get('setupModal').classList.remove('hidden');
}

function closeSetupModal() {
  get('setupModal').classList.add('hidden');
}

async function copyTextToClipboard(text) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    await navigator.clipboard.writeText(text);
    return true;
  }
  // Fallback for environments where clipboard API is unavailable.
  const area = document.createElement('textarea');
  area.value = text;
  area.style.position = 'fixed';
  area.style.left = '-9999px';
  document.body.appendChild(area);
  area.focus();
  area.select();
  const copied = document.execCommand('copy');
  document.body.removeChild(area);
  return copied;
}

async function copyDebugLog() {
  const text = get('debugLogOutput')?.textContent || '';
  await copyTextToClipboard(text);
  setMessage('Copied debug log.');
}

function bindSetupCopyValues() {
  document.querySelectorAll('.copy-value').forEach((el) => {
    el.addEventListener('click', async () => {
      const value = el.dataset.copy || el.textContent || '';
      try {
        await copyTextToClipboard(value);
        setSetupMessage(`Copied: ${value}`);
      } catch {
        setSetupMessage('Could not copy automatically. Select text and copy manually.', true);
      }
    });
  });
}

function openCsvImportModal() {
  get('csvImportModal').classList.remove('hidden');
}

function closeCsvImportModal() {
  get('csvImportModal').classList.add('hidden');
}

function setCsvImportStatus(text, isError = false) {
  setStatusBubble('csvImportStatus', text, { tone: isError ? 'error' : 'success' });
}

function setBusyOverlay(visible, title = 'Working...', detail = 'Please wait.') {
  const overlay = get('busyOverlay');
  if (!overlay) return;
  overlay.classList.toggle('hidden', !visible);
  const titleEl = get('busyOverlayTitle');
  const detailEl = get('busyOverlayStatus');
  if (titleEl) {
    titleEl.textContent = title;
  }
  if (detailEl) {
    detailEl.textContent = detail;
  }
}

function waitForNextPaint() {
  return new Promise((resolve) => {
    const raf = typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function'
      ? window.requestAnimationFrame.bind(window)
      : (callback) => setTimeout(callback, 16);
    raf(() => raf(resolve));
  });
}

function yieldToBrowser() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

async function importCsvAndCloseModal(file, csvInput = null) {
  if (!file) return;
  dlog('importCsv:start', {
    fileName: file.name,
    fileSize: file.size || null,
  });
  closeCsvImportModal();
  setBusyOverlay(true, 'Importing CSV', `Reading ${file.name}...`);
  try {
    await waitForNextPaint();
    await handleCsvFileImport(file, ({ message }) => {
      if (message) {
        setBusyOverlay(true, 'Importing CSV', message);
      }
    });
    setCsvImportStatus(`Imported: ${file.name}`);
    dlog('importCsv:done', {
      fileName: file.name,
      tracks: state.workingTracks.length,
    });
  } catch (error) {
    // If tracks actually loaded despite a table render timeout, don't reopen the modal.
    if (state.workingTracks.length > 0 && state.sourceMode === 'csv') {
      dlog('importCsv:tableRenderWarning', { message: error.message });
      setMessage(`CSV loaded (${state.workingTracks.length} tracks) with a non-critical table warning.`);
    } else {
      openCsvImportModal();
      setCsvImportStatus(error.message, true);
    }
  } finally {
    if (csvInput) {
      csvInput.value = '';
    }
    setBusyOverlay(false);
  }
}

async function parseCsvTextAsync(content, progressCb = null) {
  const rows = [];
  let current = '';
  let row = [];
  let inQuotes = false;
  const totalLength = content.length || 1;
  const chunkSize = 25000;

  for (let i = 0; i < content.length; i += 1) {
    const char = content[i];
    const next = content[i + 1];
    if (char === '"') {
      if (inQuotes && next === '"') {
        current += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }
    if (char === ',' && !inQuotes) {
      row.push(current);
      current = '';
      continue;
    }
    if ((char === '\n' || char === '\r') && !inQuotes) {
      if (char === '\r' && next === '\n') {
        i += 1;
      }
      row.push(current);
      rows.push(row);
      row = [];
      current = '';
      continue;
    }
    current += char;

    if (i > 0 && i % chunkSize === 0) {
      if (typeof progressCb === 'function') {
        progressCb({
          stage: 'parse',
          message: `Parsing CSV... ${Math.min(99, Math.round((i / totalLength) * 100))}%`,
        });
      }
      await yieldToBrowser();
    }
  }

  if (current.length > 0 || row.length > 0) {
    row.push(current);
    rows.push(row);
  }
  const filtered = rows.filter((r) => r.some((cell) => String(cell || '').trim().length));
  dlog('parseCsvText', {
    rawRows: rows.length,
    nonEmptyRows: filtered.length,
  });
  return filtered;
}

function toNumberOrNull(value) {
  const trimmed = String(value ?? '').trim();
  if (!trimmed) return null;
  const num = Number(trimmed);
  return Number.isFinite(num) ? num : null;
}

function toBooleanOrNull(value) {
  const trimmed = String(value ?? '').trim().toLowerCase();
  if (!trimmed) return null;
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;
  return null;
}

async function csvRowsToTracksAsync(rows, progressCb = null) {
  if (rows.length < 2) return [];
  const header = rows[0].map((item) => String(item || '').trim());
  const indexMap = new Map(header.map((name, idx) => [name, idx]));
  const read = (cells, name) => {
    const idx = indexMap.get(name);
    return idx === undefined ? '' : String(cells[idx] ?? '').trim();
  };

  const tracks = [];
  const totalRows = Math.max(1, rows.length - 1);
  for (let i = 1; i < rows.length; i += 1) {
    const cells = rows[i];
    if (!cells || !cells.length) continue;
    const key = toNumberOrNull(read(cells, 'Key'));
    const mode = toNumberOrNull(read(cells, 'Mode'));
    const tempo = toNumberOrNull(read(cells, 'Tempo'));
    const genres = read(cells, 'Genres');
    tracks.push({
      customOrder: tracks.length,
      uri: read(cells, 'Track URI') || null,
      title: read(cells, 'Track Name') || null,
      albumName: read(cells, 'Album Name') || null,
      artistDisplay: read(cells, 'Artist Name(s)') || null,
      albumReleaseDate: read(cells, 'Release Date') || null,
      durationMs: toNumberOrNull(read(cells, 'Duration (ms)')),
      durationSeconds: (() => {
        const ms = toNumberOrNull(read(cells, 'Duration (ms)'));
        return Number.isFinite(ms) ? ms / 1000 : null;
      })(),
      popularity: toNumberOrNull(read(cells, 'Popularity')),
      explicit: toBooleanOrNull(read(cells, 'Explicit')),
      addedBy: read(cells, 'Added By') || null,
      addedAt: read(cells, 'Added At') || null,
      genres: genres ? genres.split(',').map((g) => g.trim()).filter(Boolean) : [],
      genreDisplay: genres || null,
      recordLabel: read(cells, 'Record Label') || null,
      danceability: toNumberOrNull(read(cells, 'Danceability')),
      energy: toNumberOrNull(read(cells, 'Energy')),
      key,
      loudness: toNumberOrNull(read(cells, 'Loudness')),
      mode,
      speechiness: toNumberOrNull(read(cells, 'Speechiness')),
      acousticness: toNumberOrNull(read(cells, 'Acousticness')),
      instrumentalness: toNumberOrNull(read(cells, 'Instrumentalness')),
      liveness: toNumberOrNull(read(cells, 'Liveness')),
      valence: toNumberOrNull(read(cells, 'Valence')),
      tempo,
      bpm: tempo,
      timeSignature: toNumberOrNull(read(cells, 'Time Signature')),
      keyModeLabel:
        Number.isFinite(key) && Number.isFinite(mode)
          ? `${key}${mode === 1 ? ' major' : ' minor'}`
          : null,
      analysisAvailable: false,
    });

    if (i > 0 && i % 200 === 0) {
      if (typeof progressCb === 'function') {
        progressCb({
          stage: 'rows',
          message: `Mapping tracks... ${Math.min(99, Math.round(((i - 1) / totalRows) * 100))}%`,
        });
      }
      await yieldToBrowser();
    }
  }
  dlog('csvRowsToTracks', {
    rowCount: rows.length,
    trackCount: tracks.length,
    headerCount: header.length,
  });
  return tracks;
}

async function handleCsvFileImport(file, progressCb = null) {
  if (!file) return;
  dlog('handleCsvFileImport:start', {
    fileName: file.name,
    fileSize: file.size || null,
  });
  progressCb?.({ stage: 'read', message: 'Reading file...' });
  const text = await file.text();
  progressCb?.({ stage: 'parse', message: 'Parsing CSV...' });
  const rows = await parseCsvTextAsync(text, progressCb);
  progressCb?.({ stage: 'rows', message: 'Mapping tracks...' });
  const tracks = await csvRowsToTracksAsync(rows, progressCb);
  if (!tracks.length) {
    throw new Error('No track rows found in CSV.');
  }

  const name = file.name.replace(/\.csv$/i, '');
  state.selectedPlaylistId = null;
  state.selectedPlaylistMeta = {
    name,
    owner: 'CSV Import',
    totalTracks: tracks.length,
    followers: 'n/a',
  };
  state.baseTracks = tracks.map((track, index) => ({ ...track, customOrder: index }));
  state.workingTracks = cloneTracks(state.baseTracks);
  state.filteredTracks = [];
  state.filterActive = false;
  state.renderTracks = [];
  state.history = { past: [], future: [] };
  state.duplicateReport = analysis.findDuplicates(state.workingTracks);
  state.tableSort = { field: null, direction: null };
  updateHistoryButtons();
  applyFilterSnapshot({});
  const filterCount = get('filterCount');
  if (filterCount) {
    filterCount.textContent = 'Filtered tracks: 0';
  }

  await setSourceMode('csv');
  renderPlaylists();
  renderPlaylistHeader();
  progressCb?.({ stage: 'render', message: 'Rendering imported tracks...' });
  await renderCurrentView({ resetScroll: true, rebuildColumns: true });
  renderDuplicates();
  renderTransitionDiagnostics();
  dlog('handleCsvFileImport:done', {
    fileName: file.name,
    tracks: tracks.length,
    renderedTracks: state.renderTracks.length,
  });
  setMessage(`Imported CSV "${name}" with ${tracks.length} tracks.`);
}

function renderDuplicates() {
  if (!state.duplicateReport) {
    get('dedupeResults').textContent = 'No dedupe analysis run yet.';
    return;
  }
  const { exactGroups, nearGroups, mergeGroups = [] } = state.duplicateReport;
  if (!mergeGroups.length) {
    get('dedupeResults').innerHTML = '<div class="subtle">No duplicate groups found in this playlist.</div>';
    return;
  }

  const summary = `<div class="results-summary">Found ${exactGroups.length} exact group(s) and ${nearGroups.length} near-duplicate group(s). Checked tracks will be removed when you apply merge.</div>`;
  const groupsHtml = mergeGroups
    .map((group, groupIndex) => {
      const kindLabel = group.kind === 'exact' ? 'Exact Match' : 'Possible Duplicate';
      const leadTrack = group.items[0]?.track;
      return `
        <div class="diagnostic-item dedupe-group-card">
          <div class="diagnostic-line">
            <span class="diagnostic-title">${escapeHtml(kindLabel)} ${groupIndex + 1}${leadTrack ? `: ${escapeHtml(leadTrack.title)}` : ''}</span>
            <span class="diagnostic-metrics">${group.items.length} tracks</span>
          </div>
          ${group.items
            .map(
              (entry) => `
                <label class="dedupe-choice">
                  <input type="checkbox" data-track-index="${entry.index}" ${entry.removeByDefault ? 'checked' : ''} />
                  <span class="dedupe-choice-main">${escapeHtml(entry.track.title)}<span class="subtle-inline">${escapeHtml(entry.track.artistDisplay || 'Unknown Artist')}</span></span>
                  <span class="dedupe-choice-meta">keep:${fmt(entry.keepScore, 4)}${group.kind === 'near' ? ` | match:${fmt(entry.pairScore, 1)}` : ''}</span>
                  ${entry.recommendedKeep ? '<span class="recommended-chip">keep</span>' : ''}
                </label>
              `
            )
            .join('')}
        </div>
      `;
    })
    .join('');

  get('dedupeResults').innerHTML = `${summary}${groupsHtml}`;
}

function applySelectedDuplicateMerges() {
  const checked = Array.from(get('dedupeResults').querySelectorAll('input[data-track-index]:checked'))
    .map((input) => Number(input.dataset.trackIndex))
    .filter((value) => Number.isInteger(value) && value >= 0);

  if (!checked.length) {
    setMessage('No duplicate tracks are checked for removal.');
    return;
  }

  const removeSet = new Set(checked);
  const nextTracks = state.workingTracks.filter((_, index) => !removeSet.has(index));
  const removedCount = state.workingTracks.length - nextTracks.length;
  if (!removedCount) {
    setMessage('No duplicate tracks were removed.');
    return;
  }

  commitWorkingTracks(nextTracks, `Merged duplicates and removed ${removedCount} track(s)`);
  state.duplicateReport = analysis.findDuplicates(state.workingTracks);
  renderDuplicates();
  setMessage(`Removed ${removedCount} duplicate track(s).`);
}

function renderOutliers() {
  const report = analysis.detectOutliers(state.workingTracks);
  const html = report
    .map(
      ({ index, track, outlierScore, strongestReason, reasons }) => `
        <div class="diagnostic-item">
          <div class="diagnostic-line">
            <span class="diagnostic-title">${escapeHtml(track.title)}<span class="subtle-inline">${escapeHtml(track.artistDisplay || 'Unknown Artist')}</span></span>
            <span class="diagnostic-metrics">score:${fmt(outlierScore, 3)}</span>
          </div>
          <div class="diagnostic-reason">${escapeHtml(strongestReason || reasons?.[0] || 'Audio profile deviates from playlist center.')}</div>
          <div class="diagnostic-actions">
            <button class="btn btn-small" type="button" data-remove-outlier-index="${index}">Remove</button>
          </div>
        </div>
      `
    )
    .join('');
  get('outliersResult').innerHTML = html || 'No outliers detected.';
}

function removeOutlierTrack(index) {
  if (!Number.isInteger(index) || index < 0 || index >= state.workingTracks.length) {
    return;
  }
  const track = state.workingTracks[index];
  if (!track) return;
  removeTracksByReference([track]);
  renderOutliers();
}

function getMixOptions() {
  const mode = get('mixModeSelect').value || 'generic';
  const weights = getCurrentSliderWeights();
  const { normalized, total } = normalizeWeightsIfNeeded(weights);
  if (total > 1) {
    setSliderWeights(normalized);
    updateMixWeightSummary();
  }
  return {
    mode,
    weights: normalized,
    artistAvoidance: getArtistAvoidanceOptions(),
  };
}

function renderTransitionDiagnostics() {
  if (state.workingTracks.length < 2) {
    get('transitionResults').textContent = 'Need at least 2 tracks for diagnostics.';
    return;
  }
  const diagnostics = analysis.computeTransitionDiagnostics(state.workingTracks, getMixOptions());
  get('transitionResults').innerHTML = diagnostics
    .map(
      (row) => `
        <div class="diagnostic-item transition-item">
          <div class="diagnostic-line">
            <span class="diagnostic-title">${escapeHtml(`${row.index + 1}. ${row.fromTitle} → ${row.toTitle}`)}</span>
            <span class="diagnostic-metrics">score:${fmt(row.score, 3)} | pair:${fmt(row.transitionScore, 3)} | dBPM:${fmt(row.bpmDelta, 2)} | harmonic:${fmt(row.harmonicScore, 3)} | artist:${fmt(row.artistSpacingBonus, 3)}</span>
          </div>
        </div>
      `
    )
    .join('');
}

async function refreshSetupState() {
  state.setup = auth.getSetupState();
  renderSetupState();
}

async function testAndSaveSetupWizard() {
  const clientId = get('setupClientId').value.trim();
  const redirectUri = get('setupRedirectUri').value.trim();
  const testResult = auth.testSetupConfig({ clientId, redirectUri });
  auth.saveSetup({ clientId, redirectUri: testResult.redirectUri });
  get('setupRedirectUri').value = testResult.redirectUri;
  setSetupMessage('Config test passed and settings saved. You can now sign in.');
  await refreshSetupState();
}

async function refreshAuthAndUser() {
  // Try to restore session from refresh token if access token is expired.
  await auth.tryAutoRefresh();
  state.auth = auth.getAuthState();
  dlog('refreshAuthAndUser', state.auth);

  if (state.auth.authenticated) {
    state.user = await auth.loadCurrentUser();
    get('userLabel').textContent = `${state.user.display_name || state.user.id}`;
  } else {
    state.user = null;
    get('userLabel').textContent = '';
  }

  renderAuthState();
}

async function loadPlaylists() {
  dlog('loadPlaylists:start', {
    authenticated: state.auth?.authenticated || false,
  });
  if (!state.auth?.authenticated) {
    state.playlists = [];
    renderPlaylists();
    return;
  }
  state.playlists = applyPlaylistTrackCountHints(await api.fetchCurrentUserPlaylists());
  dlog('loadPlaylists:done', {
    count: state.playlists.length,
  });
  renderPlaylists();
}

async function loadPlaylist(playlistId) {
  dlog('loadPlaylist:start', { playlistId });
  state.selectedPlaylistId = playlistId;
  const requestId = state.playlistLoadRequestId + 1;
  state.playlistLoadRequestId = requestId;
  dlog('loadPlaylist:requestCreated', { playlistId, requestId });

  // Reset current table state immediately so stale rows are never shown during a new load.
  state.selectedPlaylistMeta = null;
  state.baseTracks = [];
  state.workingTracks = [];
  state.filteredTracks = [];
  state.filterActive = false;
  state.renderTracks = [];

  setTableLoading(true);
  try {
    await setSourceMode('spotify');
    await renderCurrentView({ resetScroll: false, rebuildColumns: true });
    setMessage('Loading playlist...');

    const payload = await api.fetchPlaylistWithMetadata(playlistId, (progress) => {
      if (!progress || playlistId !== state.selectedPlaylistId) return;
      dlog('loadPlaylist:progress', {
        playlistId,
        requestId,
        ...progress,
      });
      const { loadedItems, totalItems, completedBatches, totalBatches, message } = progress;
      if (Number.isFinite(loadedItems) && Number.isFinite(totalItems) && totalItems > 0) {
        const pct = Math.min(100, Math.round((loadedItems / totalItems) * 100));
        setMessage(`${message || 'Loading playlist...'} ${pct}%`);
        return;
      }
      if (Number.isFinite(completedBatches) && Number.isFinite(totalBatches) && totalBatches > 0) {
        const pct = Math.min(100, Math.round((completedBatches / totalBatches) * 100));
        setMessage(`${message || 'Loading playlist...'} ${pct}%`);
        return;
      }
      setMessage(message || 'Loading playlist...');
    });

    if (requestId !== state.playlistLoadRequestId || playlistId !== state.selectedPlaylistId) {
      dlog('loadPlaylist:staleResultIgnored', { playlistId, requestId, activeRequestId: state.playlistLoadRequestId });
      return;
    }

    setPlaylistTrackCountHint(payload.playlist.id, payload.playlist.totalTracks);
    state.selectedPlaylistMeta = payload.playlist;
    state.playlists = applyPlaylistTrackCountHints(
      state.playlists.map((playlist) =>
        playlist.id === playlistId
          ? { ...playlist, totalTracks: payload.playlist.totalTracks }
          : playlist
      )
    );
    state.baseTracks = payload.tracks.map((track, index) => ({ ...track, customOrder: index }));
    state.workingTracks = cloneTracks(state.baseTracks);
    state.filteredTracks = [];
    state.filterActive = false;
    state.renderTracks = [];
    state.history = { past: [], future: [] };
    state.duplicateReport = analysis.findDuplicates(state.workingTracks);
    updateHistoryButtons();
    applyFilterSnapshot({});
    const filterCount = get('filterCount');
    if (filterCount) {
      filterCount.textContent = 'Filtered tracks: 0';
    }
    renderPlaylists();
    renderPlaylistHeader();
    await renderCurrentView({ resetScroll: true, rebuildColumns: true });
    renderDuplicates();
    renderTransitionDiagnostics();
    dlog('loadPlaylist:done', {
      playlistId,
      requestId,
      tracks: state.workingTracks.length,
      renderedTracks: state.renderTracks.length,
    });
    setMessage(`Loaded ${state.workingTracks.length} tracks.`);
  } catch (error) {
    dlog('loadPlaylist:error', { playlistId, message: String(error?.message || error) });
    const text = String(error?.message || error);
    if (text.includes('403')) {
      setMessage(
        'This playlist is not accessible with the current token/scopes (Spotify returned 403). Try signing out and signing in again, then reload.',
        true
      );
    } else {
      setMessage(text, true);
    }
  } finally {
    setTableLoading(false);
  }
}

function resetToOriginalOrder() {
  state.tableSort = { field: null, direction: null };
  commitWorkingTracks(state.baseTracks, 'Reset to original order');
  state.filterActive = false;
  applyFilterSnapshot({});
  const filterCount = get('filterCount');
  if (filterCount) {
    filterCount.textContent = 'Filtered tracks: 0';
  }
  setMessage('Reset to original Spotify order.');
}

function isValidSpotifyTrackUri(uri) {
  return typeof uri === 'string' && uri.startsWith('spotify:track:') && uri.length > 14;
}

async function exportCurrentViewToPlaylist() {
  dlog('exportCurrentViewToPlaylist:start');
  if (!state.workingTracks.length) return;
  if (!state.auth?.authenticated) {
    setMessage('Sign in first to export a playlist.', true);
    return;
  }
  const visible = getVisibleTracks();
  if (!visible.length) {
    setMessage('No tracks are visible to export.', true);
    return;
  }

  const validUris = visible.map((track) => track.uri).filter(isValidSpotifyTrackUri);
  const skippedCount = visible.length - validUris.length;

  const defaultName = `${state.selectedPlaylistMeta?.name || 'Playlist'} - export`;
  const existingNames = new Set(
    (state.playlists || []).map((p) => String(p?.name || '').trim().toLowerCase()).filter(Boolean)
  );
  const payload = {
    defaultName,
    visibleCount: visible.length,
    uriCount: validUris.length,
    skippedCount,
    validUris,
    existingNames,
  };
  openExportReviewModal(payload);
}

function openExportReviewModal(payload) {
  const modal = get('exportReviewModal');
  if (!modal) return;
  modal.classList.remove('hidden');

  const nameInput = get('exportPlaylistName');
  const nameError = get('exportNameError');
  const summary = get('exportReviewSummary');
  const confirmBtn = get('confirmExportBtn');

  const existingNames = payload.existingNames || new Set();
  const defaultName = payload.defaultName || 'Playlist - export';
  nameInput.value = defaultName;
  const skippedNote = payload.skippedCount
    ? ` (${payload.skippedCount} tracks without valid Spotify URIs will be skipped)`
    : '';
  summary.textContent = `Tracks to export: ${payload.visibleCount}. Valid Spotify URIs: ${payload.uriCount}.${skippedNote}`;

  const validate = () => {
    const current = nameInput.value.trim();
    const normalized = current.toLowerCase();
    if (!state.auth?.authenticated) {
      nameError.textContent = 'You must be signed in to export.';
      confirmBtn.disabled = true;
      return null;
    }
    if (!current) {
      nameError.textContent = 'Playlist name is required.';
      confirmBtn.disabled = true;
      return null;
    }
    if (existingNames.has(normalized)) {
      nameError.textContent = 'A playlist with this name already exists. Choose a different name.';
      confirmBtn.disabled = true;
      return null;
    }
    nameError.textContent = '';
    confirmBtn.disabled = false;
    return current;
  };

  const onInput = () => validate();
  nameInput.oninput = onInput;
  validate();

  confirmBtn.onclick = async () => {
    const finalName = validate();
    if (!finalName) return;
    confirmBtn.disabled = true;
    try {
      const uris = payload.validUris || getVisibleTracks().map((track) => track.uri).filter(isValidSpotifyTrackUri);
      if (!uris.length) {
        nameError.textContent = 'No valid Spotify track URIs to export.';
        confirmBtn.disabled = false;
        return;
      }
      const result = await api.createPlaylistFromTracks({
        name: finalName,
        description: 'Exported from current view in Spotify Manager',
        public: false,
        trackUris: uris,
      });
      upsertPlaylistSummary({
        id: result.id,
        name: result.name,
        totalTracks: payload.uriCount,
      });
      closeExportReviewModal();
      await loadPlaylists();
      upsertPlaylistSummary({
        id: result.id,
        name: result.name,
        totalTracks: payload.uriCount,
      });
      renderPlaylists();
      setMessage(`Export complete: ${result.name}`);
    } catch (error) {
      const msg = String(error?.message || error);
      nameError.textContent = msg;
      confirmBtn.disabled = false;
    }
  };
}

function closeExportReviewModal() {
  const modal = get('exportReviewModal');
  if (!modal) return;
  modal.classList.add('hidden');
}

function bindKeyboardShortcuts() {
  document.addEventListener('keydown', (event) => {
    const tag = String(document.activeElement?.tagName || '').toLowerCase();
    const editing = tag === 'input' || tag === 'textarea' || tag === 'select';
    if (editing) return;

    if (event.key === 'Delete') {
      event.preventDefault();
      removeSelectedRows();
      return;
    }

    if (event.ctrlKey && !event.shiftKey && event.key.toLowerCase() === 'z') {
      event.preventDefault();
      undoLastOperation();
      return;
    }

    if (event.ctrlKey && !event.shiftKey && event.key.toLowerCase() === 'y') {
      event.preventDefault();
      redoLastOperation();
    }
  });
}

function saveWeightPreset() {
  const name = get('weightPresetName').value.trim();
  if (!name) {
    setMessage('Enter a weight preset name first.', true);
    return;
  }
  const options = getMixOptions();
  state.weightPresets[name] = {
    mode: options.mode,
    weights: options.weights,
    artistAvoidance: options.artistAvoidance,
  };
  saveObjectToStorage(STORAGE_KEYS.weightPresets, state.weightPresets);
  refreshPresetSelect('weightPresetSelect', state.weightPresets, 'Choose weights preset');
  get('weightPresetSelect').value = name;
  setMessage(`Saved weights preset: ${name}`);
}

function loadWeightPreset() {
  const name = get('weightPresetSelect').value;
  const preset = state.weightPresets[name];
  if (!name || !preset) {
    setMessage('Choose a weights preset to load.', true);
    return;
  }
  get('mixModeSelect').value = preset.mode || 'generic';
  setSliderWeights(preset.weights || {});
  setArtistAvoidanceOptions(preset.artistAvoidance || DEFAULT_ARTIST_AVOIDANCE);
  updateMixWeightSummary();
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

async function bindEvents() {
  get('loginBtn').addEventListener('click', async () => {
    try {
      if (!state.setup?.hasClientId) {
        openSetupModal();
        setMessage('Run setup wizard first to configure your Spotify Client ID.', true);
        return;
      }
      setMessage('Redirecting to Spotify sign-in...');
      await auth.beginLogin();
      // Page will redirect — won't reach here
    } catch (error) {
      setMessage(error.message, true);
    }
  });

  get('logoutBtn').addEventListener('click', async () => {
    auth.logout();
    await refreshAuthAndUser();
    state.playlists = [];
    state.selectedPlaylistId = null;
    state.selectedPlaylistMeta = null;
    state.baseTracks = [];
    state.workingTracks = [];
    state.filteredTracks = [];
    state.filterActive = false;
    state.renderTracks = [];
    await setSourceMode('spotify');
    renderPlaylists();
    await renderTable([], { resetScroll: false, rebuildColumns: true });
    setMessage('Signed out.');
  });

  get('importCsvBtn').addEventListener('click', openCsvImportModal);
  get('closeCsvImportModalBtn').addEventListener('click', closeCsvImportModal);
  get('openColumnsBtn').addEventListener('click', () => {
    renderColumnControls();
    get('columnPickerModal').classList.remove('hidden');
  });
  get('closeColumnPickerModalBtn').addEventListener('click', () => {
    get('columnPickerModal').classList.add('hidden');
    applyColumnVisibility();
  });
  get('selectAllColumnsBtn')?.addEventListener('click', () => {
    setAllColumnVisibility(true);
  });
  get('deselectAllColumnsBtn')?.addEventListener('click', () => {
    setAllColumnVisibility(false);
  });
  get('removeSelectedBtn').addEventListener('click', removeSelectedRows);
  get('toggleDebugBtn')?.addEventListener('click', () => {
    const next = setDebugState(!getDebugState());
    dlog('debug:toggleButton', { enabled: next });
    if (next) {
      showDebugPanel();
    }
    updateDebugControls();
  });
  get('toggleDebugPanelBtn')?.addEventListener('click', () => {
    const panel = get('debugPanel');
    if (!panel) return;
    if (panel.classList.contains('hidden')) {
      showDebugPanel();
      return;
    }
    hideDebugPanel();
  });
  get('copyDebugLogBtn')?.addEventListener('click', () => {
    copyDebugLog().catch((error) => setMessage(error.message, true));
  });
  get('clearDebugLogBtn')?.addEventListener('click', () => {
    clearDebugLogEntries();
    renderDebugLog();
    setMessage('Cleared debug log.');
  });

  const csvInput = get('csvFileInput');
  const dropzone = get('csvDropzone');
  dropzone.addEventListener('click', () => csvInput.click());
  dropzone.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      csvInput.click();
    }
  });
  dropzone.addEventListener('dragover', (event) => {
    event.preventDefault();
    dropzone.classList.add('drag-active');
  });
  dropzone.addEventListener('dragleave', () => {
    dropzone.classList.remove('drag-active');
  });
  dropzone.addEventListener('drop', (event) => {
    event.preventDefault();
    dropzone.classList.remove('drag-active');
    const file = event.dataTransfer?.files?.[0];
    if (!file) return;
    importCsvAndCloseModal(file, csvInput)
      .catch((error) => setCsvImportStatus(error.message, true));
  });
  csvInput.addEventListener('change', () => {
    const file = csvInput.files?.[0];
    if (!file) return;
    importCsvAndCloseModal(file, csvInput)
      .catch((error) => setCsvImportStatus(error.message, true));
  });

  get('openSetupWizardBtn').addEventListener('click', openSetupModal);
  get('closeSetupModalBtn').addEventListener('click', closeSetupModal);
  get('closeExportReviewModalBtn')?.addEventListener('click', closeExportReviewModal);
  get('cancelExportBtn')?.addEventListener('click', closeExportReviewModal);
  get('createEnvBtn').addEventListener('click', () =>
    testAndSaveSetupWizard().catch((error) => setSetupMessage(error.message, true))
  );

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
      // loadPlaylist already sets a targeted user-facing message.
    }
  });

  get('analyzeDuplicatesBtn').addEventListener('click', () => {
    if (!state.workingTracks.length) return;
    state.duplicateReport = analysis.findDuplicates(state.workingTracks);
    renderDuplicates();
    const totalGroups = state.duplicateReport?.mergeGroups?.length || 0;
    setMessage(`Duplicate analysis complete. Review ${totalGroups} group(s) below.`);
  });

  get('applyDedupeSelectionsBtn').addEventListener('click', applySelectedDuplicateMerges);

  get('shuffleBtn').addEventListener('click', () => {
    if (!state.workingTracks.length) return;
    const shuffled = analysis.shufflePasses(state.workingTracks, 1);
    commitWorkingTracks(shuffled, 'Shuffled');
    setMessage('Shuffled.');
  });

  get('mixAssistBtn').addEventListener('click', () => {
    try {
      if (!state.workingTracks.length) return;
      const mixed = analysis.optimizeMixOrder(state.workingTracks, getMixOptions());
      commitWorkingTracks(mixed, 'Applied Mix Assist');
      setMessage('Mix Assist ordering complete.');
    } catch (error) {
      setMessage(error.message, true);
    }
  });

  get('genreSequenceBtn').addEventListener('click', () => {
    try {
      if (!state.workingTracks.length) return;
      const sequenced = analysis.sequenceGenreClusters(state.workingTracks, getMixOptions());
      commitWorkingTracks(sequenced, 'Applied Genre Sequence');
      setMessage('Genre sequence ordering complete.');
    } catch (error) {
      setMessage(error.message, true);
    }
  });

  get('refreshTransitionsBtn').addEventListener('click', renderTransitionDiagnostics);

  get('mixModeSelect').addEventListener('change', () => {
    applyModePresetToSliders(get('mixModeSelect').value);
  });

  get('artistAvoidanceEnabled').addEventListener('change', () => {
    refreshArtistAvoidanceControl();
    updateMixWeightSummary();
  });

  get('artistAvoidanceStrength').addEventListener('input', () => {
    refreshArtistAvoidanceControl();
    updateMixWeightSummary();
  });

  get('outliersBtn').addEventListener('click', () => {
    if (!state.workingTracks.length) return;
    renderOutliers();
    setMessage('Outlier report generated.');
  });

  get('outliersResult').addEventListener('click', (event) => {
    const button = event.target.closest('[data-remove-outlier-index]');
    if (!button) return;
    removeOutlierTrack(Number(button.dataset.removeOutlierIndex));
  });

  get('resetOrderBtn').addEventListener('click', resetToOriginalOrder);
  get('exportBtn').addEventListener('click', () =>
    exportCurrentViewToPlaylist().catch((error) => setMessage(error.message, true))
  );

  get('undoBtn').addEventListener('click', undoLastOperation);
  get('redoBtn').addEventListener('click', redoLastOperation);

  FILTER_FIELD_IDS.forEach((id) => {
    const el = get(id);
    if (el) {
      el.addEventListener('input', applyCurrentFilters);
    }
  });

  get('activeFilterPills')?.addEventListener('click', (event) => {
    const pill = event.target.closest('[data-filter-field]');
    if (!pill) return;
    clearFieldFilter(pill.dataset.filterField);
  });

  get('saveWeightPresetBtn').addEventListener('click', saveWeightPreset);
  get('loadWeightPresetBtn').addEventListener('click', loadWeightPreset);
  get('deleteWeightPresetBtn').addEventListener('click', deleteWeightPreset);

}

async function init() {
  installDebugControls();
  dlog('init:start', {
    debugEnabled: getDebugState(),
    href: window.location.href,
  });
  const canonicalOriginResult = auth.ensureCanonicalLoopbackOrigin();
  if (canonicalOriginResult?.redirected) {
    return;
  }

  state.columnConfig = buildDefaultColumnConfig();

  // Eagerly create the table instance so it exists for all future renders.
  // Don't await tableBuilt here — it fires async after layout/paint.
  // The render queue handles waiting via the `ready` promise as-needed.
  initializeTable([]);

  setSourceMode('spotify');
  if (getDebugState()) {
    showDebugPanel();
  }
  bindRibbonTabs();
  syncPresetStateFromStorage();
  bindSetupCopyValues();
  bindHeaderFilterPopupEvents();
  let savedWeights = analysis.DEFAULT_WEIGHTS;
  try {
    const resp = await fetch(new URL('../../config/mix-weights.json', window.location.href));
    if (resp.ok) savedWeights = await resp.json();
  } catch { /* use defaults */ }
  renderMixWeightSliders(savedWeights);

  await bindEvents();
  bindKeyboardShortcuts();
  updateHistoryButtons();

  try {
    await refreshSetupState();
    const setupHint = get('setupRedirectHintInline');
    if (setupHint) setupHint.textContent = state.setup?.redirectUri || auth.getHostedRedirectUriForSetup();

    // Handle OAuth callback if redirected from Spotify
    try {
      const wasCallback = await auth.handleAuthCallback();
      if (wasCallback) {
        dlog('init:authCallbackHandled');
        setMessage('Signed in successfully.');
      }
    } catch (callbackError) {
      dlog('init:authCallbackError', {
        message: String(callbackError?.message || callbackError),
      });
      setMessage(String(callbackError?.message || callbackError), true);
    }

    if (!state.setup?.hasClientId) {
      openSetupModal();
      setSetupMessage('Enter your Spotify Client ID to get started.');
    }

    await refreshAuthAndUser();
    await loadPlaylists();
  } catch (error) {
    dlog('init:error', {
      message: String(error?.message || error),
    });
    setMessage(error.message, true);
  }
}

init();
