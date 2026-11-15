-- What kind of request each paid answer was (audio, image, text) and how long it took, so success rate and time per
-- provider can be measured. Nullable: older rows have neither.
alter table public.ai_spend add column if not exists kind text, add column if not exists ms integer;
