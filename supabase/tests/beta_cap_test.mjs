// Checks migrations/202611040001_beta_cap_waitlist_analytics.sql on a throwaway Postgres (never the live project):
//   DATABASE_URL=postgres://postgres:...@localhost:5432/postgres node supabase/tests/beta_cap_test.mjs
// It creates a stand-in auth.users and the anon/authenticated roles when they're missing, as on a plain Postgres.
// Needs the `pg` package. The database must be disposable: the test adds and removes accounts.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import pg from 'pg';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('Set DATABASE_URL to a disposable Postgres.');
const migration = fs.readFileSync(new URL('../migrations/202611040001_beta_cap_waitlist_analytics.sql', import.meta.url), 'utf8');
const connect = async () => { const client = new pg.Client({ connectionString: url }); await client.connect(); return client; };
const admin = await connect();

await admin.query(`
  do $$ begin
    if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
    if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  end $$;
  create schema if not exists auth;
  create table if not exists auth.users (id uuid primary key default gen_random_uuid(), email text);
  create or replace function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
  grant usage on schema auth to anon, authenticated;
  grant usage on schema public to anon, authenticated;`);
const stripToken = fs.readFileSync(new URL('../migrations/202611040002_strip_signup_token.sql', import.meta.url), 'utf8');
await admin.query('alter table auth.users add column if not exists raw_user_meta_data jsonb');
const profiles = fs.readFileSync(new URL('../migrations/202611040003_profiles.sql', import.meta.url), 'utf8');
for (const sql of [migration, migration, stripToken, stripToken, profiles, profiles]) await admin.query(sql); // each safe to run twice
await admin.query('delete from auth.users');
await admin.query('truncate public.beta_waitlist, public.beta_waitlist_attempts, public.analytics_events');

const cap = (await admin.query('select public.prism_beta_user_cap() as cap')).rows[0].cap;
assert.equal(cap, 100);
const signUp = (client, n) => client.query('insert into auth.users (email) values ($1)', [`tester${n}@example.com`]);
const asRole = async (client, role, sql, params) => {
  await client.query('begin');
  try { await client.query(`set local role ${role}`); return await client.query(sql, params); } finally { await client.query('rollback'); }
};
const spotsLeft = async () => (await asRole(admin, 'anon', 'select public.beta_spots_left() as n')).rows[0].n;

// 99 accounts: one spot left, and anyone can see that.
for (let n = 1; n <= 99; n++) await signUp(admin, n);
assert.equal(await spotsLeft(), 1);

// Two sign-ups at the same moment for the last spot: exactly one gets in, the other is refused with BETA_FULL.
const [a, b] = [await connect(), await connect()];
await a.query('begin'); await b.query('begin');
await signUp(a, 100);                                       // holds the sign-up lock until it commits
const second = signUp(b, 101).then(() => 'in', (error) => error.message);
await new Promise((resolve) => setTimeout(resolve, 300));   // b is now waiting for the lock
await a.query('commit');
assert.equal(await second, 'BETA_FULL', 'the second simultaneous sign-up must not also get the 100th spot');
await b.query('rollback');
assert.equal((await admin.query('select count(*)::int as n from auth.users')).rows[0].n, 100);
assert.equal(await spotsLeft(), 0);

// The same race started truly in parallel, from 99 again.
await admin.query("delete from auth.users where email = 'tester100@example.com'");
const results = await Promise.all([a, b].map((client, i) => signUp(client, 200 + i).then(() => 'in', (error) => error.message)));
assert.deepEqual(results.sort(), ['BETA_FULL', 'in']);

// Account #101 is refused; the error carries the code the web app looks for.
await assert.rejects(signUp(admin, 101), /BETA_FULL/);
assert.equal((await admin.query('select count(*)::int as n from auth.users')).rows[0].n, 100);
// Deleting an account frees its spot.
await admin.query("delete from auth.users where email = 'tester1@example.com'");
assert.equal(await spotsLeft(), 1);
await signUp(admin, 102);
// The Turnstile token sent with a sign-up is not kept; other metadata is.
await admin.query("delete from auth.users where email = 'tester2@example.com'");
await admin.query(`insert into auth.users (email, raw_user_meta_data) values ('tester2@example.com', '{"turnstile":"0.abc","plan":"beta"}')`);
assert.deepEqual((await admin.query("select raw_user_meta_data as m from auth.users where email = 'tester2@example.com'")).rows[0].m, { plan: 'beta' });
console.log('PASS beta cap: #100 gets in, #101 is refused with BETA_FULL, simultaneous sign-ups at 99 let only one in');

// Waitlist: anyone can join; no one but the server can read it; spam is rate-limited.
const join = (client, email, ip = '203.0.113.7') => (async () => {
  await client.query('begin');
  try {
    await client.query('set local role anon');
    await client.query(`select set_config('request.headers', $1, true)`, [JSON.stringify({ 'x-forwarded-for': ip })]);
    const result = await client.query('select public.join_beta_waitlist($1) as ok', [email]);
    await client.query('commit');
    return result.rows[0].ok;
  } catch (error) { await client.query('rollback'); throw error; }
})();
assert.equal(await join(a, '  Fan@Example.com '), true);
assert.equal(await join(a, 'fan@example.com'), true, 'joining twice gives the same answer');
await assert.rejects(join(a, 'not an email'), /INVALID_EMAIL/);
assert.deepEqual((await admin.query('select email from public.beta_waitlist')).rows, [{ email: 'fan@example.com' }]);
for (let i = 0; i < 3; i++) await join(a, `more${i}@example.com`); // five accepted attempts (a refused malformed one is rolled back and not counted)
await assert.rejects(join(a, 'sixth@example.com'), /RATE_LIMITED/, 'five attempts an hour from one address');
assert.equal(await join(a, 'other@example.com', '198.51.100.9'), true, 'another address is not affected');
await assert.rejects(asRole(a, 'anon', 'select * from public.beta_waitlist'), /permission denied/);
await assert.rejects(asRole(a, 'authenticated', 'select * from public.beta_waitlist_attempts'), /permission denied/);
await assert.rejects(asRole(a, 'anon', "insert into public.beta_waitlist (email) values ('direct@example.com')"), /permission denied/);
console.log('PASS waitlist: email only, server-only reads, duplicate-safe, rate-limited per address');

// Analytics: valid events can be added by anyone; nothing else gets in, and no one but the server can read them.
const addEvent = (role, name, data = {}) => asRole(a, role, 'insert into public.analytics_events (name, data) values ($1, $2)', [name, data]);
await a.query('set role anon');
await a.query('insert into public.analytics_events (name, data) values ($1, $2)', ['clips_generated', { clips: 6 }]);
await a.query('insert into public.analytics_events (name, data) values ($1, $2)', ['analysis_started', { length: '10–30 min' }]);
await a.query('set role authenticated');
await a.query('insert into public.analytics_events (name, data) values ($1, $2)', ['clip_exported', { quality: 'full' }]);
await a.query('reset role');
await assert.rejects(addEvent('anon', 'something_else'), /check constraint/);
await assert.rejects(addEvent('anon', 'clip_exported', { title: 'My private video' }), /check constraint/, 'no free text in event data');
await assert.rejects(addEvent('anon', 'analysis_started', { length: 'about an hour' }), /check constraint/);
await assert.rejects(addEvent('anon', 'clips_generated', { clips: 'six' }), /check constraint/);
await assert.rejects(asRole(a, 'anon', 'select * from public.analytics_events'), /permission denied/);
await assert.rejects(asRole(a, 'authenticated', 'select * from public.analytics_daily'), /permission denied/);
await assert.rejects(asRole(a, 'authenticated', 'delete from public.analytics_events'), /permission denied/);
const daily = (await admin.query('select name, events::int from public.analytics_daily order by name')).rows;
assert.deepEqual(daily, [{ name: 'analysis_started', events: 1 }, { name: 'clip_exported', events: 1 }, { name: 'clips_generated', events: 1 }]);
console.log('PASS analytics: the eight events with bucket data only, insert-only for users, daily counts for the server');

// Profiles: the sign-up's name and username become the profile; usernames are unique, checked live, and only yours to read.
await admin.query('delete from auth.users');
const signUpAs = (client, email, meta) => client.query('insert into auth.users (email, raw_user_meta_data) values ($1, $2) returning id', [email, meta]);
const available = async (name) => (await asRole(a, 'anon', 'select public.username_available($1) as ok', [name])).rows[0].ok;
assert.equal(await available('Marian_1'), true);
const marian = (await signUpAs(admin, 'm@example.com', { name: '  Marian  ', username: '@Marian_1', turnstile: 'x' })).rows[0].id;
assert.deepEqual((await admin.query('select display_name, username from public.profiles where user_id = $1', [marian])).rows[0], { display_name: 'Marian', username: 'marian_1' });
assert.equal(await available('marian_1'), false, 'taken, whatever the case');
assert.equal(await available('MARIAN_1'), false);
assert.equal(await available('no spaces allowed'), false);
assert.equal(await available('ab'), false, 'too short');
await assert.rejects(signUpAs(admin, 'copy@example.com', { username: 'marian_1' }), /USERNAME_TAKEN/);
assert.equal((await admin.query("select count(*)::int as n from auth.users where email = 'copy@example.com'")).rows[0].n, 0, 'no account without its username');
const google = (await signUpAs(admin, 'g@example.com', { full_name: 'Google Person' })).rows[0].id;
assert.deepEqual((await admin.query('select display_name, username from public.profiles where user_id = $1', [google])).rows[0], { display_name: 'Google Person', username: null });
// Simultaneous sign-ups with the same new username: one gets it, the other is refused.
const race = await Promise.all([a, b].map((client, i) => signUpAs(client, `race${i}@example.com`, { username: 'same_name' }).then(() => 'in', (e) => e.message)));
assert.equal(race.filter((r) => r === 'in').length, 1, String(race));
// A signed-in person reads and edits only their own profile.
const asUser = async (id, sql, params) => {
  await a.query('begin');
  try {
    await a.query(`select set_config('request.jwt.claim.sub', $1, true)`, [id]);
    await a.query('set local role authenticated');
    const result = await a.query(sql, params); await a.query('commit'); return result;
  } catch (error) { await a.query('rollback'); throw error; }
};
assert.equal((await asUser(google, 'select user_id from public.profiles')).rows.length, 1, 'only their own row');
await asUser(google, 'update public.profiles set username = $1 where user_id = $2', ['google_person', google]);
assert.equal((await asUser(google, 'update public.profiles set username = $1 where user_id = $2', ['hacked', marian])).rowCount, 0, "can't edit someone else's");
await assert.rejects(asUser(google, 'update public.profiles set username = $1 where user_id = $2', ['marian_1', google]), /duplicate key/);
await assert.rejects(asUser(google, 'update public.profiles set username = $1 where user_id = $2', ['Bad Name', google]), /check constraint/);
await assert.rejects(asUser(google, 'update public.profiles set user_id = $1 where user_id = $1', [google]), /permission denied/);
assert.equal(await available('google_person'), false);
console.log('PASS profiles: name and unique username from sign-up, live availability, own profile only');

const failures = fs.readFileSync(new URL('../migrations/202611050001_ai_failures.sql', import.meta.url), 'utf8');
for (const sql of [failures, failures]) await admin.query(sql);
await admin.query("insert into public.ai_failures (user_id, source, model, kind, attempt, error_type, ms) values ($1, 'web', 'xiaomi/mimo-v2.6-flash', 'audio', 1, 'timeout', 80000)", [google]);
assert.equal((await admin.query('select failures from public.ai_failures_daily')).rows[0].failures, '1');
await assert.rejects(asUser(google, 'select * from public.ai_failures'), /permission denied/);
await assert.rejects(asRole(a, 'anon', 'select * from public.ai_failures_daily'), /permission denied/);
await assert.rejects(asRole(a, 'authenticated', "insert into public.ai_failures (source, model, error_type) values ('web', 'x', 'timeout')"), /permission denied/);
console.log('PASS ai_failures: the servers log, nobody else reads or writes');

const costs = fs.readFileSync(new URL('../migrations/202611050002_ai_cost_daily.sql', import.meta.url), 'utf8');
await admin.query(`create table if not exists public.usage_videos (user_id uuid, video text, day date, minutes double precision);
  create table if not exists public.usage_runs (user_id uuid, video text, run uuid, charged_minutes double precision default 0, created timestamptz default now());`);
for (const sql of [costs, costs]) await admin.query(sql);
await admin.query("insert into public.usage_videos values ($1, 'v', current_date, 20)", [google]);
await admin.query("insert into public.usage_runs (user_id, video, run) values ($1, 'v', gen_random_uuid()), ($1, 'v', gen_random_uuid())", [google]);
await admin.query("insert into public.ai_spend (user_id, source, usd) values ($1, 'web', 0.03), ($1, 'web', 0.05)", [google]);
const today = (await admin.query('select runs, minutes_processed, answers, openrouter_usd, usd_per_minute from public.ai_cost_daily')).rows[0];
assert.deepEqual(today, { runs: '2', minutes_processed: '40.0', answers: '2', openrouter_usd: '0.0800', usd_per_minute: '0.00200' });
await assert.rejects(asUser(google, 'select * from public.ai_spend'), /permission denied/);
await assert.rejects(asRole(a, 'authenticated', 'select * from public.ai_cost_daily'), /permission denied/);
console.log('PASS ai_cost_daily: minutes per run, real OpenRouter cost per day, closed to users');

await admin.query('delete from auth.users');
await Promise.all([admin, a, b].map((client) => client.end()));
