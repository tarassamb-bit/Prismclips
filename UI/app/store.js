// Projects and their video files, kept in this browser's IndexedDB. Nothing is uploaded except the audio Prism AI needs.
const DB_NAME = 'prism', DB_VERSION = 1;

let dbPromise = null;
function database() {
  dbPromise ??= new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      request.result.createObjectStore('projects', { keyPath: 'id' });
      request.result.createObjectStore('files');
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

export const listProjects = async () => (await run('projects', 'readonly', (s) => s.getAll()) ?? [])
  .sort((a, b) => (b.updated ?? '').localeCompare(a.updated ?? ''));
export const loadProject = (id) => run('projects', 'readonly', (s) => s.get(id));
export const saveProject = (project) => run('projects', 'readwrite', (s) => s.put({ ...project, updated: new Date().toISOString() }));
export async function deleteProject(project) {
  await run('projects', 'readwrite', (s) => s.delete(project.id));
  for (const media of project.media) await run('files', 'readwrite', (s) => s.delete(media.id));
}
export const saveFile = (id, file) => run('files', 'readwrite', (s) => s.put(file, id));
export const loadFile = (id) => run('files', 'readonly', (s) => s.get(id));
