// Vercel daily cron: deletes every project nobody edited for its plan's days (Free 1, Tier 1 2, Creator 5, Studio 7), with its stored video, even for people who never open
// the app again. A video another project of the same account still uses stays. The app applies the same rule after each
// sync (expireUntouched in app/app.js); a browser that still holds a deleted project drops it on its next sync.
const { HttpError, send, fail, supabase } = require('./_lib');
const { deleteObject } = require('./_r2');

// How long an untouched project is kept, by plan. Keep in step with KEEP_DAYS in app/app.js.
const KEEP_DAYS = { free: 1, tier1: 2, creator: 5, studio: 7 };
const DAY = 86_400_000;

/** Each account's days from its active plan (the longest if it has several); accounts without one are Free. */
async function loadKeepDays(read = supabase) {
  const [subs, prices] = await Promise.all([
    read('subscriptions?select=user_id,price_id&status=in.(active,trialing,past_due)'),
    read('plan_prices?select=price_id,tier'),
  ]);
  // Never guess short: an unreadable plan list would delete paid accounts' projects early.
  if (!subs.response.ok || !Array.isArray(subs.body) || !prices.response.ok || !Array.isArray(prices.body)) throw new HttpError(502, 'Could not read plans.');
  const tierOf = new Map(prices.body.map((p) => [p.price_id, p.tier]));
  const days = new Map();
  for (const { user_id, price_id } of subs.body) {
    const d = KEEP_DAYS[tierOf.get(price_id)];
    if (d) days.set(user_id, Math.max(days.get(user_id) ?? 0, d));
  }
  return (user) => days.get(user) ?? KEEP_DAYS.free;
}
const lastEdit = (row) => Date.parse(row.updated ?? row.created ?? '');
const videosOf = (row) => (Array.isArray(row.media) ? row.media : [])
  .filter((m) => m?.cloud?.uploaded).map((m) => `${row.user_id}/${m.cloud.key ?? m.id}`);

/** Which projects go, and which stored videos go with them. An unreadable date never counts as old. */
function plan(rows, now, daysFor = () => KEEP_DAYS.studio) {
  const expired = rows.filter((row) => lastEdit(row) < now - daysFor(row.user_id) * DAY);
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
async function cleanupExpired(now, read = supabase, removeVideo = deleteObject, daysFor = () => KEEP_DAYS.studio) {
  const snapshot = await readProjects(read);
  const expired = snapshot.filter((row) => lastEdit(row) < now - daysFor(row.user_id) * DAY && typeof row.updated_at === 'string');
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
    const result = await cleanupExpired(Date.now(), supabase, deleteObject, await loadKeepDays());
    console.log(JSON.stringify({ cleanup: true, ...result }));
    send(res, 200, result);
  } catch (error) {
    fail(res, error);
  }
};

module.exports.plan = plan;
module.exports.readProjects = readProjects;
module.exports.cleanupExpired = cleanupExpired;
module.exports.loadKeepDays = loadKeepDays;
module.exports.KEEP_DAYS = KEEP_DAYS;
