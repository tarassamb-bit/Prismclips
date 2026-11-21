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

/** Safari can fail a transaction with no error object at all; callers always get an Error with a message. */
const storageError = (error) => (error instanceof Error || error instanceof DOMException ? error : new Error('This browser couldn’t save to its storage.'));

async function run(store, mode, action) {
  const db = await database();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(store, mode);
    const request = action(transaction.objectStore(store));
    transaction.oncomplete = () => resolve(request?.result);
    transaction.onerror = () => reject(storageError(transaction.error ?? request?.error));
    transaction.onabort = () => reject(storageError(transaction.error));
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
    transaction.onerror = () => reject(storageError(transaction.error ?? read.error));
    transaction.onabort = () => reject(storageError(transaction.error));
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
export async function saveProject(project, { touch = true, isCurrent = null } = {}) {
  const now = new Date().toISOString();
  let saved = false;
  await update('projects', project.id, (existing) => {
    if (isCurrent && (!existing || !isCurrent())) return null;
    saved = true;
    return { ...project, ...(touch ? { updated: now } : {}), dirty: true, changedAt: now, syncedAt: existing?.syncedAt ?? project.syncedAt };
  });
  if (saved) changed();
  return saved;
}

/** Upload completion changes one media record, never a stale copy of the editor. */
export async function saveMediaCloud(projectId, mediaId, cloud, isCurrent) {
  let saved = false;
  await update('projects', projectId, (record) => {
    const media = record?.media.find((m) => m.id === mediaId);
    if (!media || !isCurrent(record)) return null;
    const now = new Date().toISOString();
    media.cloud = { ...cloud, at: now };
    Object.assign(record, { dirty: true, changedAt: now });
    saved = true;
    return record;
  });
  if (saved) changed();
  return saved;
}

/** Patch an existing project only: a delayed checkpoint must never recreate a cancelled/deleted project. */
export async function saveTranscript(projectId, mediaId, transcript, isCurrent) {
  let saved = false;
  await update('projects', projectId, (record) => {
    if (!record || !isCurrent() || !record.media.some((m) => m.id === mediaId)) return null;
    const previous = record.transcripts?.[mediaId];
    const language = (value) => typeof value === 'string' ? value.trim().toLowerCase() : '';
    // A shorter checkpoint only loses to a longer one for the same language; a new language must replace the old transcript.
    if (previous?.start === transcript.start && previous.end > transcript.end && language(previous.language) === language(transcript.language)) return null;
    const now = new Date().toISOString();
    record.transcripts ??= {};
    record.transcripts[mediaId] = transcript;
    Object.assign(record, { updated: now, changedAt: now, dirty: true });
    saved = true;
    return record;
  });
  if (saved) changed();
}

/** Count committed exports atomically without overwriting edits or reviving a deleted project. */
export async function addExportCount(projectId, count) {
  let exported = null;
  await update('projects', projectId, (record) => {
    if (!record) return null;
    const now = new Date().toISOString();
    exported = (record.exported ?? 0) + count;
    Object.assign(record, { exported, updated: now, changedAt: now, dirty: true });
    return record;
  });
  if (exported !== null) changed();
  return exported;
}

/** A copy that came from the cloud, or a fix-up that isn't a change of content: stored as is, and nothing is queued to sync. */
export const saveRaw = (store, record) => run(store, 'readwrite', (s) => s.put(record));

// Millisecond timestamps alone cannot distinguish two edits saved in the same tick.
const sameRevision = (record, expected) => JSON.stringify(record) === JSON.stringify(expected);

/** A network response may only replace the local revision the sync actually compared. */
export async function applyCloud(kind, record, expected, isCurrent) {
  let applied = false;
  await update(kind, record.id, (existing) => {
    if (!isCurrent()) return null;
    if (!sameRevision(existing, expected)) return null;
    applied = true;
    return record;
  });
  return applied;
}

/** Mirror a cloud deletion only if this device has not edited the item while syncing. */
export async function dropSynced(kind, expected, isCurrent) {
  const db = await database();
  let removed = false;
  await new Promise((resolve, reject) => {
    const transaction = db.transaction(kind === 'projects' ? ['projects', 'files'] : ['folders'], 'readwrite');
    const objects = transaction.objectStore(kind), read = objects.get(expected.id);
    read.onsuccess = () => {
      const record = read.result;
      if (!isCurrent() || !record || record.dirty || !sameRevision(record, expected)) return;
      objects.delete(record.id);
      if (kind === 'projects') for (const media of record.media ?? []) transaction.objectStore('files').delete(media.id);
      removed = true;
    };
    transaction.oncomplete = resolve;
    transaction.onerror = () => reject(storageError(transaction.error ?? read.error));
    transaction.onabort = () => reject(storageError(transaction.error));
  });
  if (removed && kind === 'projects') for (const media of expected.media ?? []) memoryFiles.delete(media.id);
  return removed;
}
export const patch = (store, id, mutate) => update(store, id, (record) => { if (!record) return null; mutate(record); return record; });

/** Marks what was sent as synced, unless it changed again while it was being sent. */
export const markSynced = (store, id, syncedAt, sent) => update(store, id, (record) => {
  if (!record) return null;
  return { ...record, syncedAt, dirty: !sameRevision(record, sent) };
});

export async function deleteProject(project) {
  await run('projects', 'readwrite', (s) => s.delete(project.id));
  for (const media of project.media) {
    memoryFiles.delete(media.id);
    await run('files', 'readwrite', (s) => s.delete(media.id));
    // A video kept in the account's cloud storage is removed there too, as soon as the cloud can be reached.
    if (media.cloud?.uploaded) forget('videos', `${project.owner}/${media.cloud.key ?? media.id}`);
  }
  forget('projects', project.owner ? `${project.owner}/${project.id}` : project.id);
}

/** Removes a deleted account's projects, videos and folders from this browser. Nothing is queued for the cloud: the account is gone. */
export async function deleteOwner(owner) {
  for (const project of (await run('projects', 'readonly', (s) => s.getAll())).filter((p) => p.owner === owner)) {
    await run('projects', 'readwrite', (s) => s.delete(project.id));
    for (const media of project.media) { memoryFiles.delete(media.id); await run('files', 'readwrite', (s) => s.delete(media.id)); }
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
  const folder = await run('folders', 'readonly', (s) => s.get(id));
  await run('folders', 'readwrite', (s) => s.delete(id));
  forget('folders', folder?.owner ? `${folder.owner}/${id}` : id);
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

// Safari Private Browsing refuses to store any Blob in IndexedDB ("Error preparing Blob/File data to be stored in object store"),
// so a video chosen or downloaded there could never be kept and the project never opened. Such a video is held in memory for
// this tab instead: the project opens and works until the tab closes, which is all Private Browsing keeps anyway.
const memoryFiles = new Map();
export async function deleteFile(id) {
  await run('files', 'readwrite', (s) => s.delete(id));
  memoryFiles.delete(id);
}
export async function saveFile(id, file) {
  try {
    await run('files', 'readwrite', (s) => s.put(file, id));
    memoryFiles.delete(id);
  } catch (error) {
    if (!/Blob\/File data/i.test(error?.message ?? '')) throw error;
    console.warn('This browser won’t store videos (Safari Private Browsing?); keeping it for this tab only.', error);
    memoryFiles.set(id, file);
  }
}
export const loadFile = async (id) => memoryFiles.get(id) ?? run('files', 'readonly', (s) => s.get(id));
export const hasFile = async (id) => memoryFiles.has(id) || (await run('files', 'readonly', (s) => s.count(id))) > 0;
