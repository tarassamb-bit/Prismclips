-- The paid plans (Paddle sandbox catalog of 2026-11-20): which price is which plan, what each plan includes, and the
-- upload minutes a paying account gets each month. Accounts without a paid plan keep their beta allowance.
alter table public.plan_prices drop constraint if exists plan_prices_tier_check;
alter table public.plan_prices add constraint plan_prices_tier_check check (tier in ('trial', 'tier1', 'creator', 'studio'));
insert into public.plan_prices (price_id, tier) values
  ('pri_01m7wxv785xs9pzn319erq7wtn', 'tier1'),
  ('pri_01m7wxv7jvh2e830hj69y0merw', 'creator'),
  ('pri_01m7wxv7wmheyjcr6qqz3cy41b', 'studio')
on conflict (price_id) do update set tier = excluded.tier;

-- What each plan includes; the app reads it to show the plan, and the limits below use it.
create table if not exists public.plan_limits (
  tier text primary key,
  name text not null,
  upload_minutes integer not null,
  export text not null,
  watermark boolean not null,
  live_channels integer not null,
  live_hours integer not null,
  max_recording_hours integer not null,
  live_shorts_per_day integer not null
);
insert into public.plan_limits values
  ('free',    'Free',    20,   '720p',  true,  1, 1,   1,  3),
  ('tier1',   'Tier 1',  150,  '1080p', false, 1, 25,  4,  30),
  ('creator', 'Creator', 450,  '1080p', false, 2, 100, 24, 100),
  ('studio',  'Studio',  2000, '1080p', false, 5, 400, 48, 300)
on conflict (tier) do update set name = excluded.name, upload_minutes = excluded.upload_minutes, export = excluded.export,
  watermark = excluded.watermark, live_channels = excluded.live_channels, live_hours = excluded.live_hours,
  max_recording_hours = excluded.max_recording_hours, live_shorts_per_day = excluded.live_shorts_per_day;
alter table public.plan_limits enable row level security;
drop policy if exists "anyone reads plan limits" on public.plan_limits;
create policy "anyone reads plan limits" on public.plan_limits for select to anon, authenticated using (true);
grant select on public.plan_limits to anon, authenticated;

-- The account's paid plan ('tier1', 'creator', 'studio'), or null without one. Past-due keeps the plan while Paddle retries.
create or replace function public.prism_plan(p_user uuid)
returns text language sql stable security definer set search_path = public, pg_temp as $$
  select p.tier from public.subscriptions s join public.plan_prices p on p.price_id = s.price_id
  where s.user_id = p_user and s.status in ('active', 'trialing', 'past_due') and p.tier in ('tier1', 'creator', 'studio')
  order by case p.tier when 'studio' then 1 when 'creator' then 2 else 3 end limit 1;
$$;
revoke all on function public.prism_plan(uuid) from public, anon;
grant execute on function public.prism_plan(uuid) to authenticated, service_role;

-- A paid plan's monthly minutes; otherwise the beta allowance (60, or what was granted).
create or replace function public.prism_allowance(p_user uuid)
returns double precision language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce((select l.upload_minutes from public.plan_limits l where l.tier = public.prism_plan(p_user)),
                  (select minutes from public.usage_allowance where user_id = p_user), 60);
$$;

-- On a paid plan only this calendar month's use counts; without one, all use since the start (the beta rule).
-- shortcut: the month is the calendar month, not the Paddle billing period; switch to the subscription's period when billing goes live.
create or replace function public.prism_used_minutes(p_user uuid)
returns double precision language sql stable security definer set search_path = public, pg_temp as $$
  with since as (select case when public.prism_plan(p_user) is null then '-infinity'::timestamptz else date_trunc('month', now()) end as t)
  select coalesce((select sum(m) from (select max(minutes) as m from public.usage_videos, since
           where user_id = p_user and day >= since.t::date group by video) videos), 0)
       + coalesce((select sum(charged_minutes) from public.usage_runs, since where user_id = p_user and created >= since.t), 0);
$$;

-- The signed-in person's plan and its limits, for the app (Settings › Usage, the pricing page).
create or replace function public.my_plan()
returns table (tier text, name text, upload_minutes integer, export text, watermark boolean, live_channels integer, live_hours integer,
               max_recording_hours integer, live_shorts_per_day integer)
language sql stable security definer set search_path = public, pg_temp as $$
  select l.tier, l.name, l.upload_minutes, l.export, l.watermark, l.live_channels, l.live_hours, l.max_recording_hours, l.live_shorts_per_day
  from public.plan_limits l where l.tier = coalesce(public.prism_plan(auth.uid()), 'free');
$$;
revoke all on function public.my_plan() from public, anon;
grant execute on function public.my_plan() to authenticated;
