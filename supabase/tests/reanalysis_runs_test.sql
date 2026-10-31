-- Checks 202610270002_reanalysis_runs.sql on a disposable database (local `supabase start` or a preview branch),
-- never on production. Run as the postgres role after schema.sql and both migrations:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/reanalysis_runs_test.sql
-- Everything runs in one transaction that is rolled back, so the test leaves no rows behind.
begin;

insert into auth.users (id, email) values
  ('00000000-0000-4000-8000-0000000000a1', 'reanalysis-none@example.test'),
  ('00000000-0000-4000-8000-0000000000a2', 'reanalysis-creator@example.test'),
  ('00000000-0000-4000-8000-0000000000a3', 'reanalysis-full@example.test');
insert into public.subscriptions (id, user_id, customer_id, price_id, status, event_at) values
  ('sub_test_creator', '00000000-0000-4000-8000-0000000000a2', 'ctm_test', 'pri_01m5h8qspmxxtzsnankzef16t2', 'active', now());

do $$
declare
  none_user    uuid := '00000000-0000-4000-8000-0000000000a1';
  creator_user uuid := '00000000-0000-4000-8000-0000000000a2';
  full_user    uuid := '00000000-0000-4000-8000-0000000000a3';
  v_video      text := repeat('a', 64);
  v_short      text := repeat('b', 64);
  v_long       text := repeat('c', 64);
  run1 uuid := '00000000-0000-4000-8000-000000000001';
  run2 uuid := '00000000-0000-4000-8000-000000000002';
  run3 uuid := '00000000-0000-4000-8000-000000000003';
begin
  -- First analysis: the reservation charges the full 10 minutes, the run itself adds nothing.
  assert public.prism_reserve_beta_usage(none_user, v_video, 10), 'first reservation';
  assert public.prism_begin_analysis_run(none_user, v_video, run1, 10), 'first run';
  assert public.prism_used_minutes(none_user) = 10, 'first analysis charges the full minutes';
  -- The same run's later requests pass without a second row or charge.
  assert public.prism_begin_analysis_run(none_user, v_video, run1, 10), 'repeat request of the same run';
  assert (select count(*) from public.usage_runs where user_id = none_user and video = v_video) = 1, 'one row per run';
  -- Re-analysis without a plan: half, rounded up.
  assert public.prism_reserve_beta_usage(none_user, v_video, 10), 'reservation for a known video';
  assert public.prism_begin_analysis_run(none_user, v_video, run2, 10), 'second run';
  assert public.prism_used_minutes(none_user) = 15, 'no plan: re-analysis charges half (5 of 10)';

  -- Creator: a third, rounded up (10 / 3 = 3.33, so 4).
  assert public.prism_reserve_beta_usage(creator_user, v_video, 10), 'creator reservation';
  assert public.prism_begin_analysis_run(creator_user, v_video, run1, 10), 'creator first run';
  assert public.prism_begin_analysis_run(creator_user, v_video, run2, 10), 'creator second run';
  assert public.prism_used_minutes(creator_user) = 14, 'creator: re-analysis charges a third, rounded up (4)';

  -- At least 1 minute: half of a 1-minute video rounds up to 1.
  assert public.prism_reserve_beta_usage(none_user, v_short, 1), 'short reservation';
  assert public.prism_begin_analysis_run(none_user, v_short, run1, 1), 'short first run';
  assert public.prism_begin_analysis_run(none_user, v_short, run2, 1), 'short second run';
  assert public.prism_used_minutes(none_user) = 17, 'a re-analysis charges at least 1 minute';

  -- Refused when the remaining allowance can't cover it: 50 used of 60, a re-analysis needs 25.
  assert public.prism_reserve_beta_usage(full_user, v_long, 50), 'long reservation';
  assert public.prism_begin_analysis_run(full_user, v_long, run1, 50), 'long first run';
  assert not public.prism_begin_analysis_run(full_user, v_long, run2, 50), 'a re-analysis the allowance cannot cover is refused';
  assert (select count(*) from public.usage_runs where user_id = full_user) = 1, 'a refused run leaves no row';
  assert public.prism_used_minutes(full_user) = 50, 'a refused run charges nothing';

  -- A trial-priced or cancelled subscription doesn't get the Creator rate.
  update public.subscriptions set status = 'canceled' where id = 'sub_test_creator';
  assert public.prism_reanalysis_charge(creator_user, 10) = 5, 'a cancelled Creator plan pays the half rate';
  update public.subscriptions set status = 'active' where id = 'sub_test_creator';
  assert public.prism_reanalysis_charge(creator_user, 10) = 4, 'an active Creator plan pays a third';

  -- Malformed input is refused.
  assert not public.prism_begin_analysis_run(none_user, 'not-a-hash', run3, 10), 'bad hash';
  assert not public.prism_begin_analysis_run(none_user, v_video, run3, 0), 'zero minutes';
  assert not public.prism_begin_analysis_run(null, v_video, run3, 10), 'no user';
end $$;

-- What the app reads, as the signed-in user: runs so far and the next re-analysis charge.
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-0000000000a1","role":"authenticated"}', true);
do $$
declare r record;
begin
  select * into r from public.my_reanalysis(repeat('a', 64));
  assert r.runs = 2 and r.charge = 5, format('my_reanalysis: runs %s, charge %s', r.runs, r.charge);
  select * into r from public.my_reanalysis(repeat('d', 64));
  assert r.runs = 0 and r.charge = 0, 'an unused video costs nothing extra before its first run';
  select * into r from public.my_usage();
  assert r.used = 17, format('my_usage includes charged re-analyses: %s', r.used);
  assert not exists (select 1 from public.usage_runs where user_id <> auth.uid()), 'users read only their own runs';
end $$;

-- Users can't record or charge runs themselves.
do $$
begin
  begin
    perform public.prism_begin_analysis_run(auth.uid(), repeat('a', 64), gen_random_uuid(), 10);
    raise exception 'authenticated users must not call prism_begin_analysis_run';
  exception when insufficient_privilege then null;
  end;
  begin
    insert into public.usage_runs (user_id, video, run) values (auth.uid(), repeat('e', 64), gen_random_uuid());
    raise exception 'authenticated users must not insert runs';
  exception when insufficient_privilege then null;
  end;
end $$;

reset role;
select 'PASS re-analysis: full first run, half or a third after, at least 1 minute, refusals, plan rates, privileges' as result;
rollback;
