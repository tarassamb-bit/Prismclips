-- Profiles: each account's name and unique username, shown in the app. Sign-in stays with email. Safe to run more than once.
-- The sign-up form sends `name` and `username` as user metadata; a trigger creates the profile in the same transaction as the
-- account, so a username taken in the meantime refuses the sign-up (USERNAME_TAKEN) instead of creating an account without it.
-- Accounts made with Google (or before this migration) start without a username and choose one in Settings › Account.
begin;

create table if not exists public.profiles (
  user_id      uuid primary key references auth.users (id) on delete cascade,
  display_name text check (display_name is null or length(display_name) between 1 and 60),
  username     text check (username is null or username ~ '^[a-z0-9_]{3,20}$'),
  created      timestamptz not null default now()
);
create unique index if not exists profiles_username on public.profiles (username);
alter table public.profiles enable row level security;
revoke all on public.profiles from anon, authenticated;
grant select on public.profiles to authenticated;
grant update (display_name, username) on public.profiles to authenticated;
drop policy if exists "Read own profile" on public.profiles;
create policy "Read own profile" on public.profiles for select to authenticated using (user_id = auth.uid());
drop policy if exists "Update own profile" on public.profiles;
create policy "Update own profile" on public.profiles for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

/** A username in the stored form: lower case, trimmed, without a leading @; null when it isn't a valid one. */
create or replace function public.prism_clean_username(p_username text)
returns text language sql immutable set search_path = '' as $$
  select case when lower(ltrim(trim(coalesce(p_username, '')), '@')) ~ '^[a-z0-9_]{3,20}$'
              then lower(ltrim(trim(p_username), '@')) end;
$$;

-- The sign-up form asks while someone types. Answers false for invalid names, so it can't be used to test anything else.
create or replace function public.username_available(p_username text)
returns boolean language sql stable security definer set search_path = '' as $$
  select public.prism_clean_username(p_username) is not null
     and not exists (select 1 from public.profiles where username = public.prism_clean_username(p_username));
$$;
revoke all on function public.username_available(text) from public;
grant execute on function public.username_available(text) to anon, authenticated;

create or replace function public.prism_create_profile()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_name     text := nullif(left(trim(coalesce(new.raw_user_meta_data ->> 'name', new.raw_user_meta_data ->> 'full_name', '')), 60), '');
  v_username text := public.prism_clean_username(new.raw_user_meta_data ->> 'username');
begin
  if v_username is not null and exists (select 1 from public.profiles where username = v_username) then
    raise exception 'USERNAME_TAKEN';
  end if;
  insert into public.profiles (user_id, display_name, username) values (new.id, v_name, v_username)
    on conflict (user_id) do nothing;
  return new;
end;
$$;
revoke all on function public.prism_create_profile() from public, anon, authenticated;

drop trigger if exists prism_create_profile on auth.users;
create trigger prism_create_profile after insert on auth.users
  for each row execute function public.prism_create_profile();

-- Existing accounts get an empty profile, so Settings can offer to choose a username.
insert into public.profiles (user_id) select id from auth.users on conflict (user_id) do nothing;

commit;
