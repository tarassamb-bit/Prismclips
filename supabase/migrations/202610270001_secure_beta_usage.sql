-- Additive rollout phase: install service-only RPCs while the old gateway still
-- works. Deploy the new gateway, verify it and drain old requests before running
-- ../rollout/contract_beta_usage.sql. Paid monthly entitlements are not included.
begin;

-- Older deployed beta projects do not have spend tracking. Add the table without
-- changing the current beta allowance or imposing a new spending cap at cutover.
create table if not exists public.usage_spend (
  user_id uuid primary key references auth.users (id) on delete cascade,
  spent_usd double precision not null default 0
);
alter table public.usage_spend enable row level security;

create or replace function public.prism_reserve_beta_usage(p_user uuid, p_video text, p_minutes double precision)
returns boolean language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_used double precision;
  v_prior double precision;
  v_allowance double precision;
  v_spent double precision;
  v_per_minute double precision;
begin
  if p_user is null or p_video is null or p_video !~ '^[0-9a-f]{64}$' or p_minutes is null
      or not (p_minutes > 0 and p_minutes <= 600) then return false; end if;
  -- Concurrent requests for this account must not both spend the same remaining minutes.
  perform pg_advisory_xact_lock(hashtextextended(p_user::text, 0));
  -- Current production stores the full allowance in minutes. Newer schemas store
  -- promo minutes separately; support both without resetting anyone's allowance.
  if exists (select 1 from information_schema.columns where table_schema = 'public'
             and table_name = 'usage_allowance' and column_name = 'bonus_minutes') then
    execute 'select 60 + coalesce((select bonus_minutes from public.usage_allowance where user_id = $1), 0)'
      into v_allowance using p_user;
  else
    select coalesce((select minutes from public.usage_allowance where user_id = p_user), 60)
      into v_allowance;
  end if;
  -- Retain an existing beta spend cap where configured, without introducing
  -- a new cap on the older production schema that never had one.
  if to_regclass('public.beta_settings') is not null then
    execute 'select value from public.beta_settings where key = ''usd_per_minute'''
      into v_per_minute;
    select spent_usd into v_spent from public.usage_spend where user_id = p_user;
    if v_per_minute is null or coalesce(v_spent, 0) >= v_allowance * v_per_minute then return false; end if;
  end if;
  select max(minutes) into v_prior from public.usage_videos where user_id = p_user and video = p_video;
  if v_prior is not null then
    -- Do not allow the claimed duration of an already registered video to change.
    return abs(v_prior - p_minutes) < 0.01;
  end if;
  select coalesce(sum(m), 0) into v_used from
    (select max(minutes) as m from public.usage_videos where user_id = p_user group by video) videos;
  if v_used + p_minutes > v_allowance then return false; end if;
  insert into public.usage_videos (user_id, video, day, minutes)
    values (p_user, p_video, (now() at time zone 'UTC')::date, p_minutes);
  return true;
end;
$$;
revoke all on function public.prism_reserve_beta_usage(uuid, text, double precision) from public, anon, authenticated;
grant execute on function public.prism_reserve_beta_usage(uuid, text, double precision) to service_role;

create or replace function public.prism_record_beta_spend(p_user uuid, p_usd double precision)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if p_user is null or p_usd is null or not (p_usd > 0 and p_usd <= 5) then
    raise exception 'Invalid AI spend';
  end if;
  insert into public.usage_spend (user_id, spent_usd) values (p_user, p_usd)
    on conflict (user_id) do update set spent_usd = public.usage_spend.spent_usd + excluded.spent_usd;
end;
$$;
revoke all on function public.prism_record_beta_spend(uuid, double precision) from public, anon, authenticated;
grant execute on function public.prism_record_beta_spend(uuid, double precision) to service_role;

commit;
