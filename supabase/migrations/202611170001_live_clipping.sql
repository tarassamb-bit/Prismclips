-- Server live clipping: a person asks for a Twitch channel to be recorded (live_sessions); the watcher server records it,
-- keeps the last 15 minutes, and saves each likely moment as a short MP4 in the person's cloud storage (live_clips).
-- People read their own rows, start a recording, and may only stop one; everything else is the watcher's (secret key).
create table if not exists public.live_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  login text not null check (login ~ '^[a-z0-9_]{3,25}$'),
  state text not null default 'starting' check (state in ('starting', 'recording', 'offline', 'stopped', 'ended', 'error')),
  detail text,
  buffered integer not null default 0,
  chat boolean not null default false,
  created timestamptz not null default now(),
  updated timestamptz not null default now()
);

create table if not exists public.live_clips (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.live_sessions (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  at timestamptz not null,
  why text not null,
  media_id text not null,
  bytes bigint not null,
  duration real not null,
  created timestamptz not null default now()
);

create index if not exists live_sessions_active on public.live_sessions (state) where state in ('starting', 'recording', 'offline');
create index if not exists live_clips_session on public.live_clips (session_id, at desc);

alter table public.live_sessions enable row level security;
alter table public.live_clips enable row level security;

drop policy if exists "own live sessions" on public.live_sessions;
create policy "own live sessions" on public.live_sessions for select to authenticated using (user_id = auth.uid());
drop policy if exists "start a live session" on public.live_sessions;
create policy "start a live session" on public.live_sessions for insert to authenticated
  with check (user_id = auth.uid() and state = 'starting');
drop policy if exists "stop a live session" on public.live_sessions;
create policy "stop a live session" on public.live_sessions for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid() and state = 'stopped');

drop policy if exists "own live clips" on public.live_clips;
create policy "own live clips" on public.live_clips for select to authenticated using (user_id = auth.uid());

grant select, insert on public.live_sessions to authenticated;
grant update (state) on public.live_sessions to authenticated;
grant select on public.live_clips to authenticated;

-- At most two recordings per person at once, and a channel only once per person.
create or replace function public.prism_check_live_session() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if (select count(*) from public.live_sessions where user_id = new.user_id and state in ('starting', 'recording', 'offline')) >= 2 then
    raise exception 'You can record two channels at once. Stop one first.';
  end if;
  if exists (select 1 from public.live_sessions where user_id = new.user_id and login = new.login and state in ('starting', 'recording', 'offline')) then
    raise exception 'That channel is already recording.';
  end if;
  return new;
end $$;

drop trigger if exists prism_check_live_session on public.live_sessions;
create trigger prism_check_live_session before insert on public.live_sessions
  for each row execute function public.prism_check_live_session();
