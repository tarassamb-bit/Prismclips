-- Free plan: a video counts at most the Free allowance (20 minutes) however long it is, so a new creator can try Relio on a
-- real hour-long recording. Paid plans still count a video's full length. Each video now stores what it was charged
-- (usage_videos.charged); its real length stays in `minutes` for the "same video, same length" check. A re-analysis
-- charges half of what the video was charged. my_usage and usage_allowed (what the app shows and checks first) now use
-- the same server functions, so they agree with the gateway: monthly, by plan, packs included.
begin;

alter table public.usage_videos add column if not exists charged double precision;

-- What a first analysis of a video of p_minutes charges this account.
create or replace function public.prism_video_charge(p_user uuid, p_minutes double precision)
returns double precision language sql stable security definer set search_path = public, pg_temp as $$
  select case when public.prism_plan(p_user) is null
    then least(p_minutes, coalesce((select upload_minutes from public.plan_limits where tier = 'free'), 20))
    else p_minutes end;
$$;
revoke all on function public.prism_video_charge(uuid, double precision) from public, anon, authenticated;
grant execute on function public.prism_video_charge(uuid, double precision) to service_role;

-- Rows from before this change have no charge stored: they count their full length, as they did.
create or replace function public.prism_used_minutes(p_user uuid)
returns double precision language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce((select sum(m) from (select max(coalesce(charged, minutes)) as m from public.usage_videos
           where user_id = p_user and day >= date_trunc('month', now())::date group by video) videos), 0)
       + coalesce((select sum(charged_minutes) from public.usage_runs where user_id = p_user and created >= date_trunc('month', now())), 0);
$$;

create or replace function public.prism_reserve_beta_usage(p_user uuid, p_video text, p_minutes double precision)
returns boolean language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_prior double precision;
  v_charge double precision;
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
  v_charge := public.prism_video_charge(p_user, p_minutes);
  if public.prism_used_minutes(p_user) + v_charge > public.prism_allowance(p_user) then return false; end if;
  insert into public.usage_videos (user_id, video, day, minutes, charged)
    values (p_user, p_video, (now() at time zone 'UTC')::date, p_minutes, v_charge);
  return true;
end;
$$;

-- What the video was charged on its first analysis (its full length for rows from before this change).
create or replace function public.prism_charged_for(p_user uuid, p_video text)
returns double precision language sql stable security definer set search_path = public, pg_temp as $$
  select max(coalesce(charged, minutes)) from public.usage_videos where user_id = p_user and video = p_video;
$$;
revoke all on function public.prism_charged_for(uuid, text) from public, anon, authenticated;
grant execute on function public.prism_charged_for(uuid, text) to service_role;

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
    v_charge := public.prism_reanalysis_charge(coalesce(public.prism_charged_for(p_user, p_video), p_minutes));
    if public.prism_used_minutes(p_user) + v_charge > public.prism_allowance(p_user) then return false; end if;
  end if;
  insert into public.usage_runs (user_id, video, run, charged_minutes) values (p_user, p_video, p_run, v_charge);
  return true;
end;
$$;

create or replace function public.my_reanalysis(p_video text)
returns table (runs integer, charge double precision)
language sql stable security definer set search_path = public, pg_temp as $$
  select r.runs, case when r.runs = 0 or v.charged is null then 0 else public.prism_reanalysis_charge(v.charged) end
  from (select count(*)::integer as runs from public.usage_runs where user_id = auth.uid() and video = p_video) r
  left join (select public.prism_charged_for(auth.uid(), p_video) as charged) v on true
  where auth.uid() is not null;
$$;

-- Only the caller's own numbers: auth.uid() is the only account these read.
create or replace function public.my_usage()
returns table (used double precision, allowance double precision)
language sql stable security definer set search_path = public, pg_temp as $$
  select public.prism_used_minutes(auth.uid()), public.prism_allowance(auth.uid()) where auth.uid() is not null;
$$;
revoke all on function public.my_usage() from public, anon;
grant execute on function public.my_usage() to authenticated;

create or replace function public.usage_allowed(p_video text, p_day date, p_minutes double precision)
returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select auth.uid() is not null and (
    exists (select 1 from public.usage_videos where user_id = auth.uid() and video = p_video)
    or public.prism_used_minutes(auth.uid()) + public.prism_video_charge(auth.uid(), p_minutes) <= public.prism_allowance(auth.uid()));
$$;
revoke all on function public.usage_allowed(text, date, double precision) from public, anon;
grant execute on function public.usage_allowed(text, date, double precision) to authenticated;

commit;
