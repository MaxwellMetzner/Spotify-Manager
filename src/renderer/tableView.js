import { createLogger, nowMs } from '../debug.js';

const dlog = createLogger('table');

function asPromise(result) {
  if (result && typeof result.then === 'function') {
    return result;
  }
  return Promise.resolve(result);
}

function withTimeout(promise, timeoutMs, label, log = dlog, meta = undefined) {
  const startedAt = nowMs();
  log(`${label}:start`, {
    timeoutMs,
    ...meta,
  });
  return new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      const error = new Error(`${label} timed out after ${Math.round(timeoutMs / 1000)}s`);
      log(`${label}:timeout`, {
        timeoutMs,
        durationMs: Math.round(nowMs() - startedAt),
        ...meta,
      });
      reject(error);
    }, timeoutMs);

    Promise.resolve(promise)
      .then((value) => {
        clearTimeout(timeoutId);
        log(`${label}:done`, {
          durationMs: Math.round(nowMs() - startedAt),
          ...meta,
        });
        resolve(value);
      })
      .catch((error) => {
        clearTimeout(timeoutId);
        log(`${label}:error`, {
          durationMs: Math.round(nowMs() - startedAt),
          message: String(error?.message || error),
          ...meta,
        });
        reject(error);
      });
  });
}

export async function applyTableData({
  table,
  tracks,
  ready = null,
  rebuildColumns = false,
  columns = null,
  sort = null,
  resetScroll = true,
  forceRedraw = true,
  getActiveData = () => [],
  log = dlog,
  debugLabel = 'tableRender',
  timeouts = {},
}) {
  if (!table) return [];

  const startedAt = nowMs();
  const rows = tracks || [];
  const readyTimeout = Number.isFinite(timeouts.ready) ? timeouts.ready : 10000;
  const columnTimeout = Number.isFinite(timeouts.columns) ? timeouts.columns : 10000;
  const dataTimeout = Number.isFinite(timeouts.data) ? timeouts.data : 10000;
  const sortTimeout = Number.isFinite(timeouts.sort) ? timeouts.sort : 5000;

  log('applyTableData:start', {
    debugLabel,
    rows: rows.length,
    rebuildColumns,
    resetScroll,
    forceRedraw,
    hasReadyPromise: Boolean(ready),
    sort,
  });

  if (ready) {
    await withTimeout(ready, readyTimeout, 'Table initialization', log, { debugLabel, rows: rows.length });
  }

  if (rebuildColumns && columns) {
    await withTimeout(asPromise(table.setColumns(columns)), columnTimeout, 'Table column update', log, {
      debugLabel,
      columnCount: columns.length,
    });
  }

  await withTimeout(asPromise(table.setData(rows)), dataTimeout, 'Table data update', log, {
    debugLabel,
    rows: rows.length,
  });

  if (sort?.field && sort?.direction) {
    await withTimeout(asPromise(table.setSort(sort.field, sort.direction)), sortTimeout, 'Table sort update', log, {
      debugLabel,
      field: sort.field,
      direction: sort.direction,
    });
  } else if (typeof table.clearSort === 'function') {
    await withTimeout(asPromise(table.clearSort()), sortTimeout, 'Table sort reset', log, { debugLabel });
  } else if (typeof table.setSort === 'function') {
    await withTimeout(asPromise(table.setSort([])), sortTimeout, 'Table sort reset', log, { debugLabel });
  }

  if (forceRedraw && typeof table.redraw === 'function') {
    log('Table redraw:scheduled', { debugLabel });
    void asPromise(table.redraw(true)).catch((error) => {
      log('Table redraw:error', {
        debugLabel,
        message: String(error?.message || error),
      });
    });
  }

  if (resetScroll && rows.length && typeof table.scrollToRow === 'function') {
    const activeRowComponent = typeof table.getRows === 'function'
      ? table.getRows('active')?.[0] || null
      : null;
    const activeRowData = activeRowComponent && typeof activeRowComponent.getData === 'function'
      ? activeRowComponent.getData()
      : rows[0];

    log('Table scrollToRow:scheduled', {
      debugLabel,
      rowId: activeRowData?.id ?? activeRowData?.trackId ?? activeRowData?.customOrder ?? null,
      target: activeRowComponent ? 'row-component' : 'raw-row',
    });
    void asPromise(table.scrollToRow(activeRowComponent || rows[0], 'top', false)).catch((error) => {
      log('Table scrollToRow:error', {
        debugLabel,
        message: String(error?.message || error),
      });
    });
  }

  const active = getActiveData();
  log('applyTableData:done', {
    debugLabel,
    rows: rows.length,
    activeRows: Array.isArray(active) ? active.length : null,
    durationMs: Math.round(nowMs() - startedAt),
  });
  return active;
}

export function createTableRenderQueue(renderer, { log = dlog, label = 'tableRenderQueue' } = {}) {
  let pending = Promise.resolve();
  let nextRequestId = 0;

  return (...args) => {
    const requestId = nextRequestId + 1;
    nextRequestId = requestId;
    log(`${label}:queued`, { requestId });
    const next = pending.then(async () => {
      log(`${label}:start`, { requestId });
      const startedAt = nowMs();
      try {
        const result = await renderer(...args);
        log(`${label}:done`, {
          requestId,
          durationMs: Math.round(nowMs() - startedAt),
        });
        return result;
      } catch (error) {
        log(`${label}:error`, {
          requestId,
          durationMs: Math.round(nowMs() - startedAt),
          message: String(error?.message || error),
        });
        throw error;
      }
    });
    pending = next.catch(() => {});
    return next;
  };
}