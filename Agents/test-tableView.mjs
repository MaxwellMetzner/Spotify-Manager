import test from 'node:test';
import assert from 'node:assert/strict';

import { applyTableData, createTableRenderQueue } from '../src/renderer/tableView.js';

test('applyTableData waits for column rebuild before loading data', async () => {
  const steps = [];
  const table = {
    async setColumns(columns) {
      steps.push(['setColumns:start', columns.length]);
      await new Promise((resolve) => setTimeout(resolve, 10));
      steps.push(['setColumns:end', columns.length]);
    },
    async setData(rows) {
      steps.push(['setData', rows.length]);
    },
    async clearSort() {
      steps.push(['clearSort']);
    },
    async redraw(force) {
      steps.push(['redraw', force]);
    },
    async scrollToRow(row) {
      steps.push(['scrollToRow', row.id]);
    },
  };

  const active = [{ id: 1 }];
  const result = await applyTableData({
    table,
    tracks: active,
    ready: Promise.resolve(),
    rebuildColumns: true,
    columns: [{ field: 'title' }],
    resetScroll: true,
    getActiveData: () => active,
  });

  assert.deepEqual(result, active);
  assert.deepEqual(steps, [
    ['setColumns:start', 1],
    ['setColumns:end', 1],
    ['setData', 1],
    ['clearSort'],
    ['redraw', true],
    ['scrollToRow', 1],
  ]);
});

test('applyTableData waits for readiness before touching the table', async () => {
  const steps = [];
  let resolveReady;
  const ready = new Promise((resolve) => {
    resolveReady = resolve;
  });
  const table = {
    async setData(rows) {
      steps.push(['setData', rows.length]);
    },
    async clearSort() {
      steps.push(['clearSort']);
    },
    async redraw(force) {
      steps.push(['redraw', force]);
    },
  };

  const pending = applyTableData({
    table,
    tracks: [{ id: 1 }],
    ready,
    getActiveData: () => [{ id: 1 }],
  });

  await Promise.resolve();
  assert.deepEqual(steps, []);

  resolveReady();
  await pending;

  assert.deepEqual(steps, [
    ['setData', 1],
    ['clearSort'],
    ['redraw', true],
  ]);
});

test('applyTableData does not block on unresolved scroll or redraw promises', async () => {
  const table = {
    async setData() {},
    async clearSort() {},
    redraw() {
      return new Promise(() => {});
    },
    scrollToRow() {
      return new Promise(() => {});
    },
  };

  const result = await Promise.race([
    applyTableData({
      table,
      tracks: [{ id: 1 }],
      ready: Promise.resolve(),
      getActiveData: () => [{ id: 1 }],
    }),
    new Promise((_, reject) => setTimeout(() => reject(new Error('applyTableData hung')), 250)),
  ]);

  assert.deepEqual(result, [{ id: 1 }]);
});

test('applyTableData prefers active row component for scroll targets', async () => {
  const steps = [];
  const rowComponent = {
    getData() {
      return { customOrder: 7, title: 'Song' };
    },
  };
  const table = {
    async setData(rows) {
      steps.push(['setData', rows.length]);
    },
    async clearSort() {
      steps.push(['clearSort']);
    },
    async redraw(force) {
      steps.push(['redraw', force]);
    },
    getRows(type) {
      steps.push(['getRows', type]);
      return [rowComponent];
    },
    async scrollToRow(target) {
      steps.push(['scrollToRow', target === rowComponent ? 'row-component' : 'raw-row']);
    },
  };

  await applyTableData({
    table,
    tracks: [{ customOrder: 7, title: 'Song' }],
    ready: Promise.resolve(),
    getActiveData: () => [{ customOrder: 7, title: 'Song' }],
    resetScroll: true,
  });

  assert.ok(steps.some((step) => step[0] === 'getRows' && step[1] === 'active'));
  assert.ok(steps.some((step) => step[0] === 'scrollToRow' && step[1] === 'row-component'));
});

test('applyTableData emits timeout diagnostics for unresolved readiness', async () => {
  const events = [];
  const log = (event, payload) => {
    events.push([event, payload]);
  };

  await assert.rejects(
    () => applyTableData({
      table: {
        async setData() {},
        async clearSort() {},
      },
      tracks: [{ id: 1 }],
      ready: new Promise(() => {}),
      getActiveData: () => [],
      log,
      debugLabel: 'playlist-load',
      timeouts: { ready: 25 },
    }),
    /Table initialization timed out/
  );

  assert.ok(events.some(([event]) => event === 'applyTableData:start'));
  assert.ok(events.some(([event, payload]) => event === 'Table initialization:timeout' && payload.debugLabel === 'playlist-load'));
});

test('createTableRenderQueue preserves the latest queued table state', async () => {
  const table = { rows: [] };
  const render = createTableRenderQueue(async (rows, delayMs) => {
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    table.rows = rows;
  });

  const first = render([], 15);
  const second = render([{ id: 42 }], 0);

  await Promise.all([first, second]);

  assert.deepEqual(table.rows, [{ id: 42 }]);
});