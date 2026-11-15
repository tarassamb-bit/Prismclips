-- "Play while you wait" games: one weekly leaderboard per game (top 10, the week starts Monday 00:00 UTC).
-- Players insert only their own score; nobody updates or deletes one; reads go through game_leaderboard(), which returns
-- usernames only (never emails or user ids). A trigger rejects impossible scores and more than one score per 5 s per account.
-- The limits match UI/app/games/scoring.js (LIMITS); keep both in step. Safe to run more than once.
begin;

create table if not exists public.game_scores (
  id         bigint generated always as identity primary key,
  user_id    uuid not null default auth.uid() references auth.users (id) on delete cascade,
  game       text not null check (game in ('stack', 'draw', 'reaction')),
  score      int  not null,
  played_ms  int  not null check (played_ms between 0 and 7200000),
  week       date not null default (date_trunc('week', now() at time zone 'utc'))::date,
  created_at timestamptz not null default now()
);
create index if not exists game_scores_board on public.game_scores (game, week);
create index if not exists game_scores_recent on public.game_scores (user_id, created_at desc);

alter table public.game_scores enable row level security;
revoke all on public.game_scores from anon, authenticated;
-- Only these columns can be sent; user_id, week and created_at are set by the database.
grant insert (game, score, played_ms) on public.game_scores to authenticated;
drop policy if exists "Insert own score" on public.game_scores;
create policy "Insert own score" on public.game_scores for insert to authenticated with check (user_id = auth.uid());
-- No select, update or delete policies: rows are never read directly, changed or removed by players.

/** Rejects impossible scores and floods. Security definer so it can see the account's earlier rows, which RLS hides. */
create or replace function public.prism_check_game_score()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  new.user_id := auth.uid();
  new.week := (date_trunc('week', now() at time zone 'utc'))::date;
  new.created_at := now();
  if new.user_id is null then raise exception 'Sign in to save a score.' using errcode = '42501'; end if;
  -- Human reaction to a colour change takes at least 100 ms; slower than 5 s isn't a reaction.
  if new.game = 'reaction' and not (new.score between 100 and 5000) then
    raise exception 'That reaction time is not possible.' using errcode = '22023';
  end if;
  -- The tower takes at most one drop per 300 ms (scoring.js LIMITS.stackDropMs), so height is bounded by time played.
  if new.game = 'stack' and not (new.score between 0 and new.played_ms / 300 + 1) then
    raise exception 'That tower is taller than the time played allows.' using errcode = '22023';
  end if;
  -- The logo alone is shown for 3 s, so a drawing can't be scored sooner.
  if new.game = 'draw' and not (new.score between 0 and 100 and new.played_ms >= 3000) then
    raise exception 'That drawing score is not possible.' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('game:' || new.user_id::text, 0));
  if exists (select 1 from public.game_scores where user_id = new.user_id and created_at > now() - interval '5 seconds') then
    raise exception 'Wait a few seconds before saving another score.' using errcode = '54000';
  end if;
  return new;
end;
$$;
revoke all on function public.prism_check_game_score() from public, anon, authenticated;
drop trigger if exists game_scores_check on public.game_scores;
create trigger game_scores_check before insert on public.game_scores for each row execute function public.prism_check_game_score();

/** This week's top 10 for one game: each player's best score (highest; lowest time for the reaction test), with their
 *  username only. Players without a username show as "Player". */
create or replace function public.game_leaderboard(p_game text)
returns table (rank int, username text, score int)
language sql stable security definer set search_path = '' as $$
  with best as (
    select s.user_id,
           case when p_game = 'reaction' then min(s.score) else max(s.score) end as score,
           min(s.created_at) as first_at
    from public.game_scores s
    where s.game = p_game and s.week = (date_trunc('week', now() at time zone 'utc'))::date
    group by s.user_id
  )
  select (row_number() over (order by case when p_game = 'reaction' then b.score else -b.score end, b.first_at))::int,
         coalesce(p.username, 'Player'), b.score
  from best b left join public.profiles p on p.user_id = b.user_id
  order by 1
  limit 10;
$$;
revoke all on function public.game_leaderboard(text) from public, anon;
grant execute on function public.game_leaderboard(text) to authenticated;

commit;
