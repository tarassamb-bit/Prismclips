-- The Live screen's graph: the watcher keeps the last five minutes of loudness, chat and hype per second on the session row.
alter table public.live_sessions add column if not exists graph jsonb;
