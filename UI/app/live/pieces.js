// The last 30 minutes of each live recording, as the stream's own pieces, in IndexedDB on this device. Shared by the recording
// worker (writes) and the Live screen (reads a moment's pieces to make a clip).
export const KEEP_SECONDS = 30 * 60;
let opened = null;

export function open() {
  return (opened ??= new Promise((resolve, reject) => {
    const request = indexedDB.open('relio-live', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('pieces', { keyPath: ['session', 'sequence'] });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => { opened = null; reject(request.error); };
  }));
}

const done = (tx) => new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onerror = tx.onabort = () => reject(tx.error); });

/** Stores one piece: { session, sequence, at (ms), duration (s), init (ArrayBuffer|null), bytes (ArrayBuffer) }. */
export async function put(piece) {
  const tx = (await open()).transaction('pieces', 'readwrite');
  tx.objectStore('pieces').put(piece);
  await done(tx);
}

/** Removes the session's pieces numbered below `sequence`. */
export async function dropBefore(session, sequence) {
  const tx = (await open()).transaction('pieces', 'readwrite');
  tx.objectStore('pieces').delete(IDBKeyRange.bound([session, -Infinity], [session, sequence], false, true));
  await done(tx);
}

/** Removes everything of a session, or every recording when `session` is omitted. */
export async function clear(session) {
  const tx = (await open()).transaction('pieces', 'readwrite');
  if (session === undefined) tx.objectStore('pieces').clear();
  else tx.objectStore('pieces').delete(IDBKeyRange.bound([session, -Infinity], [session, Infinity]));
  await done(tx);
}

/** The session's pieces that overlap from…to (ms), in order. */
export async function between(session, from, to) {
  const tx = (await open()).transaction('pieces', 'readonly');
  const request = tx.objectStore('pieces').getAll(IDBKeyRange.bound([session, -Infinity], [session, Infinity]));
  const all = await new Promise((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
  return all.filter((p) => p.at + p.duration * 1000 > from && p.at < to);
}
