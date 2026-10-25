// Vercel function: Paddle subscription webhooks. The event only names the subscription that changed;
// its current state is fetched from Paddle and stored against the Supabase user ID from customData.
const crypto = require('crypto');
const { HttpError, send, fail, requireEnv, syncSubscription } = require('./_lib');

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
    const raw = await readBody(req);
    if (!verify(raw, req.headers['paddle-signature'], process.env.PADDLE_WEBHOOK_SECRET)) {
      throw new HttpError(401, 'Invalid signature.');
    }
    let event;
    try { event = JSON.parse(raw); } catch { throw new HttpError(400, 'Invalid JSON.'); }
    if (!event || typeof event !== 'object' || typeof event.event_type !== 'string') throw new HttpError(400, 'Invalid event.');
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
