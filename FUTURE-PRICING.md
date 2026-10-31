# Future pricing

Not live. The beta stays as it is: 60 minutes of video in total per account, plus promo codes (see `supabase/schema.sql`). This is the plan for paid tiers after the beta.

## Plans

| Plan | Price/mo | Video minutes/mo | Trial | Perks |
|---|---|---|---|---|
| Trial | $9 | 45 | None | All caption styles and layouts, 1080 × 1920 export |
| Creator | $39 | 300 (5 h) | 7 days | Everything in Trial, editor chat |
| Studio | $139 | 1,000 (~16.5 h) | 7 days | Everything in Creator, priority support |

Studio is aimed at agencies and teams. At $139 they will expect more than minutes, for example multiple seats. Prism has no seats yet.

## Cost check

Worst case, at the current `usd_per_minute` of $0.05 (`beta_settings` in `supabase/schema.sql`):

| Plan | Max AI cost | Share of price |
|---|---|---|
| Trial | $2.25 | 25% |
| Creator | $15 | 38% |
| Studio | $50 | 36% |

$0.05 is a guess. Measure the real cost per minute on OpenRouter's Activity page during the beta, then set `usd_per_minute` and revisit these minutes.

## Competitors

OpusClip, from memory and unverified: Starter about $15 for 150 minutes, Pro about $29 for 300 minutes. Check https://www.opus.pro/pricing before launch. Prism must not give fewer minutes for more money unless it has a clear reason to be chosen, such as local files and rendering on the Mac.

## To launch

1. In Paddle, create new monthly prices of $9, $39 and $139, sandbox first, then live. Existing price amounts can't be edited.
2. In `UI/pricing-tiers.js`, put in the new price IDs and fill each plan's `features`.
3. In `supabase/schema.sql`, replace the beta allowance with a monthly minute limit per plan, read from the account's Paddle subscription.
4. In the pricing FAQ, list only the platforms that have been tested. Windows and Linux are not tested yet.
5. Do one real purchase in sandbox and one in live mode.
