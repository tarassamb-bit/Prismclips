// Vercel daily cron: deletes every project nobody edited for 7 days, with its stored video, even for people who never open
// the app again. A video another project of the same account still uses stays. The app applies the same rule after each
// sync (expireUntouched in app/app.js); a browser that still holds a deleted project drops it on its next sync.
const { HttpError, send, fail, supabase } = require('./_lib');
const { deleteObject } = require('./_r2');

const UNTOUCHED_DAYS = 7;
const lastEdit = (row) => Date.parse(row.updated ?? row.created ?? '');
const videosOf = (row) => (Array.isArray(row.media) ? row.media : [])
  .filter((m) => m?.cloud?.uploaded).map((m) => `${row.user_id}/${m.cloud.key ?? m.id}`);

/** Which projects go, and which stored videos go with them. An unreadable date never counts as old. */
function plan(rows, now) {
  const cutoff = now - UNTOUCHED_DAYS * 86_400_000;
  const expired = rows.filter((row) => lastEdit(row) < cutoff);
  const gone = new Set(expired.map((row) => `${row.user_id}/${row.id}`));
  const stillUsed = new Set(rows.filter((row) => !gone.has(`${row.user_id}/${row.id}`)).flatMap(videosOf));
  const videos = [...new Set(expired.flatMap(videosOf))].filter((key) => !stillUsed.has(key));
  return { projects: expired.map(({ user_id, id }) => ({ user_id, id })), videos };
}

/** Read the complete inventory before planning deletions: an unseen project may still use an old project's video. */
async function readProjects(read = supabase) {
  const rows = [];
  const size = 500;
  let after = null;
  while (true) {
    const cursor = after ? `&or=(user_id.gt.${encodeURIComponent(after.user_id)},and(user_id.eq.${encodeURIComponent(after.user_id)},id.gt.${encodeURIComponent(after.id)}))` : '';
    const query = `cloud_projects?select=id,user_id,updated_at,updated:data->>updated,created:data->>created,media:data->media&order=user_id.asc,id.asc&limit=${size}${cursor}`;
    const { response, body } = await read(query);
    if (!response.ok || !Array.isArray(body)) throw new HttpError(502, 'Could not read projects.');
    rows.push(...body);
    if (body.length < size) return rows;
    const last = body.at(-1);
    if (typeof last?.id !== 'string' || typeof last?.user_id !== 'string' || (after && (last.user_id < after.user_id || (last.user_id === after.user_id && last.id <= after.id)))) throw new HttpError(502, 'Could not page through projects.');
    after = { user_id: last.user_id, id: last.id };
  }
}

/** Delete only unchanged rows, then check the remaining projects again before deleting candidate videos. */
async function cleanupExpired(now, read = supabase, removeVideo = deleteObject) {
  const snapshot = await readProjects(read);
  const cutoff = now - UNTOUCHED_DAYS * 86_400_000;
  const expired = snapshot.filter((row) => lastEdit(row) < cutoff && typeof row.updated_at === 'string');
  const byUser = new Map();
  for (const row of expired) {
    if (!byUser.has(row.user_id)) byUser.set(row.user_id, []);
    byUser.get(row.user_id).push(row);
  }
  const removedRows = [];
  for (const [user, rows] of byUser) for (let i = 0; i < rows.length; i += 25) {
    const batch = rows.slice(i, i + 25);
    const clauses = batch.map((row) => `and(id.eq.${encodeURIComponent(row.id)},updated_at.eq.${encodeURIComponent(row.updated_at)})`).join(',');
    const { response, body } = await read(`cloud_projects?user_id=eq.${encodeURIComponent(user)}&or=(${clauses})&select=id`, {
      method: 'DELETE', headers: { Prefer: 'return=representation' },
    });
    if (!response.ok || !Array.isArray(body)) throw new HttpError(502, 'Could not delete projects.');
    const deleted = new Set(body.map((row) => row.id));
    removedRows.push(...batch.filter((row) => deleted.has(row.id)));
  }
  if (!removedRows.length) return { projects: 0, videos: 0 };
  const candidates = new Set(removedRows.flatMap(videosOf));
  // A project may have been edited or created since the first read, or a conditional delete may have lost a race.
  const used = new Set((await readProjects(read)).flatMap(videosOf));
  const unused = [...candidates].filter((key) => !used.has(key));
  for (const key of unused) await removeVideo(key);
  return { projects: removedRows.length, videos: unused.length };
}

module.exports = async (req, res) => {
  try {
    // Vercel sends this on its cron runs when CRON_SECRET is set; any other caller is refused.
    if (!process.env.CRON_SECRET || req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) throw new HttpError(401, 'Not allowed.');
    const result = await cleanupExpired(Date.now());
    console.log(JSON.stringify({ cleanup: true, ...result }));
    send(res, 200, result);
  } catch (error) {
    fail(res, error);
  }
};

module.exports.plan = plan;
module.exports.readProjects = readProjects;
module.exports.cleanupExpired = cleanupExpired;
