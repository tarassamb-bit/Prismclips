-- What Prism AI really costs per minute of video. The AI servers (Vercel api/gemini.js and the gemini edge function) write one
-- ai_spend row per answer with OpenRouter's own reported cost; usage_spend can't be used for this, because it keeps a single
-- running total per account and counts every answer at least $0.002. Rows start when this is deployed; earlier days show no cost.
create table if not exists public.ai_spend (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  user_id uuid references auth.users (id) on delete set null,
  source text not null check (source in ('web', 'desktop')),
  model text,
  provider text,
  usd double precision not null check (usd >= 0),
  prompt_tokens int,
  completion_tokens int
);
create index if not exists ai_spend_at on public.ai_spend (at desc);
alter table public.ai_spend enable row level security;
revoke all on public.ai_spend from anon, authenticated;

-- Per UTC day: minutes of video analyzed (every run counts its whole video, first runs and re-analyses alike), what OpenRouter
-- charged that day (analysis plus framing at export, chat and descriptions), and the cost per analyzed minute.
--   select * from ai_cost_daily;
create or replace view public.ai_cost_daily with (security_invoker = true) as
with videos as (
  select user_id, video, max(minutes) as minutes from public.usage_videos group by user_id, video
), processed as (
  select (r.created at time zone 'UTC')::date as day, count(*) as runs, sum(v.minutes) as minutes
  from public.usage_runs r join videos v using (user_id, video) group by 1
), spend as (
  select (at at time zone 'UTC')::date as day, sum(usd) as usd, count(*) as answers from public.ai_spend group by 1
)
select coalesce(p.day, s.day) as day, coalesce(p.runs, 0) as runs, round(coalesce(p.minutes, 0)::numeric, 1) as minutes_processed,
  coalesce(s.answers, 0) as answers, round(s.usd::numeric, 4) as openrouter_usd,
  round((s.usd / nullif(p.minutes, 0))::numeric, 5) as usd_per_minute
from processed p full join spend s using (day)
order by 1 desc;
revoke all on public.ai_cost_daily from anon, authenticated;
