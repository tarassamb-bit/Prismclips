-- Bug reports from the "Report a bug" form on the site and in the app. Anyone may send one (no account needed);
-- nobody can read them through the API: only the dashboard and service role see this table.
create table if not exists public.bug_reports (
  id uuid primary key default gen_random_uuid(),
  created timestamptz not null default now(),
  user_id uuid default auth.uid() references auth.users (id) on delete set null,
  message text not null check (char_length(btrim(message)) between 1 and 4000),
  email text check (email is null or char_length(email) <= 200),
  page text check (page is null or char_length(page) <= 500),
  agent text check (agent is null or char_length(agent) <= 500)
);

alter table public.bug_reports enable row level security;

drop policy if exists "anyone can send a bug report" on public.bug_reports;
create policy "anyone can send a bug report" on public.bug_reports
  for insert to anon, authenticated
  with check (user_id is null or user_id = auth.uid());

grant insert on public.bug_reports to anon, authenticated;

-- Flood guard: at most 20 reports a minute in total, so a script can't fill the table.
-- shortcut: one global limit, not per sender; switch to a per-IP limit in an edge function if real people hit it.
create or replace function public.prism_check_bug_report() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if (select count(*) from public.bug_reports where created > now() - interval '1 minute') >= 20 then
    raise exception 'Too many reports right now. Please try again in a minute.';
  end if;
  return new;
end $$;

drop trigger if exists prism_check_bug_report on public.bug_reports;
create trigger prism_check_bug_report before insert on public.bug_reports
  for each row execute function public.prism_check_bug_report();
