-- People can delete their own live recordings; their live_clips rows go with them (on delete cascade), and the watcher
-- deletes the Shorts' files it no longer finds a row for.
drop policy if exists "delete a live session" on public.live_sessions;
create policy "delete a live session" on public.live_sessions for delete to authenticated using (user_id = auth.uid());
grant delete on public.live_sessions to authenticated;
