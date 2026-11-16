// Vercel function: hands the pricing page its public Paddle settings and the visitor's country.
// Only the client-side token is read here; the API key never is.
const { misconfigured, send, fail } = require('./_lib');

module.exports = (req, res) => {
  try {
    const environment = process.env.PADDLE_ENV;
    const token = process.env.PADDLE_CLIENT_TOKEN;
    if (environment !== 'sandbox' && environment !== 'production') {
      throw misconfigured('PADDLE_ENV must be set to "sandbox" or "production".');
    }
    if (!token) throw misconfigured('PADDLE_CLIENT_TOKEN is not set.');
    // Sandbox tokens start with test_, live ones with live_; a mismatch means the wrong account.
    if (token.startsWith('test_') !== (environment === 'sandbox')) {
      throw misconfigured(`PADDLE_CLIENT_TOKEN does not match PADDLE_ENV=${environment}.`);
    }

    // No header (or a non-country value) means null, and Paddle detects the country from the IP.
    const header = req.headers['x-vercel-ip-country'];
    const country = typeof header === 'string' && /^[A-Z]{2}$/.test(header) && header !== 'XX' ? header : null;
    send(res, 200, { environment, token, country });
  } catch (error) {
    fail(res, error);
  }
};
