// Projects and their video files, kept in this browser's IndexedDB. Projects and folders are also copied to the account in the cloud
// (see sync.js); videos never leave this device. Every project and folder carries four sync fields:
//   owner      the account it belongs to (older ones have none until their account first syncs)
//   dirty      true when it changed here since the last sync
//   changedAt  when it last changed here, whatever the change (renames and moves don't touch `updated`)
//   syncedAt   the cloud's own timestamp of the copy this device last saw
const DB_NAME = 'prism', DB_VERSION = 2;

let dbPromise = null;
function database() {
  dbPromise ??= new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains('projects')) db.createObjectStore('projects', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('files')) db.createObjectStore('files');
      // Home folders arrived in version 2; existing projects and videos are kept.
      if (!db.objectStoreNames.contains('folders')) db.createObjectStore('folders', { keyPath: 'id' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  return dbPromise;
}

async function run(store, mode, action) {
  const db = await database();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(store, mode);
    const request = action(transaction.objectStore(store));
    transaction.oncomplete = () => resolve(request?.result);
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error ?? new Error('Storage was interrupted.'));
  });
}

/** Reads a record and writes back what `change` returns, in one transaction, so nothing saved in between is overwritten. */
async function update(store, id, change) {
  const db = await database();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(store, 'readwrite');
    const objects = transaction.objectStore(store);
    const read = objects.get(id);
    read.onsuccess = () => {
      const next = change(read.result);
      if (next) objects.put(next);
    };
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error ?? new Error('Storage was interrupted.'));
  });
}

// Anyone who wants to know a change was saved here (the cloud sync does) listens with onSave.
const listeners = new Set();
export const onSave = (listener) => listeners.add(listener);
const changed = () => listeners.forEach((listener) => listener());

// MARK: Projects

export const listProjects = async () => (await run('projects', 'readonly', (s) => s.getAll()) ?? [])
  .sort((a, b) => (b.updated ?? '').localeCompare(a.updated ?? ''));
export const loadProject = (id) => run('projects', 'readonly', (s) => s.get(id));

/** A change made here. `touch: false` keeps the project's last-changed time, for moves, renames and trashing that don't change its content. */
export async function saveProject(project, { touch = true } = {}) {
  const now = new Date().toISOString();
  await update('projects', project.id, (existing) => ({
    ...project, ...(touch ? { updated: now } : {}), dirty: true, changedAt: now, syncedAt: existing?.syncedAt ?? project.syncedAt,
  }));
  changed();
}

/** A copy that came from the cloud, or a fix-up that isn't a change of content: stored as is, and nothing is queued to sync. */
export const saveRaw = (store, record) => run(store, 'readwrite', (s) => s.put(record));
export const patch = (store, id, mutate) => update(store, id, (record) => { if (!record) return null; mutate(record); return record; });

/** Marks what was sent as synced, unless it changed again while it was being sent. */
export const markSynced = (store, id, syncedAt, sentChangedAt) => update(store, id, (record) => {
  if (!record) return null;
  return { ...record, syncedAt, dirty: (record.changedAt ?? null) !== (sentChangedAt ?? null) };
});

export async function deleteProject(project) {
  await run('projects', 'readwrite', (s) => s.delete(project.id));
  for (const media of project.media) {
    await run('files', 'readwrite', (s) => s.delete(media.id));
    // A video kept in the account's cloud storage is removed there too, as soon as the cloud can be reached.
    if (media.cloud?.uploaded) forget('videos', `${project.owner}/${media.cloud.key ?? media.id}`);
  }
  forget('projects', project.id);
}

/** Removes a deleted account's projects, videos and folders from this browser. Nothing is queued for the cloud: the account is gone. */
export async function deleteOwner(owner) {
  for (const project of (await run('projects', 'readonly', (s) => s.getAll())).filter((p) => p.owner === owner)) {
    await run('projects', 'readwrite', (s) => s.delete(project.id));
    for (const media of project.media) await run('files', 'readwrite', (s) => s.delete(media.id));
  }
  for (const folder of (await run('folders', 'readonly', (s) => s.getAll())).filter((f) => f.owner === owner)) {
    await run('folders', 'readwrite', (s) => s.delete(folder.id));
  }
}

// MARK: Folders

export const listFolders = async () => (await run('folders', 'readonly', (s) => s.getAll()) ?? []).sort((a, b) => a.name.localeCompare(b.name));
export async function saveFolder(folder) {
  const now = new Date().toISOString();
  await update('folders', folder.id, (existing) => ({ ...folder, updated: now, dirty: true, changedAt: now, syncedAt: existing?.syncedAt ?? folder.syncedAt }));
  changed();
}
export async function deleteFolder(id) {
  await run('folders', 'readwrite', (s) => s.delete(id));
  forget('folders', id);
}

// MARK: Deletions waiting to reach the cloud (kept so a deletion made offline isn't undone by the next sync)

const PENDING_KEY = 'prism-pending-deletes';
export function pendingDeletes(kind) {
  try { return new Set(JSON.parse(localStorage.getItem(PENDING_KEY) || '{}')[kind] ?? []); } catch { return new Set(); }
}
function setPending(kind, ids) {
  try {
    const all = JSON.parse(localStorage.getItem(PENDING_KEY) || '{}');
    all[kind] = [...ids];
    localStorage.setItem(PENDING_KEY, JSON.stringify(all));
  } catch { /* without storage the deletion is simply not remembered */ }
}
function forget(kind, id) {
  setPending(kind, pendingDeletes(kind).add(id));
  changed();
}
/** Queues a cloud removal (an `<account id>/<video id>` entry for videos). */
export const rememberDeletion = (kind, id) => forget(kind, id);
export function deletionReached(kind, ids) {
  const pending = pendingDeletes(kind);
  for (const id of ids) pending.delete(id);
  setPending(kind, pending);
}

// MARK: Video files (device only)

export const saveFile = (id, file) => run('files', 'readwrite', (s) => s.put(file, id));
export const loadFile = (id) => run('files', 'readonly', (s) => s.get(id));
export const hasFile = async (id) => (await run('files', 'readonly', (s) => s.count(id))) > 0;
