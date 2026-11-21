// Vercel function: billing actions for the signed-in user. PADDLE_API_KEY stays on the server.
//   POST ?action=sync&transaction_id=txn_…  save a just-finished checkout (202 until Paddle attaches the subscription)
//   POST ?action=refresh                     re-read the user's subscriptions from Paddle
//   POST ?action=portal                      link to the Paddle billing portal for their subscriptions
const { ACTIVE, HttpError, send, fail, requireEnv, paddle, supabase, getUser, syncSubscription } = require('./_lib');

// The one-time packs (Paddle sandbox and live prices): 100 extra video minutes, or 10 extra Live hours, for the month they're bought.
const MINUTES = { table: 'minute_packs', field: 'minutes', amount: 100 }, HOURS = { table: 'live_packs', field: 'hours', amount: 10 };
const PACKS = {
  pri_01m7wykejd7qj2jm895kpb8cyy: MINUTES, pri_01m7z8ycnqttzw183g03j59jre: MINUTES,
  pri_01m7x801j9rtht27jw31r9vavh: HOURS, pri_01m7z8yd2m4w7cv2nasnt49grn: HOURS,
};

/** Saves the packs of a paid transaction to the account, once per transaction. */
async function recordPacks(transaction, userId) {
  if (!['paid', 'completed'].includes(transaction.status)) return;
  for (const table of ['minute_packs', 'live_packs']) {
    const kinds = (transaction.items ?? []).map((item) => ({ pack: PACKS[item.price?.id], quantity: item.quantity ?? 1 })).filter((x) => x.pack?.table === table);
    if (!kinds.length) continue;
    const field = kinds[0].pack.field, total = kinds.reduce((sum, x) => sum + x.pack.amount * x.quantity, 0);
    const { response, text } = await supabase(`${table}?on_conflict=transaction_id`, {
      method: 'POST', headers: { Prefer: 'resolution=ignore-duplicates,return=minimal' },
      body: JSON.stringify({ transaction_id: transaction.id, user_id: userId, [field]: total }),
    });
    if (!response.ok) throw new HttpError(502, `Supabase returned ${response.status}: ${text}`);
  }
}

async function userSubscriptions(userId, filter = '') {
  const { response, body } = await supabase(
    `subscriptions?user_id=eq.${userId}${filter}&select=id,customer_id&order=event_at.desc&limit=20`,
  );
  if (!response.ok) throw new HttpError(502, 'Couldn’t read your subscriptions.');
  return body;
}

module.exports = async (req, res) => {
  try {
    if (req.method !== 'POST') throw new HttpError(405, 'Method not allowed.');
    requireEnv('PADDLE_ENV', 'PADDLE_API_KEY', 'SUPABASE_SERVICE_ROLE_KEY');
    const query = new URL(req.url, 'http://localhost').searchParams;
    const user = await getUser(req);

    switch (query.get('action')) {
      case 'sync': {
        const transactionId = query.get('transaction_id') || '';
        if (!/^txn_[a-z0-9]+$/.test(transactionId)) throw new HttpError(400, 'Invalid transaction ID.');
        const transaction = await paddle(`/transactions/${transactionId}`);
        if (transaction.custom_data?.supabase_user_id !== user.id) throw new HttpError(403, 'This purchase belongs to another account.');
        await recordPacks(transaction, user.id);
        // A pack on its own is done here; for a plan, Paddle attaches the subscription a moment after payment and the browser asks again.
        const forPlan = (transaction.items ?? []).some((item) => item.price?.billing_cycle);
        if (!forPlan) return send(res, 200, { result: 'pack' });
        if (!transaction.subscription_id) return send(res, 202, { pending: true });
        return send(res, 200, { result: await syncSubscription(transaction.subscription_id) });
      }
      case 'refresh': {
        const rows = await userSubscriptions(user.id);
        // One subscription Paddle can't return mustn't stop the others from updating.
        const results = await Promise.allSettled(rows.map((row) => syncSubscription(row.id)));
        const failed = results.filter((result) => result.status === 'rejected');
        for (const { reason } of failed) console.error('Refresh failed:', reason.message);
        return send(res, 200, { refreshed: rows.length - failed.length, failed: failed.length });
      }
      case 'portal': {
        const rows = await userSubscriptions(user.id, `&status=in.(${ACTIVE})`);
        if (!rows.length) throw new HttpError(404, 'No subscription to manage yet.');
        // A portal session covers one Paddle customer; use the most recent one's subscriptions.
        const { customer_id: customerId } = rows[0];
        const session = await paddle(`/customers/${customerId}/portal-sessions`, {
          method: 'POST',
          body: JSON.stringify({ subscription_ids: rows.filter((row) => row.customer_id === customerId).map((row) => row.id) }),
        });
        return send(res, 200, { url: session.urls.general.overview });
      }
      default:
        throw new HttpError(400, 'Unknown action.');
    }
  } catch (error) {
    fail(res, error);
  }
};
module.exports.recordPacks = recordPacks;
