-- Re-analysis runs. Apply after 202610270001_secure_beta_usage.sql and before deploying the gateway that sends
-- x-prism-run. Every analysis run of a video is recorded per account and content hash.
-- The first analysis charges the video's full minutes (through prism_reserve_beta_usage). Every re-analysis charges
-- a share of them, rounded up to whole minutes, at least 1: half on Trial or without a plan, a third on Creator and
-- Studio. A run is refused when the remaining allowance can't cover it.
-- Runs before this migration aren't recorded, so a video's first recorded run counts as its first analysis.
begin;

create table if not exists public.usage_runs (
  user_id         uuid not null references auth.users (id) on delete cascade,
  video           text not null check (video ~ '^[0-9a-f]{64}$'),
  run             uuid not null,
  charged_minutes double precision not null default 0 check (charged_minutes >= 0 and charged_minutes <= 600),
  created         timestamptz not null default now(),
  primary key (user_id, video, run)
);
alter table public.usage_runs enable row level security;
drop policy if exists "Read own runs" on public.usage_runs;
create policy "Read own runs" on public.usage_runs for select to authenticated using (user_id = auth.uid());
revoke insert, update, delete, truncate, references, trigger on public.usage_runs from anon, authenticated;

-- Which plan each Paddle price is. These are the sandbox prices in UI/pricing-tiers.js; add the live prices at launch.
create table if not exists public.plan_prices (
  price_id text primary key,
  tier     text not null check (tier in ('trial', 'creator', 'studio'))
);
insert into public.plan_prices (price_id, tier) values
  ('pri_01m5h8qse4hefjmw1j9j9tn708', 'trial'),
  ('pri_01m5h8qspmxxtzsnankzef16t2', 'creator'),
  ('pri_01m5h8qszm3h86qpkn06wyx1y3', 'studio')
on conflict (price_id) do update set tier = excluded.tier;
alter table public.plan_prices enable row level security;  -- no policies: only the functions below read it

-- Minutes one re-analysis of a `p_minutes` video costs this account: a third on an active or trialing Creator or
-- Studio plan, else half; rounded up to whole minutes, at least 1.
create or replace function public.prism_reanalysis_charge(p_user uuid, p_minutes double precision)
returns double precision language sql stable security definer set search_path = public, pg_temp as $$
  select greatest(1, ceil(p_minutes * case when exists (
    select 1 from public.subscriptions s join public.plan_prices p on p.price_id = s.price_id
    where s.user_id = p_user and s.status in ('active', 'trialing') and p.tier in ('creator', 'studio')
  ) then 1.0 / 3 else 0.5 end))::double precision;
$$;
revoke all on function public.prism_reanalysis_charge(uuid, double precision) from public, anon, authenticated;
grant execute on function public.prism_reanalysis_charge(uuid, double precision) to service_role;

-- Minutes an account has used: each video once (its recorded length), plus every charged re-analysis.
create or replace function public.prism_used_minutes(p_user uuid)
returns double precision language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce((select sum(m) from (select max(minutes) as m from public.usage_videos
           where user_id = p_user group by video) videos), 0)
       + coalesce((select sum(charged_minutes) from public.usage_runs where user_id = p_user), 0);
$$;
revoke all on function public.prism_used_minutes(uuid) from public, anon, authenticated;
grant execute on function public.prism_used_minutes(uuid) to service_role;

-- Same as 202610270001, except that charged re-analyses count toward the minutes already used.
create or replace function public.prism_reserve_beta_usage(p_user uuid, p_video text, p_minutes double precision)
returns boolean language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_prior double precision;
  v_allowance double precision;
  v_spent double precision;
  v_per_minute double precision;
begin
  if p_user is null or p_video !~ '^[0-9a-f]{64}$' or p_minutes is null
      or not (p_minutes > 0 and p_minutes <= 600) then return false; end if;
  -- Concurrent requests for this account must not both spend the same remaining minutes.
  perform pg_advisory_xact_lock(hashtextextended(p_user::text, 0));
  select 60 + coalesce((select bonus_minutes from public.usage_allowance where user_id = p_user), 0)
    into v_allowance;
  select coalesce(spent_usd, 0) into v_spent from public.usage_spend where user_id = p_user;
  select value into v_per_minute from public.beta_settings where key = 'usd_per_minute';
  if v_per_minute is null or coalesce(v_spent, 0) >= v_allowance * v_per_minute then return false; end if;
  select max(minutes) into v_prior from public.usage_videos where user_id = p_user and video = p_video;
  if v_prior is not null then
    -- Do not allow the claimed duration of an already registered video to change.
    return abs(v_prior - p_minutes) < 0.01;
  end if;
  if public.prism_used_minutes(p_user) + p_minutes > v_allowance then return false; end if;
  insert into public.usage_videos (user_id, video, day, minutes)
    values (p_user, p_video, (now() at time zone 'UTC')::date, p_minutes);
  return true;
end;
$$;
revoke all on function public.prism_reserve_beta_usage(uuid, text, double precision) from public, anon, authenticated;
grant execute on function public.prism_reserve_beta_usage(uuid, text, double precision) to service_role;

-- Records the run the first time one of its requests arrives; later requests of the same run pass at once.
-- The first run adds nothing here: the reservation already charged the video's full minutes. Every later run is a
-- re-analysis and charges prism_reanalysis_charge, or is refused when the remaining allowance can't cover it.
create or replace function public.prism_begin_analysis_run(p_user uuid, p_video text, p_run uuid, p_minutes double precision)
returns boolean language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_runs integer;
  v_allowance double precision;
  v_charge double precision := 0;
begin
  if p_user is null or p_run is null or p_video !~ '^[0-9a-f]{64}$' or p_minutes is null
      or not (p_minutes > 0 and p_minutes <= 600) then return false; end if;
  -- The same lock as the reservation: a run's parallel first requests must not record or charge it twice.
  perform pg_advisory_xact_lock(hashtextextended(p_user::text, 0));
  if exists (select 1 from public.usage_runs where user_id = p_user and video = p_video and run = p_run) then return true; end if;
  select count(*) into v_runs from public.usage_runs where user_id = p_user and video = p_video;
  if v_runs > 0 then
    v_charge := public.prism_reanalysis_charge(p_user, p_minutes);
    select 60 + coalesce((select bonus_minutes from public.usage_allowance where user_id = p_user), 0) into v_allowance;
    if public.prism_used_minutes(p_user) + v_charge > v_allowance then return false; end if;
  end if;
  insert into public.usage_runs (user_id, video, run, charged_minutes) values (p_user, p_video, p_run, v_charge);
  return true;
end;
$$;
revoke all on function public.prism_begin_analysis_run(uuid, text, uuid, double precision) from public, anon, authenticated;
grant execute on function public.prism_begin_analysis_run(uuid, text, uuid, double precision) to service_role;

-- What the app shows before a run: how many runs of this video the signed-in account made, and what the next
-- re-analysis would charge (0 before the first run, whose cost is the video's full minutes). Reads only the caller's rows.
create or replace function public.my_reanalysis(p_video text)
returns table (runs integer, charge double precision)
language sql stable security definer set search_path = public, pg_temp as $$
  select r.runs,
         case when r.runs = 0 or v.minutes is null then 0 else public.prism_reanalysis_charge(auth.uid(), v.minutes) end
  from (select count(*)::integer as runs from public.usage_runs where user_id = auth.uid() and video = p_video) r
  left join (select max(minutes) as minutes from public.usage_videos where user_id = auth.uid() and video = p_video) v on true
  where auth.uid() is not null;
$$;
revoke all on function public.my_reanalysis(text) from public, anon;
grant execute on function public.my_reanalysis(text) to authenticated;

-- Settings › Usage includes charged re-analyses.
create or replace function public.my_usage()
returns table (used double precision, allowance double precision)
language sql stable security invoker set search_path = public, pg_temp as $$
  select
    coalesce((select sum(m) from (select max(minutes) as m from public.usage_videos
      where user_id = auth.uid() group by video) t), 0)
      + coalesce((select sum(charged_minutes) from public.usage_runs where user_id = auth.uid()), 0),
    60 + coalesce((select bonus_minutes from public.usage_allowance where user_id = auth.uid()), 0);
$$;

commit;
