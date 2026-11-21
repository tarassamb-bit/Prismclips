// The paid plans: Paddle LIVE prices on relioclips.com, SANDBOX prices (test cards only) everywhere else, matching
// the server's PADDLE_ENV (production on relioclips.com, sandbox on localhost).
window.PRISM_BILLING_ENABLED = true;
// shortcut: live is chosen by hostname; a preview deployment with PADDLE_ENV=production would get sandbox IDs.
const PRISM_LIVE = /(^|\.)relioclips\.com$/.test(location.hostname);
const prismPrice = (sandbox, live) => (PRISM_LIVE ? live : sandbox);
/**
 * @typedef {Object} Tier
 * @property {string} name
 * @property {string} description
 * @property {string[]} features
 * @property {string} priceId
 * @property {string} [badge]
 */

// One-time packs for the month they're bought: video minutes (also offered before a plan's checkout) and Live hours.
window.PRISM_PACK = { priceId: prismPrice('pri_01m7wykejd7qj2jm895kpb8cyy', 'pri_01m7z8ycnqttzw183g03j59jre'), minutes: 100 };
window.PRISM_LIVE_PACK = { priceId: prismPrice('pri_01m7x801j9rtht27jw31r9vavh', 'pri_01m7z8yd2m4w7cv2nasnt49grn'), hours: 10 };

// What an account without a paid plan gets; shown in Settings › Plan.
window.PRISM_FREE = { name: 'Free', features: ['20 minutes of video a month', '720p exports with watermark', 'Live clipping: 1 channel, 1 hour a month', 'Recordings up to 1 hour', '3 live Shorts a day'] };

/** @type {Tier[]} */
window.PRISM_TIERS = [
  {
    name: 'Tier 1',
    description: 'Start making Shorts every month.',
    features: ['150 minutes of video a month', '4K exports, no watermark', 'Live clipping: 1 channel, 25 hours a month', 'Recordings up to 4 hours', '30 live Shorts a day'],
    priceId: prismPrice('pri_01m7wxv785xs9pzn319erq7wtn', 'pri_01m7z8ybf53k8xtd0cghm6hrnb'),
  },
  {
    name: 'Creator',
    description: 'For creators publishing every week.',
    features: ['450 minutes of video a month', '4K exports, no watermark', 'Live clipping: 2 channels at once, 100 hours a month', 'Recordings up to 24 hours', '100 live Shorts a day'],
    priceId: prismPrice('pri_01m7wxv7jvh2e830hj69y0merw', 'pri_01m7z8ybvx3b7d6k0nx0r2edb9'),
    badge: 'For weekly creators',
  },
  {
    name: 'Studio',
    description: 'For teams and channels at full speed.',
    features: ['2,000 minutes of video a month', '4K exports, no watermark', 'Live clipping: 5 channels at once, 400 hours a month', 'Recordings up to 48 hours', '300 live Shorts a day'],
    priceId: prismPrice('pri_01m7wxv7wmheyjcr6qqz3cy41b', 'pri_01m7z8yc8ysxtmph5v5gv94y2c'),
  },
];
