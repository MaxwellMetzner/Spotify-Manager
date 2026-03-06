import * as auth from '../auth.js';
import * as api from '../spotifyApi.js';

const analysis = window.PlaylistAnalysis;

const DEBUG_ENABLED = true;

function dlog(event, payload) {
  if (!DEBUG_ENABLED) return;
  const stamp = new Date().toISOString();
  if (payload === undefined) {
    console.log(`[SpotifyManager][${stamp}] ${event}`);
    return;
  }
  console.log(`[SpotifyManager][${stamp}] ${event}`, payload);
}

const STORAGE_KEYS = {
  weightPresets: 'spotifyManager.weightPresets.v2',
};

const FILTER_FIELD_IDS = [
  'filterTitle',
  'filterArtist',
  'filterGenre',
  'filterCamelot',
  'filterKeyMode',
  'filterTimeSig',
  'filterYearMin',
  'filterYearMax',
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
};

let tracksTable = null;

const MIX_WEIGHT_FIELDS = [
  ['bpm', 'BPM'],
  ['camelot', 'Camelot'],
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
  ['albumReleaseYear', 'Year'],
  ['addedAt', 'Added At'],
  ['addedBy', 'Added By'],
  ['durationMs', 'Duration (ms)'],
  ['bpm', 'BPM'],
  ['tempo', 'Tempo'],
  ['camelot', 'Camelot'],
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
    renderCurrentView({ resetScroll: false, rebuildColumns: true });
  }
}

function get(id) {
  return document.getElementById(id);
}

function cloneTracks(tracks) {
  return JSON.parse(JSON.stringify(tracks || []));
}

function setMessage(text, isError = false) {
  dlog('status', { text, isError });
  const el = get('messages');
  if (!el) return;
  el.textContent = text;
  el.style.color = isError ? '#ff9175' : '#9fd6c5';
}

function setSetupMessage(text, isError = false) {
  const el = get('setupModalStatus');
  el.textContent = text;
  el.style.color = isError ? '#ff9175' : '#9fd6c5';
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

function setSliderWeights(weights) {
  MIX_WEIGHT_FIELDS.forEach(([field]) => {
    const input = get(`mixWeight_${field}`);
    if (!input) return;
    const value = Number(weights?.[field] ?? 0);
    input.value = String(Math.round(Math.max(0, value) * 100));
  });
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
  if (totalPercent <= 100) {
    summary.textContent = `Total: ${totalPercent.toFixed(1)}%`;
  } else {
    summary.textContent = `Total: ${totalPercent.toFixed(1)}% (will normalize to 100%)`;
  }
}

function renderMixWeightSliders(initialWeights) {
  const host = get('mixWeightSliders');
  host.innerHTML = MIX_WEIGHT_FIELDS
    .map(
      ([field, label]) => `
      <label class="mix-slider-item" for="mixWeight_${field}">
        <span>${label}</span>
        <input id="mixWeight_${field}" type="range" min="0" max="100" step="1" />
        <span id="mixWeight_${field}_value" class="subtle"></span>
      </label>
    `
    )
    .join('');

  setSliderWeights(initialWeights || analysis.DEFAULT_WEIGHTS);

  MIX_WEIGHT_FIELDS.forEach(([field]) => {
    const input = get(`mixWeight_${field}`);
    const valueEl = get(`mixWeight_${field}_value`);
    const sync = () => {
      valueEl.textContent = `${input.value}%`;
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

function buildHeaderTitle(label, field) {
  const config = getHeaderFilterConfig(field);
  if (config.kind === 'none') {
    return `<span class="header-title">${label}</span>`;
  }
  const activeClass = isHeaderFieldFiltered(field) ? 'is-active' : '';
  return `<span class="header-title">${label}<span class="header-filter-icon ${activeClass}" title="Right-click to filter"></span></span>`;
}

function buildTabulatorColumns() {
  return activeColumns().map(([field, label]) => {
    const filterConfig = getHeaderFilterConfig(field);
    const width = state.columnConfig[field]?.width || 140;
    return {
      title: buildHeaderTitle(label, field),
      field,
      width,
      headerSort: true,
      resizable: true,
      headerContextMenu: (event) => {
        if (filterConfig.kind === 'none') return [];
        return [
          {
            label: 'Filter...',
            action: () => {
              setTimeout(() => openHeaderFilterPopup(field, event.clientX, event.clientY), 0);
            },
          },
          {
            label: 'Clear Filter',
            action: () => {
              clearFieldFilter(field);
            },
          },
        ];
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
  if (!tracksTable) return;
  columns.forEach(([field, label]) => {
    const col = tracksTable.getColumn(field);
    if (!col) return;
    const icon = col.getElement()?.querySelector('.header-filter-icon');
    if (!icon) {
      col.updateDefinition({ title: buildHeaderTitle(label, field) });
      return;
    }
    icon.classList.toggle('is-active', isHeaderFieldFiltered(field));
  });
}

function getActiveTableData() {
  if (!tracksTable) return [];
  return tracksTable.getData('active');
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
  setMessage(`Cleared header filter on ${field}.`);
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
        return `<span class="filter-pill">${prefix}${filter.field}: ${filter.min || '-inf'} to ${filter.max || 'inf'}</span>`;
      }
      if (filter.kind === 'set') {
        return `<span class="filter-pill">${prefix}${filter.field}: ${filter.values.join(', ')}</span>`;
      }
      return `<span class="filter-pill">${prefix}${filter.field}: ${filter.query}</span>`;
    })
    .join('');
}

function initializeTable() {
  if (tracksTable) return;
  dlog('initializeTable');
  tracksTable = new Tabulator('#tracksTable', {
    data: [],
    columns: buildTabulatorColumns(),
    layout: 'fitDataTable',
    movableColumns: true,
    resizableColumns: true,
    selectableRows: true,
    selectableRowsRangeMode: 'click',
    placeholder: 'No tracks to display.',
    rowContextMenu: [
      {
        label: 'Remove Song',
        action: (_, row) => removeTracksByReference([row.getData()]),
      },
    ],
    dataSorted: (sorters) => {
      const sorter = sorters?.[0] || null;
      state.tableSort = sorter
        ? { field: sorter.field, direction: sorter.dir }
        : { field: null, direction: null };
      state.renderTracks = getActiveTableData();
    },
    dataFiltered: () => {
      state.renderTracks = getActiveTableData();
    },
    columnMoved: () => {
      syncColumnConfigFromTable();
      renderColumnControls();
    },
    columnResized: () => {
      syncColumnConfigFromTable();
    },
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
    albumReleaseYear: { minId: 'filterYearMin', maxId: 'filterYearMax' },
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

  if (field === 'camelot') {
    return { kind: 'set', inputId: 'filterCamelot' };
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

function renderVisibleRows() {
  // Row count intentionally suppressed to keep one concise status message.
}

function setTableLoading(loading) {
  const wrap = get('tracksTableWrap');
  if (!wrap) return;
  wrap.classList.toggle('table-loading', loading);
}

function renderTable(tracks, options = {}) {
  const { resetScroll = true, rebuildColumns = false } = options;
  initializeTable();
  renderColumnControls();
  if (rebuildColumns) {
    tracksTable.setColumns(buildTabulatorColumns());
  }

  tracksTable.setData(tracks || []);
  if (state.tableSort.field && state.tableSort.direction) {
    tracksTable.setSort(state.tableSort.field, state.tableSort.direction);
  } else {
    if (typeof tracksTable.clearSort === 'function') {
      tracksTable.clearSort();
    } else {
      tracksTable.setSort([]);
    }
  }

  if (resetScroll) {
    const first = tracks?.[0];
    if (first) {
      tracksTable.scrollToRow(first, 'top', false).catch(() => {});
    }
  }

  state.renderTracks = getActiveTableData();
  refreshHeaderFilterVisuals();
  renderVisibleRows();
}

function getDisplayedTracks() {
  return selectedTracks();
}

function renderCurrentView(options = {}) {
  const { resetScroll = false, rebuildColumns = false } = options;
  renderTable(getDisplayedTracks(), { resetScroll, rebuildColumns });
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
  get('headerFilterTitle').textContent = `Filter: ${field}`;

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

function handleHeaderFilterPrompt(field, event) {
  if (!state.workingTracks.length) return;
  openHeaderFilterPopup(field, event.clientX, event.clientY);
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
  addSet('camelot', 'filterCamelot');
  addSet('keyModeLabel', 'filterKeyMode');

  const yearMin = getInputTrim('filterYearMin');
  const yearMax = getInputTrim('filterYearMax');
  if (yearMin || yearMax || state.filterNegations.albumReleaseYear) {
    addNegation('albumReleaseYear', {
      field: 'albumReleaseYear',
      kind: 'yearRange',
      min: yearMin,
      max: yearMax,
    });
  }

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
      return `<li><button class="${active}" data-playlist-id="${playlist.id}" ${disabled}>${playlist.name} <span class="subtle">(${countText})</span></button></li>`;
    })
    .join('');

  list.querySelectorAll('button[data-playlist-id]').forEach((button) => {
    button.addEventListener('click', () => loadPlaylist(button.dataset.playlistId));
  });

  const bulk = get('bulkPlaylistSelect');
  bulk.innerHTML = state.playlists
    .map((playlist) => `<option value="${playlist.id}">${playlist.name} (${playlist.totalTracks})</option>`)
    .join('');
}

function renderAuthState() {
  const auth = state.auth;
  const loginBtn = get('loginBtn');
  const logoutBtn = get('logoutBtn');
  get('authStatus').textContent = auth?.authenticated ? 'Connected to Spotify' : 'Not signed in';
  loginBtn.disabled = Boolean(auth?.authenticated);
  logoutBtn.disabled = !auth?.authenticated;

  if (auth?.authenticated) {
    const label = state.user?.display_name || state.user?.id || 'Signed In';
    loginBtn.textContent = label;
  } else {
    loginBtn.textContent = 'Sign In With Spotify';
  }
}

function renderSetupState() {
  const setup = state.setup;
  if (!setup) return;
  const setupBtn = get('openSetupWizardBtn');
  const recommendedRedirect = auth.getRecommendedRedirectUri();
  get('setupStatus').textContent = setup.hasClientId
    ? `Configured Client ID: ${setup.clientIdMasked}`
    : 'SPOTIFY_CLIENT_ID missing. Open setup wizard.';
  setupBtn.classList.remove('hidden');
  get('setupRedirectUri').value = setup.redirectUri || recommendedRedirect;

  const setupHint = get('setupRedirectHintInline');
  if (setupHint) {
    setupHint.textContent = setup.redirectUri || recommendedRedirect;
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
  const removeSet = new Set(trackRefs || []);
  if (!removeSet.size) return;
  const nextTracks = state.workingTracks.filter((track) => !removeSet.has(track));
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
  state.duplicateReport = analysis.findDuplicates(state.workingTracks);
  renderDuplicates();
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
  state.duplicateReport = analysis.findDuplicates(state.workingTracks);
  renderDuplicates();
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
  state.duplicateReport = analysis.findDuplicates(state.workingTracks);
  renderDuplicates();
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
  const el = get('csvImportStatus');
  el.textContent = text;
  el.style.color = isError ? '#ff9175' : '#9fd6c5';
}

function parseCsvText(content) {
  const rows = [];
  let current = '';
  let row = [];
  let inQuotes = false;

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
  }

  if (current.length > 0 || row.length > 0) {
    row.push(current);
    rows.push(row);
  }
  return rows.filter((r) => r.some((cell) => String(cell || '').trim().length));
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

function parseYearFromDateLike(value) {
  const text = String(value || '').trim();
  if (!text) return null;
  const year = Number(text.slice(0, 4));
  return Number.isFinite(year) ? year : null;
}

function toCamelotFromKeyMode(key, mode) {
  const k = Number(key);
  const m = Number(mode);
  if (!Number.isFinite(k) || !Number.isFinite(m)) return null;
  const major = {
    0: '8B',
    1: '3B',
    2: '10B',
    3: '5B',
    4: '12B',
    5: '7B',
    6: '2B',
    7: '9B',
    8: '4B',
    9: '11B',
    10: '6B',
    11: '1B',
  };
  const minor = {
    0: '5A',
    1: '12A',
    2: '7A',
    3: '2A',
    4: '9A',
    5: '4A',
    6: '11A',
    7: '6A',
    8: '1A',
    9: '8A',
    10: '3A',
    11: '10A',
  };
  return m === 1 ? major[k] || null : minor[k] || null;
}

function csvRowsToTracks(rows) {
  if (rows.length < 2) return [];
  const header = rows[0].map((item) => String(item || '').trim());
  const indexMap = new Map(header.map((name, idx) => [name, idx]));
  const read = (cells, name) => {
    const idx = indexMap.get(name);
    return idx === undefined ? '' : String(cells[idx] ?? '').trim();
  };

  const tracks = [];
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
      albumReleaseYear: parseYearFromDateLike(read(cells, 'Release Date')),
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
      camelot: toCamelotFromKeyMode(key, mode),
      analysisAvailable: false,
    });
  }
  return tracks;
}

async function handleCsvFileImport(file) {
  if (!file) return;
  const text = await file.text();
  const rows = parseCsvText(text);
  const tracks = csvRowsToTracks(rows);
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
  state.history = { past: [], future: [] };
  state.duplicateReport = analysis.findDuplicates(state.workingTracks);
  state.tableSort = { field: null, direction: null };
  updateHistoryButtons();
  applyFilterSnapshot({});
  const filterCount = get('filterCount');
  if (filterCount) {
    filterCount.textContent = 'Filtered tracks: 0';
  }

  setSourceMode('csv');
  renderPlaylists();
  renderPlaylistHeader();
  renderCurrentView({ resetScroll: true });
  renderDuplicates();
  renderTransitionDiagnostics();
  setMessage(`Imported CSV "${name}" with ${tracks.length} tracks.`);
}

function showNearDuplicateModal() {
  get('nearDuplicateModal').classList.remove('hidden');
}

function hideNearDuplicateModal() {
  get('nearDuplicateModal').classList.add('hidden');
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
      `<div>${group.map((entry) => `${entry.track.title} (${entry.track.artistDisplay})`).join(' | ')}</div>`
    );
  });
  section.push(`<div>Near duplicate groups: ${nearGroups.length}</div>`);
  nearGroups.forEach((group) => {
    section.push(
      `<div>${group
        .map((entry) => `${entry.track.title} [keep:${entry.keepScore}] [match:${entry.pairScore}]`)
        .join(' | ')}</div>`
    );
  });
  get('dedupeResults').innerHTML = section.join('<hr/>');
}

function renderNearDuplicateModal() {
  const root = get('nearDuplicateGroups');
  if (!state.duplicateReport?.nearGroups?.length) {
    root.innerHTML = '<div class="subtle">No near-duplicate groups found for this playlist.</div>';
    return;
  }

  root.innerHTML = state.duplicateReport.nearGroups
    .map((group, groupIndex) => {
      const bestScore = Math.max(...group.map((item) => item.keepScore || 0));
      const items = group
        .map((entry, trackIndex) => {
          const id = `nearDup-${groupIndex}-${trackIndex}`;
          const isRecommended = entry.keepScore === bestScore;
          return `
            <label class="modal-track-row" for="${id}">
              <input id="${id}" type="checkbox" data-group-index="${groupIndex}" data-track-index="${trackIndex}" checked />
              <span>${entry.track.title} - ${entry.track.artistDisplay} | keep:${entry.keepScore} | match:${entry.pairScore}</span>
              ${isRecommended ? '<span class="recommended-chip">recommended</span>' : ''}
            </label>
          `;
        })
        .join('');
      return `<div class="modal-group"><strong>Group ${groupIndex + 1}</strong>${items}</div>`;
    })
    .join('');
}

function keepRecommendedOnly() {
  const checkboxes = Array.from(get('nearDuplicateGroups').querySelectorAll('input[type="checkbox"]'));
  checkboxes.forEach((box) => {
    box.checked = false;
  });
  state.duplicateReport.nearGroups.forEach((group, groupIndex) => {
    const best = group.reduce((acc, item, index) => {
      if (!acc || item.keepScore > acc.keepScore) {
        return { keepScore: item.keepScore, index };
      }
      return acc;
    }, null);
    if (best) {
      const recommended = get(`nearDup-${groupIndex}-${best.index}`);
      if (recommended) recommended.checked = true;
    }
  });
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

  const nextTracks = state.workingTracks.filter((track) => !removeSet.has(track));
  commitWorkingTracks(nextTracks, `Removed ${removeSet.size} near-duplicate tracks`);
  hideNearDuplicateModal();
  setMessage(`Removed ${removeSet.size} near-duplicate track(s).`);
}

function renderOutliers() {
  const report = analysis.detectOutliers(state.workingTracks).slice(0, 12);
  const html = report
    .map(
      ({ track, outlierScore, strongestReason }) =>
        `<div><strong>${track.title}</strong> - ${track.artistDisplay} | score: ${outlierScore}<br/>${
          strongestReason || 'Audio profile deviates from playlist center.'
        }</div>`
    )
    .join('<hr/>');
  get('outliersResult').innerHTML = html || 'No outliers detected.';
}

function getMixOptions() {
  const mode = get('mixModeSelect').value || 'balanced';
  const weights = getCurrentSliderWeights();
  const { normalized, total } = normalizeWeightsIfNeeded(weights);
  if (total > 1) {
    setSliderWeights(normalized);
    updateMixWeightSummary();
  }
  return { mode, weights: normalized };
}

function normalizeTrackKeys(tracks) {
  const occurrence = new Map();
  return tracks.map((track) => {
    const base = track.uri || `${track.trackId || ''}-${track.title || ''}-${track.artistDisplay || ''}`;
    const next = (occurrence.get(base) || 0) + 1;
    occurrence.set(base, next);
    return `${base}#${next}`;
  });
}

function renderDryRunDiff() {
  if (!state.baseTracks.length || !state.workingTracks.length) {
    get('diffResults').textContent = 'Load a playlist to preview changes.';
    return;
  }
  const baseKeys = normalizeTrackKeys(state.baseTracks);
  const workKeys = normalizeTrackKeys(state.workingTracks);

  const baseIndex = new Map(baseKeys.map((key, index) => [key, index]));
  const workIndex = new Map(workKeys.map((key, index) => [key, index]));

  const removed = [];
  const added = [];
  const moved = [];

  baseKeys.forEach((key) => {
    if (!workIndex.has(key)) removed.push(key);
  });
  workKeys.forEach((key) => {
    if (!baseIndex.has(key)) added.push(key);
  });
  workKeys.forEach((key) => {
    if (baseIndex.has(key) && workIndex.get(key) !== baseIndex.get(key)) {
      moved.push({ key, from: baseIndex.get(key), to: workIndex.get(key) });
    }
  });

  const details = [
    `<div>Moved: ${moved.length}</div>`,
    `<div>Removed: ${removed.length}</div>`,
    `<div>Added: ${added.length}</div>`,
  ];

  moved.slice(0, 30).forEach((item) => {
    const fromTrack = state.baseTracks[item.from];
    details.push(`<div>${fromTrack?.title || item.key}: ${item.from + 1} -> ${item.to + 1}</div>`);
  });

  get('diffResults').innerHTML = details.join('<hr/>');
}

function renderTransitionDiagnostics() {
  if (state.workingTracks.length < 2) {
    get('transitionResults').textContent = 'Need at least 2 tracks for diagnostics.';
    return;
  }
  const diagnostics = analysis
    .computeTransitionDiagnostics(state.workingTracks, getMixOptions())
    .slice(0, 40);
  get('transitionResults').innerHTML = diagnostics
    .map(
      (row) =>
        `<div>${row.index + 1}. ${row.fromTitle} -> ${row.toTitle} | score:${row.score} | dBPM:${fmt(
          row.bpmDelta,
          2
        )} | camelot:${row.camelotDistance}</div>`
    )
    .join('<hr/>');
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
  state.auth = auth.getAuthState();

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
  if (!state.auth?.authenticated) {
    state.playlists = [];
    renderPlaylists();
    return;
  }
  state.playlists = await api.fetchCurrentUserPlaylists();
  renderPlaylists();
}

async function loadPlaylist(playlistId) {
  dlog('loadPlaylist:start', { playlistId });
  state.selectedPlaylistId = playlistId;
  const requestId = state.playlistLoadRequestId + 1;
  state.playlistLoadRequestId = requestId;

  // Reset current table state immediately so stale rows are never shown during a new load.
  state.baseTracks = [];
  state.workingTracks = [];
  state.filteredTracks = [];
  state.filterActive = false;

  setTableLoading(true);
  setSourceMode('spotify');
  setMessage('Loading playlist...');
  try {
    const payload = await api.fetchPlaylistWithMetadata(playlistId, (progress) => {
      if (!progress || playlistId !== state.selectedPlaylistId) return;
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

    state.selectedPlaylistMeta = payload.playlist;
    state.baseTracks = payload.tracks.map((track, index) => ({ ...track, customOrder: index }));
    state.workingTracks = cloneTracks(state.baseTracks);
    state.filteredTracks = [];
    state.filterActive = false;
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
    setTableLoading(false);
    renderCurrentView({ resetScroll: true });
    renderDuplicates();
    renderTransitionDiagnostics();
    setMessage(`Loaded ${state.workingTracks.length} tracks.`);
  } catch (error) {
    dlog('loadPlaylist:error', { playlistId, message: String(error?.message || error) });
    setTableLoading(false);
    const text = String(error?.message || error);
    if (text.includes('403')) {
      setMessage(
        'This playlist is not accessible with the current token/scopes (Spotify returned 403). Try signing out and signing in again, then reload.',
        true
      );
    } else {
      setMessage(text, true);
    }
    throw error;
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

async function exportCurrentViewToPlaylist() {
  dlog('exportCurrentViewToPlaylist:start');
  if (!state.workingTracks.length) return;
  if (!state.auth?.authenticated) {
    setMessage('Sign in first to export a playlist.', true);
    return;
  }
  const visible = state.renderTracks || [];
  if (!visible.length) {
    setMessage('No tracks are visible to export.', true);
    return;
  }

  const defaultName = `${state.selectedPlaylistMeta?.name || 'Playlist'} - export`;
  const existingNames = new Set(
    (state.playlists || []).map((p) => String(p?.name || '').trim().toLowerCase()).filter(Boolean)
  );
  const payload = {
    defaultName,
    visibleCount: visible.length,
    uriCount: visible.map((track) => track.uri).filter(Boolean).length,
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
  summary.textContent = `Tracks to export: ${payload.visibleCount}. Valid Spotify URIs: ${payload.uriCount}.`;

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
      const visible = state.renderTracks || [];
      const result = await api.createPlaylistFromTracks({
        name: finalName,
        description: 'Exported from current view in Spotify Manager',
        public: false,
        trackUris: visible.map((track) => track.uri).filter(Boolean),
      });
      closeExportReviewModal();
      await loadPlaylists();
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
  get('mixModeSelect').value = preset.mode || 'balanced';
  setSliderWeights(preset.weights || {});
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

async function runBulkOperation() {
  dlog('runBulkOperation:start');
  if (!state.auth?.authenticated) {
    setMessage('Sign in first to run bulk playlist operations.', true);
    return;
  }
  const selectedOptions = Array.from(get('bulkPlaylistSelect').selectedOptions || []);
  if (!selectedOptions.length) {
    setMessage('Select one or more playlists for bulk operation.', true);
    return;
  }

  const operation = get('bulkOperationSelect').value;
  const filters = buildFiltersFromInputs();
  const mixOptions = getMixOptions();
  const lines = [];

  for (const option of selectedOptions) {
    const playlistId = option.value;
    try {
      const payload = await api.fetchPlaylistWithMetadata(playlistId);
      let tracks = payload.tracks;
      if (operation === 'mix') {
        tracks = analysis.optimizeMixOrder(tracks, mixOptions);
      } else {
        tracks = analysis.applyFilters(tracks, filters);
      }
      const uris = tracks.map((track) => track.uri).filter(Boolean);
      if (!uris.length) {
        lines.push(`${payload.playlist.name}: no tracks matched operation.`);
        continue;
      }
      const result = await api.createPlaylistFromTracks({
        name: `${payload.playlist.name} - ${operation === 'mix' ? 'mix copy' : 'filtered copy'}`,
        description: `Bulk operation: ${operation}`,
        public: false,
        trackUris: uris,
      });
      lines.push(`${payload.playlist.name}: created ${result.name}`);
    } catch (error) {
      lines.push(`${option.textContent}: failed (${error.message})`);
    }
  }

  get('bulkResults').innerHTML = lines.map((line) => `<div>${line}</div>`).join('<hr/>');
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
    state.workingTracks = [];
    setSourceMode('spotify');
    renderPlaylists();
    renderTable([]);
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
    handleCsvFileImport(file)
      .then(() => {
        setCsvImportStatus(`Imported: ${file.name}`);
        closeCsvImportModal();
      })
      .catch((error) => setCsvImportStatus(error.message, true));
  });
  csvInput.addEventListener('change', () => {
    const file = csvInput.files?.[0];
    if (!file) return;
    handleCsvFileImport(file)
      .then(() => {
        setCsvImportStatus(`Imported: ${file.name}`);
        closeCsvImportModal();
        csvInput.value = '';
      })
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
    renderNearDuplicateModal();
    const nearCount = state.duplicateReport?.nearGroups?.length || 0;
    setMessage(`Duplicate analysis complete. Near-duplicate groups: ${nearCount}.`);
  });

  get('resolveNearDuplicatesBtn').addEventListener('click', () => {
    if (!state.workingTracks.length) return;
    state.duplicateReport = analysis.findDuplicates(state.workingTracks);
    renderNearDuplicateModal();
    showNearDuplicateModal();
  });

  get('applyExactDedupeBtn').addEventListener('click', () => {
    if (!state.workingTracks.length) return;
    state.duplicateReport = analysis.findDuplicates(state.workingTracks);
    const deduped = analysis.dedupeKeepHighestPopularity(state.workingTracks, state.duplicateReport);
    commitWorkingTracks(deduped, 'Applied exact dedupe');
    setMessage('Exact dedupe applied (kept highest popularity versions).');
  });

  get('closeNearDuplicateModalBtn').addEventListener('click', hideNearDuplicateModal);
  get('applyNearDuplicateChoicesBtn').addEventListener('click', applyNearDuplicateChoices);
  get('keepRecommendedOnlyBtn').addEventListener('click', keepRecommendedOnly);

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

  get('outliersBtn').addEventListener('click', () => {
    if (!state.workingTracks.length) return;
    renderOutliers();
    setMessage('Outlier report generated.');
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

  get('saveWeightPresetBtn').addEventListener('click', saveWeightPreset);
  get('loadWeightPresetBtn').addEventListener('click', loadWeightPreset);
  get('deleteWeightPresetBtn').addEventListener('click', deleteWeightPreset);

  get('bulkRunBtn').addEventListener('click', () =>
    runBulkOperation().catch((error) => setMessage(error.message, true))
  );

}

async function init() {
  state.columnConfig = buildDefaultColumnConfig();
  setSourceMode('spotify');
  bindRibbonTabs();
  syncPresetStateFromStorage();
  bindSetupCopyValues();
  bindHeaderFilterPopupEvents();
  let savedWeights = analysis.DEFAULT_WEIGHTS;
  try {
    const resp = await fetch('config/mix-weights.json');
    if (resp.ok) savedWeights = await resp.json();
  } catch { /* use defaults */ }
  renderMixWeightSliders(savedWeights);

  await bindEvents();
  bindKeyboardShortcuts();
  updateHistoryButtons();

  try {
    await refreshSetupState();
    const setupHint = get('setupRedirectHintInline');
    if (setupHint) setupHint.textContent = state.setup?.redirectUri || auth.getRecommendedRedirectUri();

    // Handle OAuth callback if redirected from Spotify
    try {
      const wasCallback = await auth.handleAuthCallback();
      if (wasCallback) {
        setMessage('Signed in successfully.');
      }
    } catch (callbackError) {
      setMessage(String(callbackError?.message || callbackError), true);
    }

    if (!state.setup?.hasClientId) {
      openSetupModal();
      setSetupMessage('Enter your Spotify Client ID to get started.');
    }

    await refreshAuthAndUser();
    await loadPlaylists();
  } catch (error) {
    setMessage(error.message, true);
  }
}

init();
