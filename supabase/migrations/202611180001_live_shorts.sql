-- Finished Shorts made by the watcher from each live spike: { state: making|ready|failed, id, title, video, poster }.
alter table public.live_clips add column if not exists short jsonb;
