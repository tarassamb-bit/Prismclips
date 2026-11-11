// Vercel function: hands the web app its public PostHog project key, read from the POSTHOG_PROJECT_KEY environment variable
// so the key is never in the code. Project keys (phc_…) are public by design; they can only send events, not read them.
const { HttpError, send, fail } = require('./_lib');

module.exports = (req, res) => {
  try {
    const key = process.env.POSTHOG_PROJECT_KEY;
    if (!key || !key.startsWith('phc_')) throw new HttpError(503, 'POSTHOG_PROJECT_KEY is not set.');
    send(res, 200, { key, host: 'https://eu.i.posthog.com' });
  } catch (error) {
    fail(res, error);
  }
};
