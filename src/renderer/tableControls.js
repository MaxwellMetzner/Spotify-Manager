import { $, escapeHtml as html, showDialog, status } from './ui.js';
import { columns, columnInfo, defaultColumns, compileFilters } from './tableView.js';
import { parseDuration } from './trackData.js';

export function bindTableControls(table, getTracks, hasAudio) {
  const filters = new Map();
  let field, timer, lastSearch = '';
  const search = $('trackSearch');
  function apply() {
    clearTimeout(timer);
    lastSearch = search.value;
    if (filters.size || lastSearch.trim()) table.setFilter(compileFilters(lastSearch, filters));
    else if (table.getFilters().length) table.clearFilter();
    const pills = $('activeFilterPills');
    pills.hidden = !filters.size;
    pills.innerHTML = [...filters].map(([key, f]) => {
      const value = f.values?.join(', ') || f.value || [f.minText || '…', f.maxText || '…'].join(' – ');
      return `<button class="filter-pill" data-field="${key}" title="Remove filter">${f.exclude ? 'Exclude ' : ''}${html(columnInfo.get(key)[1])} · ${html(value)} ×</button>`;
    }).join('');
    for (const button of document.querySelectorAll('.filter-icon')) button.classList.toggle('active', filters.has(button.dataset.field));
  }
  function flush() { if (search.value !== lastSearch) apply(); }
  search.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(apply, 100); });
  $('activeFilterPills').onclick = (event) => {
    const button = event.target.closest('button[data-field]');
    if (button) { filters.delete(button.dataset.field); apply(); }
  };

  function openFilter(key, rect) {
    field = key;
    const [, label, kind] = columnInfo.get(key), filter = filters.get(key) || {};
    $('headerFilterTitle').textContent = 'Filter ' + (key === 'customOrder' ? 'track order' : label);
    $('headerFilterNot').checked = !!filter.exclude;
    status('filterError');
    const fields = $('filterFields');
    if (kind === 'set') {
      const values = [...new Set(getTracks().map((track) => track[key]).filter((v) => v != null).map(String))].sort();
      fields.innerHTML = '<div class="set-values">' + (values.map((v) =>
        `<label><input type="checkbox" value="${html(v)}" ${filter.values?.includes(v) ? 'checked' : ''}> ${html(v)}</label>`
      ).join('') || 'No values available.') + '</div>';
    } else if (kind === 'number' || kind === 'duration') {
      const unit = kind === 'duration' ? ' (m:ss or seconds)' : '';
      fields.innerHTML = `<label class="field">Minimum${unit}<input id="filterMin" value="${html(filter.minText)}"></label><label class="field">Maximum${unit}<input id="filterMax" value="${html(filter.maxText)}"></label>`;
    } else {
      fields.innerHTML = `<label class="field">Contains<input id="filterText" value="${html(filter.value)}"></label>`;
    }
    const dialog = showDialog('headerFilterPopup');
    dialog.style.margin = '0';
    dialog.style.left = Math.max(6, Math.min(rect.left, innerWidth - dialog.offsetWidth - 6)) + 'px';
    dialog.style.top = Math.max(6, Math.min(rect.bottom + 5, innerHeight - dialog.offsetHeight - 6)) + 'px';
    fields.querySelector('input')?.focus();
  }
  $('filterForm').onsubmit = (event) => {
    event.preventDefault();
    const kind = columnInfo.get(field)[2], filter = { kind, exclude: $('headerFilterNot').checked };
    let active;
    if (kind === 'set') {
      filter.values = Array.from($('filterFields').querySelectorAll('input:checked'), (el) => el.value);
      active = filter.values.length;
    } else if (kind === 'number' || kind === 'duration') {
      filter.minText = $('filterMin').value.trim();
      filter.maxText = $('filterMax').value.trim();
      const parse = kind === 'duration' ? parseDuration : (s) => s ? Number(s) : null;
      filter.min = parse(filter.minText); filter.max = parse(filter.maxText);
      if ([filter.min, filter.max].some((v) => v !== null && !Number.isFinite(v))) {
        status('filterError', kind === 'duration' ? 'Enter seconds or a duration such as 3:45.' : 'Enter a number for each limit.', true);
        return;
      }
      if (filter.min !== null && filter.max !== null && filter.min > filter.max) {
        status('filterError', 'The minimum must be at or below the maximum.', true);
        return;
      }
      active = !!(filter.minText || filter.maxText);
    } else { filter.value = $('filterText').value.trim(); active = !!filter.value; }
    if (active) filters.set(field, filter); else filters.delete(field);
    apply();
    $('headerFilterPopup').close();
  };
  $('headerFilterClearBtn').onclick = () => { filters.delete(field); apply(); $('headerFilterPopup').close(); };

  function visibleColumns() { return table.getColumns().filter((c) => c.isVisible()).map((c) => c.getField()); }
  function setColumns(fields) {
    const chosen = new Set(fields);
    table.blockRedraw();
    try {
      for (const column of table.getColumns()) {
        const show = chosen.has(column.getField());
        if (show !== column.isVisible()) show ? column.show() : column.hide();
      }
    } finally { table.restoreRedraw(); }
  }
  function showChecks(selected) {
    $('columnControls').innerHTML = columns.map(([key, name]) =>
      `<label><input type="checkbox" value="${key}" ${selected.has(key) ? 'checked' : ''}> ${key === 'customOrder' ? 'Track order' : name}</label>`
    ).join('');
    $('applyColumnsBtn').disabled = !selected.size;
  }
  $('columnControls').onchange = () => {
    $('applyColumnsBtn').disabled = !$('columnControls').querySelector('input:checked');
  };
  $('openColumnsBtn').onclick = () => { showChecks(new Set(visibleColumns())); showDialog('columnPickerModal'); };
  $('selectAllColumnsBtn').onclick = () => showChecks(new Set(columnInfo.keys()));
  $('deselectAllColumnsBtn').onclick = () => showChecks(new Set());
  $('defaultColumnsBtn').onclick = () => showChecks(defaultColumns(hasAudio()));
  $('applyColumnsBtn').onclick = () => {
    const chosen = Array.from($('columnControls').querySelectorAll('input:checked'), (input) => input.value);
    setColumns(chosen);
    $('columnPickerModal').close();
  };
  return {
    openFilter, flush, setColumns, visibleColumns,
    snapshot: () => ({ search: search.value, filters: [...filters] }),
    restore(snapshot = {}) {
      search.value = snapshot.search || '';
      filters.clear();
      for (const [key, f] of snapshot.filters || []) if (columnInfo.has(key)) filters.set(key, f);
      apply();
    },
  };
}
