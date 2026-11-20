import { formatAdded, formatDuration } from './trackData.js';

// The third value is the filter kind. Every column stays in the grid so resize and drag state survive edits.
export const columns = [
  ['customOrder', '#', 'number', 70], ['title', 'Title', 'text', 230], ['artistDisplay', 'Artists', 'text', 188],
  ['albumName', 'Album', 'text', 184], ['durationMs', 'Duration', 'duration', 112],
  ['bpm', 'BPM', 'number', 95], ['keyModeLabel', 'Musical key', 'set', 136],
  ['albumReleaseDate', 'Album date', 'text', 130], ['addedAt', 'Added at', 'date', 218], ['addedBy', 'Added by', 'text', 160],
  ['genreDisplay', 'Genres', 'text', 190], ['instrumentalness', 'Instrumentalness', 'number', 174],
  ['acousticness', 'Acousticness', 'number', 154], ['speechiness', 'Speechiness', 'number', 146],
  ['loudness', 'Loudness', 'number', 134], ['energy', 'Energy', 'number', 114], ['danceability', 'Danceability', 'number', 150],
  ['valence', 'Valence', 'number', 118], ['liveness', 'Liveness', 'number', 125], ['timeSignature', 'Time signature', 'set', 158],
  ['recordLabel', 'Record label', 'text', 175], ['popularity', 'Popularity', 'number', 136], ['key', 'Key index', 'number', 125],
  ['mode', 'Mode', 'set', 108], ['tempo', 'Tempo', 'number', 112], ['durationSeconds', 'Seconds', 'number', 118],
  ['explicit', 'Explicit', 'set', 118], ['uri', 'Track URI', 'text', 260],
];
const basic = ['customOrder', 'title', 'artistDisplay', 'albumName', 'albumReleaseDate', 'addedAt', 'addedBy', 'durationMs'];
export const defaultColumns = (audio) => new Set(audio ? [...basic, 'bpm', 'keyModeLabel', 'genreDisplay'] : basic);
export const columnInfo = new Map(columns.map((column) => [column[0], column]));

function formatCell(field, value) {
  if (field === 'durationMs') return formatDuration(value);
  if (field === 'addedAt') return formatAdded(value);
  if (value == null || value === '') return '—';
  if (typeof value === 'number') return String(Number(value.toFixed(field === 'bpm' || field === 'loudness' ? 1 : 3)));
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  return String(value);
}

export function createTrackTable(element, { onFilter, onRemove, onSelection, onCount }) {
  const initial = defaultColumns(false);
  const table = new Tabulator(element, {
    index: 'rowId', layout: 'fitData', height: '100%', rowHeight: 40,
    renderVertical: 'virtual', renderHorizontal: 'virtual', renderVerticalBuffer: 240,
    movableColumns: true, selectableRows: true, selectableRowsRangeMode: 'click',
    columnDefaults: { resizable: true, headerSortTristate: true, vertAlign: 'middle' },
    placeholder: 'No tracks match this view.',
    rowContextMenu: [{ label: 'Remove this track', action: (_, row) => onRemove([row.getData().rowId]) }],
    columns: columns.map(([field, label, kind, width]) => ({
      field, title: label, width, visible: initial.has(field),
      cssClass: field === 'title' ? 'track-title' : ['number', 'duration'].includes(kind) ? 'numeric' : '',
      sorter: kind === 'number' || kind === 'duration' ? 'number' : kind === 'date'
        ? (_, __, a, b) => (a.getData().addedTime || 0) - (b.getData().addedTime || 0)
        : 'string',
      titleFormatter: () => {
        const title = document.createElement('span');
        title.className = 'col-label';
        title.append(label);
        const filter = document.createElement('button');
        filter.type = 'button';
        filter.className = 'filter-icon';
        filter.dataset.field = field;
        filter.setAttribute('aria-label', 'Filter ' + label);
        filter.title = 'Filter ' + label;
        filter.addEventListener('mousedown', (event) => event.stopPropagation());
        filter.addEventListener('click', (event) => {
          event.stopPropagation();
          onFilter(field, filter.getBoundingClientRect());
        });
        title.append(filter);
        return title;
      },
      headerContext: (event, column) => {
        event.preventDefault();
        onFilter(field, column.getElement().getBoundingClientRect());
      },
      // Tabulator accepts HTML strings. Track titles and imported metadata are always text.
      formatter: (cell) => document.createTextNode(formatCell(field, cell.getValue())),
    })),
  });
  const ready = new Promise((resolve) => table.on('tableBuilt', resolve));
  table.on('rowSelectionChanged', (data) => onSelection(data.length));
  table.on('dataProcessed', () => onCount(table.getDataCount('active')));
  table.on('renderComplete', () => onCount(table.getDataCount('active')));
  return { table, ready };
}

export function compileFilters(search, filters) {
  const query = search.trim().toLowerCase();
  const checks = Array.from(filters, ([field, filter]) => {
    const { kind, exclude, min, max } = filter;
    let test;
    if (kind === 'number' || kind === 'duration') {
      test = (row) => Number.isFinite(row[field]) && (min === null || row[field] >= min) && (max === null || row[field] <= max);
    } else if (kind === 'set') {
      const values = new Set(filter.values);
      test = (row) => values.has(String(row[field] ?? ''));
    } else {
      const needle = filter.value.toLowerCase();
      test = kind === 'date'
        ? (row) => (String(row[field] || '') + ' ' + formatAdded(row[field])).toLowerCase().includes(needle)
        : (row) => String(row[field] ?? '').toLowerCase().includes(needle);
    }
    return exclude ? (row) => !test(row) : test;
  });
  return (row) => (!query || row.searchText.includes(query)) && checks.every((test) => test(row));
}
