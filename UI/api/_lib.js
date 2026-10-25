// Shared server code for the api/ functions. Vercel never turns files starting with "_" into endpoints.
const SUPABASE_URL = 'https://isdplhahgggundbohmlr.supabase.co';
const SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_ATTcp2-mrca0swMStHHdYQ_Le851b8l';
const PADDLE_API = { sandbox: 'https://sandbox-api.paddle.com', production: 'https://api.paddle.com' };
const ACTIVE = ['active', 'trialing', 'past_due', 'paused'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// Plain Node responses, so the functions work with or without Vercel's request helpers.
function send(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'private, no-store');
  res.end(JSON.stringify(body));
}

function fail(res, error) {
  if (error instanceof HttpError) return send(res, error.status, { error: error.message });
  console.error(error);
  send(res, 500, { error: 'Something went wrong. Please try again.' });
}

function requireEnv(...names) {
  const missing = names.filter((name) => !process.env[name]);
  if (missing.length) throw new HttpError(500, `Missing environment variables: ${missing.join(', ')}.`);
  if (!PADDLE_API[process.env.PADDLE_ENV]) throw new HttpError(500, 'PADDLE_ENV must be "sandbox" or "production".');
}

// Every outside call gets a timeout, so a slow service fails with a clear error instead of hanging the function.
async function call(service, url, init = {}) {
  let response;
  let text;
  try {
    response = await fetch(url, { ...init, signal: AbortSignal.timeout(8000) });
    text = await response.text();
  } catch (error) {
    throw new HttpError(502, `${service} didn’t respond. Please try again.`);
  }
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch {}
  return { response, body, text };
}

async function paddle(path, init = {}) {
  const { response, body } = await call('Paddle', PADDLE_API[process.env.PADDLE_ENV] + path, {
    ...init,
    headers: { Authorization: `Bearer ${process.env.PADDLE_API_KEY}`, 'Content-Type': 'application/json' },
  });
  if (!response.ok) throw new HttpError(response.status === 404 ? 404 : 502, body?.error?.detail || `Paddle returned ${response.status}.`);
  if (!body || typeof body !== 'object' || body.data == null) throw new HttpError(502, 'Paddle returned an incomplete response. Please try again.');
  return body.data;
}

// The service role bypasses row level security: only ever filter by IDs the server has verified.
function supabase(path, init = {}) {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  return call('Supabase', `${SUPABASE_URL}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: key,
      // Legacy service_role keys are JWTs and go in Authorization too; sb_secret_ keys must not.
      ...(key.startsWith('eyJ') && { Authorization: `Bearer ${key}` }),
      'Content-Type': 'application/json',
      ...init.headers,
    },
  });
}

// The caller's Supabase session decides whose data a request may touch.
async function getUser(req) {
  const { response, body } = await call('Supabase', `${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: SUPABASE_PUBLISHABLE_KEY, Authorization: req.headers.authorization || '' },
  });
  if (!response.ok || !UUID.test(body?.id || '')) throw new HttpError(401, 'Your session expired. Sign in again.');
  return body;
}

// Copies one subscription from Paddle into Supabase. Paddle is the source of truth: a webhook or the
// browser only says which subscription to look at, and its current state is always fetched fresh.
async function syncSubscription(id) {
  const sub = await paddle(`/subscriptions/${encodeURIComponent(id)}`);
  const userId = sub.custom_data?.supabase_user_id;
  if (!UUID.test(userId || '')) return 'no user'; // Bought while signed out: nothing to link.
  const row = {
    id: sub.id,
    user_id: userId,
    customer_id: sub.customer_id,
    price_id: sub.items?.[0]?.price?.id ?? null,
    status: sub.status,
    next_billed_at: sub.next_billed_at,
    scheduled_change: sub.scheduled_change,
    event_at: sub.updated_at,
  };
  const insert = await supabase('subscriptions?on_conflict=id', {
    method: 'POST',
    headers: { Prefer: 'resolution=ignore-duplicates,return=minimal' },
    body: JSON.stringify(row),
  });
  // 409: the user ID isn't a Prism account (deleted, or forged customData). Retrying won't help.
  if (insert.response.status === 409) return 'unknown user';
  if (!insert.response.ok) throw new HttpError(502, `Supabase returned ${insert.response.status}: ${insert.text}`);
  // Only overwrite an older copy, so a slow sync can't replace a newer one.
  const update = await supabase(
    `subscriptions?id=eq.${encodeURIComponent(sub.id)}&event_at=lt.${encodeURIComponent(sub.updated_at)}`,
    { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify(row) },
  );
  if (!update.response.ok) throw new HttpError(502, `Supabase returned ${update.response.status}: ${update.text}`);
  return 'synced';
}

module.exports = { ACTIVE, HttpError, send, fail, requireEnv, paddle, supabase, getUser, syncSubscription };
