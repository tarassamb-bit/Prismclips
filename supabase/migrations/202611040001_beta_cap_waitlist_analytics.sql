-- Beta cap, waitlist and product analytics. Safe to run more than once. Apply it in the Supabase SQL editor.
--
-- Beta cap: at most prism_beta_user_cap() accounts. A trigger on auth.users refuses the sign-up past the cap, so no
-- client can get around it. Supabase Auth reports a trigger error to the browser as "Database error saving new user",
-- so the web app checks beta_spots_left() after a failed sign-up to show the friendly "Beta is full" message.
-- To change the cap later, replace prism_beta_user_cap() with the new number; nothing else needs editing.
-- Unconfirmed sign-ups count as accounts; deleting an account frees its spot.
--
-- Waitlist: email only, no account. Written only through join_beta_waitlist(), which rate-limits; only the server reads it.
--
-- Analytics: the web app's eight product events, with buckets and counts only (no titles, no text a person wrote and no
-- account id). Anyone may insert a valid event; only the server reads them. Daily counts: select * from public.analytics_daily;
begin;

-- MARK: Beta cap

create or replace function public.prism_beta_user_cap()
returns integer language sql immutable set search_path = '' as $$
  select 100;
$$;
grant execute on function public.prism_beta_user_cap() to anon, authenticated;  -- the sign-up page shows "X of 100"

create or replace function public.beta_spots_left()
returns integer language sql stable security definer set search_path = '' as $$
  select greatest(0, public.prism_beta_user_cap() - (select count(*) from auth.users))::integer;
$$;
revoke all on function public.beta_spots_left() from public;
grant execute on function public.beta_spots_left() to anon, authenticated;

create or replace function public.prism_enforce_beta_cap()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  -- One sign-up at a time: the next one waits here, then counts the account this one just added.
  perform pg_advisory_xact_lock(hashtextextended('prism_beta_cap', 0));
  if (select count(*) from auth.users) >= public.prism_beta_user_cap() then
    raise exception 'BETA_FULL' using hint = 'The Prism beta is full. Join the waitlist instead.';
  end if;
  return new;
end;
$$;
revoke all on function public.prism_enforce_beta_cap() from public, anon, authenticated;

drop trigger if exists prism_beta_cap on auth.users;
create trigger prism_beta_cap before insert on auth.users
  for each row execute function public.prism_enforce_beta_cap();

-- MARK: Waitlist

create table if not exists public.beta_waitlist (
  email   text primary key check (length(email) <= 254 and email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'),
  created timestamptz not null default now()
);
-- Recent attempts, by a hash of the caller's address, for the rate limit only; kept a day.
create table if not exists public.beta_waitlist_attempts (
  caller  text not null,
  created timestamptz not null default now()
);
create index if not exists beta_waitlist_attempts_created on public.beta_waitlist_attempts (created);
alter table public.beta_waitlist enable row level security;
alter table public.beta_waitlist_attempts enable row level security;
revoke all on public.beta_waitlist, public.beta_waitlist_attempts from anon, authenticated;

-- Adds an email to the waitlist. Answers the same whether or not it was already there. Refuses with RATE_LIMITED after
-- 5 attempts an hour from one address, or 60 an hour from everyone (a flood), and INVALID_EMAIL for a malformed address.
create or replace function public.join_beta_waitlist(p_email text)
returns boolean language plpgsql volatile security definer set search_path = '' as $$
declare
  v_email  text := lower(trim(coalesce(p_email, '')));
  v_caller text := md5(coalesce(split_part(current_setting('request.headers', true)::json ->> 'x-forwarded-for', ',', 1), 'unknown'));
begin
  perform pg_advisory_xact_lock(hashtextextended('prism_beta_waitlist', 0));
  delete from public.beta_waitlist_attempts where created < now() - interval '1 day';
  if (select count(*) from public.beta_waitlist_attempts where caller = v_caller and created > now() - interval '1 hour') >= 5
     or (select count(*) from public.beta_waitlist_attempts where created > now() - interval '1 hour') >= 60 then
    raise exception 'RATE_LIMITED';
  end if;
  insert into public.beta_waitlist_attempts (caller) values (v_caller);
  if length(v_email) > 254 or v_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then
    raise exception 'INVALID_EMAIL';
  end if;
  insert into public.beta_waitlist (email) values (v_email) on conflict (email) do nothing;
  return true;
end;
$$;
revoke all on function public.join_beta_waitlist(text) from public;
grant execute on function public.join_beta_waitlist(text) to anon, authenticated;

-- MARK: Analytics events

create table if not exists public.analytics_events (
  id      bigint generated always as identity primary key,
  created timestamptz not null default now(),
  name    text not null check (name in ('signup_completed', 'video_selected', 'analysis_started', 'analysis_finished',
                                        'clips_generated', 'clip_exported', 'reanalysis_started', 'limit_reached')),
  data    jsonb not null default '{}' check (
    jsonb_typeof(data) = 'object'
    and (data - array['length', 'clips', 'quality']) = '{}'::jsonb
    and (not data ? 'length' or data ->> 'length' in ('<10 min', '10–30 min', '30–60 min', '60+ min'))
    and (not data ? 'clips' or (jsonb_typeof(data -> 'clips') = 'number' and (data ->> 'clips')::numeric between 0 and 100))
    and (not data ? 'quality' or data ->> 'quality' in ('full', 'compact', 'small'))
  )
);
alter table public.analytics_events enable row level security;
revoke all on public.analytics_events from anon, authenticated;
grant insert (name, data) on public.analytics_events to anon, authenticated;
drop policy if exists "Anyone can add an event" on public.analytics_events;
create policy "Anyone can add an event" on public.analytics_events for insert to anon, authenticated with check (true);

-- One row per day and event; only the server (SQL editor, service role) can read it.
create or replace view public.analytics_daily with (security_invoker = true) as
  select (created at time zone 'UTC')::date as day, name, count(*) as events
  from public.analytics_events group by 1, 2 order by 1 desc, 2;
revoke all on public.analytics_daily from anon, authenticated;

commit;
