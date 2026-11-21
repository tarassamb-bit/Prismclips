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
  // Changes made on other devices arrive by themselves: when this tab comes back into view or online, and every minute while it's open.
  if (typeof document === 'undefined') return;
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') requestSync(0); });
  addEventListener('online', () => requestSync(0));
  setInterval(() => { if (document.visibilityState === 'visible') requestSync(0); }, 60_000);
}

let timer = 0, running = false, again = false;
export function requestSync(delay = 1500) {
  clearTimeout(timer);
  timer = setTimeout(sync, delay);
}

/** The server doesn't have the tables yet (the migration hasn't been applied). */
const notSetUp = (error) => error?.code === 'PGRST205' || error?.status === 404 || /schema cache|does not exist/i.test(error?.message ?? '');
class AccountChanged extends Error {}
const checkAccount = (userId) => { if (ctx.userId() !== userId) throw new AccountChanged(); };

export async function sync() {
  const userId = ctx?.userId(), db = ctx?.db();
  if (!userId || !db) return;
  if (running) { again = true; return; }
  running = true;
  set('syncing');
  let updated = false;
  try {
    for (const spec of KINDS) { checkAccount(userId); updated = (await syncKind(spec, userId, db)) || updated; }
    checkAccount(userId);
    set('ok');
  } catch (error) {
    if (error instanceof AccountChanged) { set('idle'); again = true; return; }
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

async function fetchCloud(db, table, userId) {
  const rows = [];
  for (let from = 0; from < 10_000; from += 1000) {
    checkAccount(userId);
    const { data, error } = await db.from(table).select('id, updated_at').eq('user_id', userId).order('id').range(from, from + 999);
    checkAccount(userId);
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
    checkAccount(userId);
    if (item.owner && item.owner !== userId) continue;
    if (!item.owner) { await store.patch(kind, item.id, (record) => { if (ctx.userId() === userId && !record.owner) record.owner = userId; }); checkAccount(userId); item.owner = userId; }
    mine.push(item);
  }
  // Deletions made here go first, or the cloud copy would come straight back.
  const pending = [...store.pendingDeletes(kind)];
  const scoped = pending.filter((id) => id.startsWith(`${userId}/`));
  const legacy = pending.filter((id) => !id.includes('/'));
  const deleted = [...scoped.map((id) => id.slice(userId.length + 1)), ...legacy];
  checkAccount(userId);
  if (deleted.length) {
    const { data: removed, error } = await db.from(table).delete().eq('user_id', userId).in('id', deleted).select('id');
    checkAccount(userId);
    if (error) throw error;
    // Legacy entries have no owner: acknowledge only rows actually removed for this account.
    const removedIds = new Set((removed ?? []).map((row) => row.id));
    store.deletionReached(kind, [...scoped, ...legacy.filter((id) => removedIds.has(id))]);
  }
  const plan = mergePlan(mine, await fetchCloud(db, table, userId));
  const byId = new Map(mine.map((item) => [item.id, item]));
  let raced = false;

  // Changed here and in the cloud: fetch the cloud copy and decide with both in hand (each video's cloud status is merged).
  for (const ids of batches(plan.conflict, 10)) {
    checkAccount(userId);
    const { data, error } = await db.from(table).select('id, updated_at, data').eq('user_id', userId).in('id', ids);
    checkAccount(userId);
    if (error) throw error;
    for (const row of data) {
      const local = byId.get(row.id);
      const cloudCopy = { ...row.data, id: row.id };
      const { project, winner, changed } = kind === 'projects' ? resolveConflict(local, cloudCopy, row.updated_at)
        : { project: Date.parse(local.changedAt ?? 0) >= Date.parse(row.updated_at) ? local : cloudCopy, winner: null, changed: false };
      const now = new Date().toISOString();
      if (winner === 'local' || (kind !== 'projects' && project === local)) {
        // Keep merged media status locally too; a later push must not restore the old status.
        const merged = { ...project, owner: userId, syncedAt: row.updated_at, changedAt: local.changedAt };
        if (!await store.applyCloud(kind, merged, local, () => ctx.userId() === userId)) { raced = true; continue; }
        byId.set(row.id, merged);
        plan.push.push(row.id);
      } else {
        // The cloud copy wins; if it gained a newer video status from here, it goes back up on the next round.
        const applied = await store.applyCloud(kind, { ...project, owner: userId, dirty: changed, changedAt: changed ? now : project.changedAt, syncedAt: row.updated_at }, local, () => ctx.userId() === userId);
        if (!applied) raced = true;
        if (changed) raced = true;
      }
    }
  }

  for (const ids of batches(plan.pull, 10)) {
    checkAccount(userId);
    const { data, error } = await db.from(table).select('id, updated_at, data').eq('user_id', userId).in('id', ids);
    checkAccount(userId);
    if (error) throw error;
    for (const row of data) {
      const applied = await store.applyCloud(kind, { ...row.data, id: row.id, owner: userId, dirty: false, syncedAt: row.updated_at }, byId.get(row.id), () => ctx.userId() === userId);
      if (!applied) raced = true;
    }
  }

  const problems = [];
  for (const id of plan.push) {
    checkAccount(userId);
    const item = byId.get(id);
    if (prepare) await ctx.ensureHashes?.(item);
    checkAccount(userId);
    const data = strip(item);
    if (JSON.stringify(data).length > MAX_ROW) { problems.push(`“${item.title ?? item.name}” is too big to sync.`); continue; }
    // A send only goes through if the cloud copy is still the one this device last saw. Another device may have saved a moment ago,
    // and sending anyway would wipe its change; then this device looks again before sending.
    const query = item.syncedAt
      ? db.from(table).update({ data }).eq('user_id', userId).eq('id', id).eq('updated_at', item.syncedAt)
      : db.from(table).insert({ user_id: userId, id, data });
    const { data: done, error } = await query.select('id, updated_at');
    checkAccount(userId);
    if (error?.code === '23505') { raced = true; continue; } // somebody created it meanwhile
    if (error) throw error;
    if (!done.length) { raced = true; continue; }
    await store.markSynced(kind, done[0].id, done[0].updated_at, item);
  }

  for (const id of plan.dropLocal) {
    checkAccount(userId);
    if (!await store.dropSynced(kind, byId.get(id), () => ctx.userId() === userId)) raced = true;
  }
  if (problems.length) throw new Error(problems[0]);
  if (raced && attempt >= 4) throw new Error('Cloud sync kept changing while saving. Your local edits are safe; try Sync again.');
  // Something changed in the cloud while sending: compare again (a few times at most).
  const more = raced && attempt < 4 ? await syncKind({ kind, table, list, prepare }, userId, db, attempt + 1) : false;
  return more || plan.pull.length + plan.dropLocal.length + plan.conflict.length > 0;
}
