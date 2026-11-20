// The paid plans. These are the Paddle SANDBOX prices (test cards only, no real money); swap in the live price IDs at launch.
// Checkout works only where the server has the Paddle settings (localhost with the sandbox keys); relioclips.com still sends
// /pricing to the app (vercel.json) until billing goes live.
window.PRISM_BILLING_ENABLED = true;
/**
 * @typedef {Object} Tier
 * @property {string} name
 * @property {string} description
 * @property {string[]} features
 * @property {string} priceId
 * @property {string} [badge]
 */

// One-time packs for the month they're bought: video minutes (also offered before a plan's checkout) and Live hours.
window.PRISM_PACK = { priceId: 'pri_01m7wykejd7qj2jm895kpb8cyy', minutes: 100 };
window.PRISM_LIVE_PACK = { priceId: 'pri_01m7x801j9rtht27jw31r9vavh', hours: 10 };

/** @type {Tier[]} */
window.PRISM_TIERS = [
  {
    name: 'Tier 1',
    description: 'Start making Shorts every month.',
    features: ['150 minutes of video a month', '1080p exports, no watermark', 'Live clipping: 1 channel, 25 hours a month', 'Recordings up to 4 hours', '30 live Shorts a day'],
    priceId: 'pri_01m7wxv785xs9pzn319erq7wtn',
  },
  {
    name: 'Creator',
    description: 'For creators publishing every week.',
    features: ['450 minutes of video a month', '1080p exports, no watermark', 'Live clipping: 2 channels at once, 100 hours a month', 'Recordings up to 24 hours', '100 live Shorts a day'],
    priceId: 'pri_01m7wxv7jvh2e830hj69y0merw',
    badge: 'Most popular',
  },
  {
    name: 'Studio',
    description: 'For teams and channels at full speed.',
    features: ['2,000 minutes of video a month', '1080p exports, no watermark', 'Live clipping: 5 channels at once, 400 hours a month', 'Recordings up to 48 hours', '300 live Shorts a day'],
    priceId: 'pri_01m7wxv7wmheyjcr6qqz3cy41b',
  },
];
