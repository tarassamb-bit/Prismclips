-- Prism account stats. Run once in Supabase → SQL Editor.
-- One row per finished export from the Mac app. Row Level Security keeps every user to their own rows.

create table if not exists public.exports (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid() references auth.users (id) on delete cascade,
  created_at  timestamptz not null default now(),
  short_count integer not null check (short_count between 1 and 100),
  seconds     double precision not null check (seconds >= 0 and seconds < 100000),
  quality     text not null check (quality in ('full', 'compact', 'small'))
);

alter table public.exports enable row level security;

drop policy if exists "Read own exports" on public.exports;
create policy "Read own exports" on public.exports
  for select to authenticated using (user_id = auth.uid());

drop policy if exists "Add own exports" on public.exports;
create policy "Add own exports" on public.exports
  for insert to authenticated with check (user_id = auth.uid());

create index if not exists exports_user_created on public.exports (user_id, created_at desc);

-- Paddle subscriptions, written only by the webhook (api/paddle-webhook.js) with the service role key.
-- Each row belongs to the Supabase user whose ID was passed as customData at checkout.
create table if not exists public.subscriptions (
  id               text primary key,
  user_id          uuid not null references auth.users (id) on delete cascade,
  customer_id      text not null,
  price_id         text,
  status           text not null,
  next_billed_at   timestamptz,
  scheduled_change jsonb,
  event_at         timestamptz not null
);

alter table public.subscriptions enable row level security;

drop policy if exists "Read own subscriptions" on public.subscriptions;
create policy "Read own subscriptions" on public.subscriptions
  for select to authenticated using (user_id = auth.uid());

create index if not exists subscriptions_user on public.subscriptions (user_id);

-- Video limit: 60 minutes of video a day and 300 a week per account, enforced here so the app can't skip it.
-- Each row is one video on one day, with its length in minutes. `video` is a SHA-256 of the file's name and length,
-- never the name itself. Run this section once in Supabase → SQL Editor. It is safe to run again.
create table if not exists public.usage_videos (
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  video   text not null check (char_length(video) = 64),
  day     date not null,
  minutes double precision not null default 0 check (minutes >= 0 and minutes < 100000),
  primary key (user_id, video, day)
);

alter table public.usage_videos add column if not exists minutes double precision not null default 0;
alter table public.usage_videos enable row level security;

drop policy if exists "Read own usage" on public.usage_videos;
create policy "Read own usage" on public.usage_videos
  for select to authenticated using (user_id = auth.uid());

-- True when a video of `p_minutes` may be used on `p_day`: the week (Monday to Sunday) and the day must each have room.
-- A video already used that week or day is always allowed again, and counts only once.
drop policy if exists "Add own usage" on public.usage_videos;
drop function if exists public.usage_allowed(text, date);
create or replace function public.usage_allowed(p_video text, p_day date, p_minutes double precision)
returns boolean language sql stable security invoker set search_path = public as $$
  with week as (select date_trunc('week', p_day)::date as start),
  mine as (
    select u.video, u.day, u.minutes from public.usage_videos u, week
    where u.user_id = auth.uid() and u.day >= week.start and u.day < week.start + 7
  ),
  week_videos as (select video, max(minutes) as minutes from mine group by video),
  day_videos as (select video, max(minutes) as minutes from mine where day = p_day group by video)
  select
    (exists (select 1 from week_videos where video = p_video)
      or coalesce((select sum(minutes) from week_videos), 0) + p_minutes <= 300)
    and (exists (select 1 from day_videos where video = p_video)
      or coalesce((select sum(minutes) from day_videos), 0) + p_minutes <= 60);
$$;

-- An insert is refused by the database itself when it would pass either limit.
create policy "Add own usage" on public.usage_videos
  for insert to authenticated with check (user_id = auth.uid() and public.usage_allowed(video, day, minutes));
