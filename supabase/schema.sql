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

-- Beta allowance: 60 minutes of video in total per account, counted once per video. Promo codes add minutes.
-- Run this section once in Supabase → SQL Editor, after the video limit section above. It is safe to run again.
create table if not exists public.usage_allowance (
  user_id uuid primary key references auth.users (id) on delete cascade,
  minutes double precision not null check (minutes >= 0 and minutes < 100000)
);
alter table public.usage_allowance enable row level security;

drop policy if exists "Read own allowance" on public.usage_allowance;
create policy "Read own allowance" on public.usage_allowance
  for select to authenticated using (user_id = auth.uid());

-- Promo codes are read and changed only by the database itself (no policies), so the app can't list or edit them.
create table if not exists public.promo_codes (
  code    text primary key,
  minutes double precision not null check (minutes > 0 and minutes < 100000),
  active  boolean not null default true
);
alter table public.promo_codes enable row level security;

create table if not exists public.promo_redemptions (
  code    text not null references public.promo_codes (code) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  primary key (code, user_id)
);
alter table public.promo_redemptions enable row level security;

-- Minutes this account may use: 60 plus every promo code it has redeemed.
create or replace function public.my_usage()
returns table (used double precision, allowance double precision)
language sql stable security invoker set search_path = public as $$
  select
    coalesce((select sum(m) from (select max(minutes) as m from public.usage_videos
      where user_id = auth.uid() group by video) t), 0),
    coalesce((select minutes from public.usage_allowance where user_id = auth.uid()), 60);
$$;

-- True when `p_video` may be used: it was used before, or its minutes fit in what is left of the allowance.
create or replace function public.usage_allowed(p_video text, p_day date, p_minutes double precision)
returns boolean language sql stable security invoker set search_path = public as $$
  with mine as (
    select video, max(minutes) as minutes from public.usage_videos where user_id = auth.uid() group by video
  )
  select exists (select 1 from mine where video = p_video)
    or coalesce((select sum(minutes) from mine), 0) + p_minutes
       <= coalesce((select minutes from public.usage_allowance where user_id = auth.uid()), 60);
$$;

-- Adds a promo code's minutes to this account. Each code works once per account; errors are shown to the person.
create or replace function public.redeem_promo(p_code text)
returns double precision language plpgsql security definer set search_path = public as $$
declare
  v_code text := upper(trim(p_code));
  v_minutes double precision;
  v_uid uuid := auth.uid();
begin
  if v_uid is null then raise exception 'Sign in to redeem a promo code.' using errcode = '42501'; end if;
  select minutes into v_minutes from public.promo_codes where code = v_code and active;
  if v_minutes is null then raise exception 'That promo code is not valid.' using errcode = '22023'; end if;
  if exists (select 1 from public.promo_redemptions where code = v_code and user_id = v_uid) then
    raise exception 'You have already used this promo code.' using errcode = '22023';
  end if;
  insert into public.promo_redemptions (code, user_id) values (v_code, v_uid);
  insert into public.usage_allowance (user_id, minutes) values (v_uid, 60 + v_minutes)
    on conflict (user_id) do update set minutes = public.usage_allowance.minutes + excluded.minutes;
  return (select minutes from public.usage_allowance where user_id = v_uid);
end;
$$;

-- Create a promo code for someone you invite. Example: insert into promo_codes (code, minutes) values ('FRIEND60', 60);
-- To stop a code: update promo_codes set active = false where code = 'FRIEND60';
