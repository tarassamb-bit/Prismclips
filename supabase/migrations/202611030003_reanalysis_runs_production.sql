-- Re-analysis runs for the production schema, where usage_allowance.minutes holds each account's whole allowance
-- (default 60) and there is no beta_settings table. Replaces 202610270002_reanalysis_runs.sql, which assumed a
-- bonus_minutes column and plan prices that production doesn't have. The gemini function (version 10 and later) calls
-- prism_begin_analysis_run for every analysis request; without it, making Shorts fails with "could not check your allowance".
-- The first analysis of a video charges its full minutes (prism_reserve_beta_usage); each re-analysis charges half of
-- them, rounded up, at least 1 minute. Safe to run more than once. Apply it in the Supabase SQL editor.
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

create or replace function public.prism_allowance(p_user uuid)
returns double precision language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce((select minutes from public.usage_allowance where user_id = p_user), 60);
$$;

-- Each video once (its recorded length), plus every charged re-analysis.
create or replace function public.prism_used_minutes(p_user uuid)
returns double precision language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce((select sum(m) from (select max(minutes) as m from public.usage_videos
           where user_id = p_user group by video) videos), 0)
       + coalesce((select sum(charged_minutes) from public.usage_runs where user_id = p_user), 0);
$$;

create or replace function public.prism_reanalysis_charge(p_minutes double precision)
returns double precision language sql immutable set search_path = public, pg_temp as $$
  select greatest(1, ceil(p_minutes * 0.5))::double precision;
$$;

revoke all on function public.prism_allowance(uuid) from public, anon, authenticated;
revoke all on function public.prism_used_minutes(uuid) from public, anon, authenticated;
grant execute on function public.prism_allowance(uuid), public.prism_used_minutes(uuid) to service_role;

-- As before, except that charged re-analyses count toward the minutes already used.
create or replace function public.prism_reserve_beta_usage(p_user uuid, p_video text, p_minutes double precision)
returns boolean language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_prior double precision;
begin
  if p_user is null or p_video is null or p_video !~ '^[0-9a-f]{64}$' or p_minutes is null
      or not (p_minutes > 0 and p_minutes <= 600) then return false; end if;
  -- Concurrent requests for this account must not both spend the same remaining minutes.
  perform pg_advisory_xact_lock(hashtextextended(p_user::text, 0));
  select max(minutes) into v_prior from public.usage_videos where user_id = p_user and video = p_video;
  if v_prior is not null then
    -- Do not allow the claimed duration of an already registered video to change.
    return abs(v_prior - p_minutes) < 0.01;
  end if;
  if public.prism_used_minutes(p_user) + p_minutes > public.prism_allowance(p_user) then return false; end if;
  insert into public.usage_videos (user_id, video, day, minutes)
    values (p_user, p_video, (now() at time zone 'UTC')::date, p_minutes);
  return true;
end;
$$;
revoke all on function public.prism_reserve_beta_usage(uuid, text, double precision) from public, anon, authenticated;
grant execute on function public.prism_reserve_beta_usage(uuid, text, double precision) to service_role;

-- Records a run the first time one of its requests arrives; its later requests pass at once. The first run of a video
-- adds nothing (the reservation charged it); each later run charges half, or is refused when the allowance can't cover it.
create or replace function public.prism_begin_analysis_run(p_user uuid, p_video text, p_run uuid, p_minutes double precision)
returns boolean language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_charge double precision := 0;
begin
  if p_user is null or p_run is null or p_video !~ '^[0-9a-f]{64}$' or p_minutes is null
      or not (p_minutes > 0 and p_minutes <= 600) then return false; end if;
  -- The same lock as the reservation: a run's parallel first requests must not record or charge it twice.
  perform pg_advisory_xact_lock(hashtextextended(p_user::text, 0));
  if exists (select 1 from public.usage_runs where user_id = p_user and video = p_video and run = p_run) then return true; end if;
  if exists (select 1 from public.usage_runs where user_id = p_user and video = p_video) then
    v_charge := public.prism_reanalysis_charge(p_minutes);
    if public.prism_used_minutes(p_user) + v_charge > public.prism_allowance(p_user) then return false; end if;
  end if;
  insert into public.usage_runs (user_id, video, run, charged_minutes) values (p_user, p_video, p_run, v_charge);
  return true;
end;
$$;
revoke all on function public.prism_begin_analysis_run(uuid, text, uuid, double precision) from public, anon, authenticated;
grant execute on function public.prism_begin_analysis_run(uuid, text, uuid, double precision) to service_role;

-- Before a run, the app shows how many runs of this video the account made and what the next one would charge.
create or replace function public.my_reanalysis(p_video text)
returns table (runs integer, charge double precision)
language sql stable security definer set search_path = public, pg_temp as $$
  select r.runs, case when r.runs = 0 or v.minutes is null then 0 else public.prism_reanalysis_charge(v.minutes) end
  from (select count(*)::integer as runs from public.usage_runs where user_id = auth.uid() and video = p_video) r
  left join (select max(minutes) as minutes from public.usage_videos where user_id = auth.uid() and video = p_video) v on true
  where auth.uid() is not null;
$$;
revoke all on function public.my_reanalysis(text) from public, anon;
grant execute on function public.my_reanalysis(text) to authenticated;

-- Settings › Usage and the check before making Shorts include charged re-analyses.
create or replace function public.my_usage()
returns table (used double precision, allowance double precision)
language sql stable security invoker set search_path = public, pg_temp as $$
  select
    coalesce((select sum(m) from (select max(minutes) as m from public.usage_videos
      where user_id = auth.uid() group by video) t), 0)
      + coalesce((select sum(charged_minutes) from public.usage_runs where user_id = auth.uid()), 0),
    coalesce((select minutes from public.usage_allowance where user_id = auth.uid()), 60);
$$;

create or replace function public.usage_allowed(p_video text, p_day date, p_minutes double precision)
returns boolean language sql stable set search_path = public, pg_temp as $$
  with mine as (
    select video, max(minutes) as minutes from public.usage_videos where user_id = auth.uid() group by video
  )
  select exists (select 1 from mine where video = p_video)
    or coalesce((select sum(minutes) from mine), 0)
       + coalesce((select sum(charged_minutes) from public.usage_runs where user_id = auth.uid()), 0) + p_minutes
       <= coalesce((select minutes from public.usage_allowance where user_id = auth.uid()), 60);
$$;

commit;
