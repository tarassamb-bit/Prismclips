-- Cloud copy of the web app's projects and folders, so an account's work follows it to any browser.
-- Only the web app uses these tables; the desktop apps never touch them. Videos are not stored here: they stay on each
-- device and are re-attached by choosing the same file (the app checks it against the hash saved with the project).
-- Safe to run more than once. Apply it in the Supabase SQL editor, then reload the web app.
begin;

create table if not exists public.cloud_projects (
  user_id    uuid not null default auth.uid() references auth.users (id) on delete cascade,
  id         uuid not null,
  data       jsonb not null check (jsonb_typeof(data) = 'object' and octet_length(data::text) <= 4000000),
  updated_at timestamptz not null default now(),
  primary key (user_id, id)
);

create table if not exists public.cloud_folders (
  user_id    uuid not null default auth.uid() references auth.users (id) on delete cascade,
  id         uuid not null,
  data       jsonb not null check (jsonb_typeof(data) = 'object' and octet_length(data::text) <= 10000),
  updated_at timestamptz not null default now(),
  primary key (user_id, id)
);

alter table public.cloud_projects enable row level security;
alter table public.cloud_folders enable row level security;

-- Everyone reads and writes only their own rows.
drop policy if exists "Own projects" on public.cloud_projects;
create policy "Own projects" on public.cloud_projects for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
drop policy if exists "Own folders" on public.cloud_folders;
create policy "Own folders" on public.cloud_folders for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

revoke all on public.cloud_projects, public.cloud_folders from anon;
grant select, insert, update, delete on public.cloud_projects, public.cloud_folders to authenticated;

-- The server's clock decides when a row changed, so devices with different clocks agree on what is newer.
create or replace function public.cloud_touch() returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end;
$$;
drop trigger if exists cloud_projects_touch on public.cloud_projects;
create trigger cloud_projects_touch before insert or update on public.cloud_projects for each row execute function public.cloud_touch();
drop trigger if exists cloud_folders_touch on public.cloud_folders;
create trigger cloud_folders_touch before insert or update on public.cloud_folders for each row execute function public.cloud_touch();

-- Usage limits per account, so one account can't fill the database: 500 projects and 100 folders.
create or replace function public.cloud_limit() returns trigger language plpgsql as $$
declare
  rows integer;
begin
  if tg_table_name = 'cloud_projects' then
    select count(*) into rows from public.cloud_projects where user_id = new.user_id;
    if rows >= 500 then raise exception 'Cloud limit reached: 500 projects per account' using errcode = 'P0001'; end if;
  else
    select count(*) into rows from public.cloud_folders where user_id = new.user_id;
    if rows >= 100 then raise exception 'Cloud limit reached: 100 folders per account' using errcode = 'P0001'; end if;
  end if;
  return new;
end;
$$;
drop trigger if exists cloud_projects_limit on public.cloud_projects;
create trigger cloud_projects_limit before insert on public.cloud_projects for each row execute function public.cloud_limit();
drop trigger if exists cloud_folders_limit on public.cloud_folders;
create trigger cloud_folders_limit before insert on public.cloud_folders for each row execute function public.cloud_limit();

commit;
