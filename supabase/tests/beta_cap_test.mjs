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
  grant usage on schema public to anon, authenticated;`);
await admin.query(migration);
await admin.query(migration); // safe to run twice
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

await admin.query('delete from auth.users');
await Promise.all([admin, a, b].map((client) => client.end()));
