-- A run that was cancelled or failed before it saved any Shorts doesn't count: the app calls my_abandon_run, which deletes
-- the run's row. That refunds what it charged and stops the next run of the video being charged as a re-analysis.
-- The video's first-analysis charge (usage_videos) stays. Only the caller's own runs from the last 3 hours can be removed.
-- shortcut: someone could cancel at 99% every time and rerun without a re-analysis charge; they keep no Shorts from those runs,
-- so only AI cost is lost. Cap abandons per video if ai_spend shows abuse.
create or replace function public.my_abandon_run(p_video text, p_run uuid)
returns boolean language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if auth.uid() is null or p_video is null or p_run is null then return false; end if;
  delete from public.usage_runs
   where user_id = auth.uid() and video = p_video and run = p_run and created > now() - interval '3 hours';
  return found;
end;
$$;
revoke all on function public.my_abandon_run(text, uuid) from public, anon;
grant execute on function public.my_abandon_run(text, uuid) to authenticated;
