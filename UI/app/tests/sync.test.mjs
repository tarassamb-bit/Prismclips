import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { mergePlan, resolveConflict } from '../engine/syncplan.js';

test('sync discards a network response from the previous account', async () => {
  let account = 'first', applied = 0, release, requested;
  const response = new Promise((resolve) => { release = resolve; });
  const reachedDetails = new Promise((resolve) => { requested = resolve; });
  const filters = [];
  const store = {
    listProjects: async () => [{ id: 'p', owner: 'first', dirty: false, changedAt: 'local', syncedAt: 'old' }],
    listFolders: async () => [], onSave() {}, pendingDeletes: () => new Set(),
    applyCloud: async () => { applied++; return true; },
  };
  const db = { from(table) {
    let columns;
    return {
      select(value) { columns = value; return this; },
      eq(field, value) { filters.push([table, field, value]); return this; },
      order() { return this; }, range() { return this; }, in() { return this; },
      then(resolve, reject) {
        if (columns.includes('data')) { requested(); return response.then(resolve, reject); }
        return Promise.resolve({ data: [{ id: 'p', updated_at: 'new' }], error: null }).then(resolve, reject);
      },
    };
  } };
  const code = readFileSync(new URL('../sync.js', import.meta.url), 'utf8').replace(/^import .*;\n/gm, '').replace(/^export /gm, '');
  const context = vm.createContext({ store, mergePlan, resolveConflict, setTimeout: () => 1, clearTimeout() {}, Date, console });
  vm.runInContext(code, context);
  context.configureSync({ db: () => db, userId: () => account });
  const syncing = context.sync();
  await reachedDetails;
  account = 'second';
  release({ data: [{ id: 'p', updated_at: 'new', data: { title: 'Private project' } }], error: null });
  await syncing;
  assert.equal(applied, 0);
  assert.equal(vm.runInContext('syncStatus().state', context), 'idle');
  assert.deepEqual(filters, [['cloud_projects', 'user_id', 'first'], ['cloud_projects', 'user_id', 'first']]);
});

test('sync keeps other accounts deletions and acknowledges only owned legacy rows', async () => {
  const acknowledged = [], sent = [];
  const store = {
    listProjects: async () => [], listFolders: async () => [], onSave() {},
    pendingDeletes: (kind) => new Set(kind === 'projects' ? ['first/p', 'second/q', 'legacy-owned', 'legacy-other'] : []),
    deletionReached: (kind, entries) => acknowledged.push([kind, ...entries]),
  };
  const db = { from() {
    let deleting = false;
    return {
      delete() { deleting = true; return this; }, select() { return this; }, eq() { return this; },
      in(field, ids) { sent.push(...ids); return this; }, order() { return this; }, range() { return this; },
      then(resolve, reject) {
        return Promise.resolve({ data: deleting ? [{ id: 'p' }, { id: 'legacy-owned' }] : [], error: null }).then(resolve, reject);
      },
    };
  } };
  const code = readFileSync(new URL('../sync.js', import.meta.url), 'utf8').replace(/^import .*;\n/gm, '').replace(/^export /gm, '');
  const context = vm.createContext({ store, mergePlan, resolveConflict, setTimeout: () => 1, clearTimeout() {}, Date, console });
  vm.runInContext(code, context);
  context.configureSync({ db: () => db, userId: () => 'first' });
  await context.sync();
  assert.deepEqual(sent, ['p', 'legacy-owned', 'legacy-other']);
  assert.deepEqual(acknowledged.map((row) => Array.from(row)), [['projects', 'first/p', 'legacy-owned']]);
  assert.equal(vm.runInContext('syncStatus().state', context), 'ok');
});

test('local conflict winner keeps merged cloud media status on this device as well as the server', async () => {
  let local = { id: 'p', owner: 'first', dirty: true, changedAt: '2030-01-01', syncedAt: 'old', title: 'Local edit', media: [{ id: 'm', cloud: { uploaded: true, at: '2025-01-01' } }] };
  const cloud = { id: 'p', title: 'Cloud edit', media: [{ id: 'm', cloud: { removed: true, at: '2026-01-01' } }] };
  let pushed, acknowledged;
  const store = {
    listProjects: async () => [structuredClone(local)], listFolders: async () => [], onSave() {}, pendingDeletes: () => new Set(),
    applyCloud: async (kind, record) => { local = structuredClone(record); return true; },
    markSynced: async (kind, id, at, sent) => { acknowledged = sent; },
  };
  const db = { from(table) {
    let columns, writing = false;
    return {
      select(value) { columns = value; return this; }, eq() { return this; }, order() { return this; }, range() { return this; }, in() { return this; },
      update({ data }) { writing = true; pushed = data; return this; },
      then(resolve, reject) {
        const data = table === 'cloud_folders' ? [] : writing ? [{ id: 'p', updated_at: 'written' }]
          : columns.includes('data') ? [{ id: 'p', updated_at: '2026-01-01', data: cloud }] : [{ id: 'p', updated_at: '2026-01-01' }];
        return Promise.resolve({ data, error: null }).then(resolve, reject);
      },
    };
  } };
  const code = readFileSync(new URL('../sync.js', import.meta.url), 'utf8').replace(/^import .*;\n/gm, '').replace(/^export /gm, '');
  const context = vm.createContext({ store, mergePlan, resolveConflict, setTimeout: () => 1, clearTimeout() {}, Date, console });
  vm.runInContext(code, context);
  context.configureSync({ db: () => db, userId: () => 'first' });
  await context.sync();
  assert.equal(local.media[0].cloud.removed, true);
  assert.equal(pushed.media[0].cloud.removed, true);
  assert.equal(acknowledged.media[0].cloud.removed, true);
  assert.equal(vm.runInContext('syncStatus().state', context), 'ok');
});
