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
  const gone = new Set(expired.map((row) => row.id));
  const stillUsed = new Set(rows.filter((row) => !gone.has(row.id)).flatMap(videosOf));
  const videos = [...new Set(expired.flatMap(videosOf))].filter((key) => !stillUsed.has(key));
  return { projects: [...gone], videos };
}

module.exports = async (req, res) => {
  try {
    // Vercel sends this on its cron runs when CRON_SECRET is set; any other caller is refused.
    if (!process.env.CRON_SECRET || req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) throw new HttpError(401, 'Not allowed.');
    // shortcut: one read of up to 1,000 projects (PostgREST's page size); page through them once the beta grows past that.
    const { response, body } = await supabase('cloud_projects?select=id,user_id,updated:data->>updated,created:data->>created,media:data->media');
    if (!response.ok || !Array.isArray(body)) throw new HttpError(502, 'Could not read projects.');
    const { projects, videos } = plan(body, Date.now());
    // Rows first: if this stops partway, no remaining project points at a video that is already gone.
    if (projects.length) {
      const removed = await supabase(`cloud_projects?id=in.(${projects.join(',')})`, { method: 'DELETE' });
      if (!removed.response.ok) throw new HttpError(502, 'Could not delete projects.');
    }
    for (const key of videos) await deleteObject(key);
    console.log(JSON.stringify({ cleanup: true, projects: projects.length, videos: videos.length }));
    send(res, 200, { projects: projects.length, videos: videos.length });
  } catch (error) {
    fail(res, error);
  }
};

module.exports.plan = plan;
