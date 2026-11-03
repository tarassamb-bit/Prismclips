// Keeps this account's projects and folders in Supabase, so they follow the account to any browser. Videos stay on each device.
// A change made here is sent a moment after it is saved; on sign-in and whenever it is asked, the cloud is compared with this device.
import { mergePlan, resolveConflict } from './engine/syncplan.js';
import * as store from './store.js';

const KINDS = [
  { kind: 'projects', table: 'cloud_projects', list: store.listProjects, prepare: true },
  { kind: 'folders', table: 'cloud_folders', list: store.listFolders, prepare: false },
];
const MAX_ROW = 3_900_000;

let ctx = null; // { db(), userId(), ensureHashes(project), onUpdated(), afterSync() }
const status = { state: 'idle', message: '', last: null };
const watchers = new Set();
export const syncStatus = () => ({ ...status });
export const onSyncStatus = (watcher) => watchers.add(watcher);
function set(state, message = '') {
  Object.assign(status, { state, message, ...(state === 'ok' ? { last: new Date() } : {}) });
  watchers.forEach((watcher) => watcher(syncStatus()));
}

export function configureSync(options) {
  ctx = options;
  store.onSave(() => requestSync());
}

let timer = 0, running = false, again = false;
export function requestSync(delay = 1500) {
  clearTimeout(timer);
  timer = setTimeout(sync, delay);
}

/** The server doesn't have the tables yet (the migration hasn't been applied). */
const notSetUp = (error) => error?.code === 'PGRST205' || error?.status === 404 || /schema cache|does not exist/i.test(error?.message ?? '');

export async function sync() {
  const userId = ctx?.userId(), db = ctx?.db();
  if (!userId || !db) return;
  if (running) { again = true; return; }
  running = true;
  set('syncing');
  let updated = false;
  try {
    for (const spec of KINDS) updated = (await syncKind(spec, userId, db)) || updated;
    set('ok');
  } catch (error) {
    set(notSetUp(error) ? 'unavailable' : 'error', notSetUp(error) ? 'Cloud sync isn’t set up on the server yet.' : error?.message || 'Sync failed.');
  } finally {
    running = false;
    if (again) { again = false; requestSync(500); }
  }
  if (updated) ctx.onUpdated?.();
  if (status.state === 'ok') ctx.afterSync?.();
}

const strip = ({ dirty, syncedAt, owner, ...data }) => data;
const batches = (list, size) => Array.from({ length: Math.ceil(list.length / size) }, (_, i) => list.slice(i * size, (i + 1) * size));

async function fetchCloud(db, table) {
  const rows = [];
  for (let from = 0; from < 10_000; from += 1000) {
    const { data, error } = await db.from(table).select('id, updated_at').order('id').range(from, from + 999);
    if (error) throw error;
    rows.push(...data);
    if (data.length < 1000) break;
  }
  return rows;
}

/** Returns true when something on this device changed because of the cloud. */
async function syncKind({ kind, table, list, prepare }, userId, db, attempt = 1) {
  // Anything saved before accounts existed belongs to whoever syncs first; other accounts' items are left alone.
  const mine = [];
  for (const item of await list()) {
    if (item.owner && item.owner !== userId) continue;
    if (!item.owner) { await store.patch(kind, item.id, (record) => { record.owner = userId; }); item.owner = userId; }
    mine.push(item);
  }
  // Deletions made here go first, or the cloud copy would come straight back.
  const deleted = [...store.pendingDeletes(kind)];
  if (deleted.length) {
    const { error } = await db.from(table).delete().in('id', deleted);
    if (error) throw error;
    store.deletionReached(kind, deleted);
  }
  const plan = mergePlan(mine, await fetchCloud(db, table));
  const byId = new Map(mine.map((item) => [item.id, item]));
  let raced = false;

  // Changed here and in the cloud: fetch the cloud copy and decide with both in hand (each video's cloud status is merged).
  for (const ids of batches(plan.conflict, 10)) {
    const { data, error } = await db.from(table).select('id, updated_at, data').in('id', ids);
    if (error) throw error;
    for (const row of data) {
      const local = byId.get(row.id);
      const cloudCopy = { ...row.data, id: row.id };
      const { project, winner, changed } = kind === 'projects' ? resolveConflict(local, cloudCopy, row.updated_at)
        : { project: Date.parse(local.changedAt ?? 0) >= Date.parse(row.updated_at) ? local : cloudCopy, winner: null, changed: false };
      const now = new Date().toISOString();
      if (winner === 'local' || (kind !== 'projects' && project === local)) {
        // Sent below, against the copy just seen.
        byId.set(row.id, { ...project, syncedAt: row.updated_at, changedAt: local.changedAt });
        plan.push.push(row.id);
      } else {
        // The cloud copy wins; if it gained a newer video status from here, it goes back up on the next round.
        await store.saveRaw(kind, { ...project, owner: userId, dirty: changed, changedAt: changed ? now : project.changedAt, syncedAt: row.updated_at });
        if (changed) raced = true;
      }
    }
  }

  for (const ids of batches(plan.pull, 10)) {
    const { data, error } = await db.from(table).select('id, updated_at, data').in('id', ids);
    if (error) throw error;
    for (const row of data) await store.saveRaw(kind, { ...row.data, id: row.id, owner: userId, dirty: false, syncedAt: row.updated_at });
  }

  const problems = [];
  for (const id of plan.push) {
    const item = byId.get(id);
    if (prepare) await ctx.ensureHashes?.(item);
    const data = strip(item);
    if (JSON.stringify(data).length > MAX_ROW) { problems.push(`“${item.title ?? item.name}” is too big to sync.`); continue; }
    // A send only goes through if the cloud copy is still the one this device last saw. Another device may have saved a moment ago,
    // and sending anyway would wipe its change; then this device looks again before sending.
    const query = item.syncedAt
      ? db.from(table).update({ data }).eq('user_id', userId).eq('id', id).eq('updated_at', item.syncedAt)
      : db.from(table).insert({ user_id: userId, id, data });
    const { data: done, error } = await query.select('id, updated_at');
    if (error?.code === '23505') { raced = true; continue; } // somebody created it meanwhile
    if (error) throw error;
    if (!done.length) { raced = true; continue; }
    await store.markSynced(kind, done[0].id, done[0].updated_at, item.changedAt);
  }

  for (const id of plan.dropLocal) {
    if (kind === 'projects') await store.deleteProject(byId.get(id));
    else await store.deleteFolder(id);
  }
  if (problems.length) throw new Error(problems[0]);
  // Something changed in the cloud while sending: compare again (a few times at most).
  const more = raced && attempt < 4 ? await syncKind({ kind, table, list, prepare }, userId, db, attempt + 1) : false;
  return more || plan.pull.length + plan.dropLocal.length + plan.conflict.length > 0;
}
