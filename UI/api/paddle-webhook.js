// Vercel function: Paddle subscription webhooks. The event only names the subscription that changed;
// its current state is fetched from Paddle and stored against the Supabase user ID from customData.
const crypto = require('crypto');
const { HttpError, send, fail, requireEnv, paddle, syncSubscription, PADDLE_API } = require('./_lib');
const { recordPacks } = require('./billing');

// Only Paddle's own servers may call this. Their addresses come from Paddle's /ips (it can change), re-read hourly.
function addressCache({ fetcher = (...args) => fetch(...args), now = () => Date.now() } = {}) {
  let ips = null, ipsAt = 0;
  return async () => {
    if (ips && now() - ipsAt <= 3600_000) return ips;
    try {
      const response = await fetcher(`${PADDLE_API[process.env.PADDLE_ENV]}/ips`, { signal: AbortSignal.timeout(8000) });
      const body = await response.json();
      const cidrs = body?.data?.ipv4_cidrs;
      if (!response.ok || !Array.isArray(cidrs) || !cidrs.length || !cidrs.every((cidr) => typeof cidr === 'string' && cidr.length > 0)) throw new Error('Invalid address list');
      ips = new Set(cidrs.map((cidr) => cidr.replace(/\/32$/, '')));
      ipsAt = now();
    } catch {
      // A previously validated list remains restrictive during a temporary outage; signatures are always verified below.
      if (!ips) throw new HttpError(503, 'Couldn’t read Paddle’s addresses.');
    }
    return ips;
  };
}
const paddleIps = addressCache();

// The signature covers the exact bytes Paddle sent. Vercel puts the body back on the stream
// after its helpers read it, so reading it here always gets the raw bytes.
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function verify(raw, header, secret) {
  const parts = String(header || '').split(';').map((part) => part.trim().split('='));
  const timestamp = parts.find(([name]) => name === 'ts')?.[1];
  const ts = Number(timestamp);
  if (!Number.isSafeInteger(ts) || ts <= 0 || Math.abs(Date.now() / 1000 - ts) > 300) return false;
  const expected = crypto.createHmac('sha256', secret).update(`${timestamp}:${raw}`).digest();
  // Reject malformed input before comparing bytes, and accept any valid signature during key rotation.
  return parts.some(([name, value]) => name === 'h1' && /^[a-f0-9]{64}$/i.test(value || '')
    && crypto.timingSafeEqual(expected, Buffer.from(value, 'hex')));
}

async function handler(req, res) {
  try {
    if (req.method !== 'POST') throw new HttpError(405, 'Method not allowed.');
    requireEnv('PADDLE_ENV', 'PADDLE_API_KEY', 'PADDLE_WEBHOOK_SECRET', 'SUPABASE_SERVICE_ROLE_KEY');
    // Vercel puts the caller's real address first in x-forwarded-for.
    const caller = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    if (!(await paddleIps()).has(caller)) throw new HttpError(403, 'Not from Paddle.');
    const raw = await readBody(req);
    if (!verify(raw, req.headers['paddle-signature'], process.env.PADDLE_WEBHOOK_SECRET)) {
      throw new HttpError(401, 'Invalid signature.');
    }
    let event;
    try { event = JSON.parse(raw); } catch { throw new HttpError(400, 'Invalid JSON.'); }
    if (!event || typeof event !== 'object' || typeof event.event_type !== 'string') throw new HttpError(400, 'Invalid event.');
    // A paid pack is saved here too, so it counts even if the buyer closed the page before it could save it.
    if (event.event_type === 'transaction.completed') {
      if (typeof event.data?.id !== 'string' || !/^txn_[a-z0-9]+$/.test(event.data.id)) throw new HttpError(400, 'Invalid transaction ID.');
      const transaction = await paddle(`/transactions/${event.data.id}`);
      const userId = transaction.custom_data?.supabase_user_id;
      if (typeof userId === 'string' && /^[0-9a-f-]{36}$/.test(userId)) await recordPacks(transaction, userId);
      return send(res, 200, { result: 'transaction' });
    }
    if (!event.event_type.startsWith('subscription.')) {
      return send(res, 200, { ignored: true });
    }
    if (typeof event.data?.id !== 'string' || !/^sub_[a-z0-9]+$/.test(event.data.id)) throw new HttpError(400, 'Invalid subscription ID.');
    // Any error answer makes Paddle retry later.
    send(res, 200, { result: await syncSubscription(event.data.id) });
  } catch (error) {
    fail(res, error);
  }
}

module.exports = handler;
module.exports.verify = verify;
module.exports.addressCache = addressCache;
