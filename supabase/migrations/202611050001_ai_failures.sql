-- Every failed Prism AI model attempt, written by the AI servers (Vercel api/gemini.js for the web app, the gemini edge
-- function for the desktop apps) with the service role. Only the owner reads it, in the dashboard or SQL editor.
create table if not exists public.ai_failures (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  user_id uuid references auth.users (id) on delete set null,
  source text not null check (source in ('web', 'desktop')),
  model text not null,
  provider text,
  kind text check (kind in ('audio', 'image', 'text')),
  attempt int,
  -- timeout, rate_limit, no_provider, account, bad_request, provider_error, empty_answer, or gave_up (every model failed)
  error_type text not null,
  status int,
  ms int,
  message text
);
create index if not exists ai_failures_at on public.ai_failures (at desc);

-- No policies: the table is closed to the app's users; the service role bypasses row level security.
alter table public.ai_failures enable row level security;
revoke all on public.ai_failures from anon, authenticated;

-- How often each model fails, per day: select * from ai_failures_daily;
create or replace view public.ai_failures_daily with (security_invoker = true) as
select date_trunc('day', at)::date as day, source, model, coalesce(provider, '—') as provider, error_type, count(*) as failures
from public.ai_failures group by 1, 2, 3, 4, 5 order by 1 desc, 6 desc;
revoke all on public.ai_failures_daily from anon, authenticated;
