-- Live clipping records Kick channels too: each recording says which site it is on, and Kick names may have hyphens.
alter table public.live_sessions add column if not exists platform text not null default 'twitch';
alter table public.live_sessions drop constraint if exists live_sessions_platform_check;
alter table public.live_sessions add constraint live_sessions_platform_check check (platform in ('twitch', 'kick'));
alter table public.live_sessions drop constraint if exists live_sessions_login_check;
alter table public.live_sessions add constraint live_sessions_login_check check (login ~ '^[a-z0-9_-]{2,25}$');

-- Starting a recording: within the plan's channels at once and its Live hours this month, and a channel only once per site.
create or replace function public.prism_check_live_session() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_limits record;
begin
  select * into v_limits from public.prism_live_limits(new.user_id);
  if (select count(*) from public.live_sessions where user_id = new.user_id and state in ('starting', 'recording', 'offline')) >= v_limits.channels then
    raise exception 'Your plan records % % at once. Stop one first, or upgrade.', v_limits.channels, case when v_limits.channels = 1 then 'channel' else 'channels' end;
  end if;
  if v_limits.hours_used >= v_limits.hours_allowed then
    raise exception 'You used your Live hours for this month. Buy 10 more hours, or upgrade.';
  end if;
  if exists (select 1 from public.live_sessions where user_id = new.user_id and login = new.login and platform = new.platform and state in ('starting', 'recording', 'offline')) then
    raise exception 'That channel is already recording.';
  end if;
  return new;
end $$;

-- People start recordings (a channel and its site) and stop them; everything else on the row is the watcher's. Before
-- this, an update could also reset recorded_seconds and dodge the month's Live hours.
revoke insert, update on public.live_sessions from authenticated;
grant insert (login, platform) on public.live_sessions to authenticated;
grant update (state) on public.live_sessions to authenticated;

-- Deleting a recording keeps its hours on the month: they are moved here first, and the limits count both.
create table if not exists public.live_removed (
  user_id uuid not null references auth.users (id) on delete cascade,
  created timestamptz not null,
  recorded_seconds integer not null
);
alter table public.live_removed enable row level security;  -- no policies: only the functions read it

create or replace function public.prism_keep_live_hours() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if old.recorded_seconds > 0 then
    insert into public.live_removed (user_id, created, recorded_seconds) values (old.user_id, old.created, old.recorded_seconds);
  end if;
  return old;
end $$;
drop trigger if exists keep_live_hours on public.live_sessions;
create trigger keep_live_hours before delete on public.live_sessions for each row execute function public.prism_keep_live_hours();

create or replace function public.prism_live_limits(p_user uuid)
returns table (channels integer, hours_allowed double precision, hours_used double precision, max_recording_hours integer, shorts_per_day integer)
language sql stable security definer set search_path = public, pg_temp as $$
  select l.live_channels,
         l.live_hours + coalesce((select sum(hours) from public.live_packs where user_id = p_user and bought >= date_trunc('month', now())), 0),
         (coalesce((select sum(recorded_seconds) from public.live_sessions where user_id = p_user and created >= date_trunc('month', now())), 0)
          + coalesce((select sum(recorded_seconds) from public.live_removed where user_id = p_user and created >= date_trunc('month', now())), 0)) / 3600.0,
         l.max_recording_hours, l.live_shorts_per_day
  from public.plan_limits l where l.tier = coalesce(public.prism_plan(p_user), 'free');
$$;
