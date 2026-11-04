-- The sign-up forms send their Cloudflare Turnstile token in the user metadata, where the signup-guard hook checks it.
-- It is single-use and worthless afterwards, so it is removed before the account is saved. Safe to run more than once.
begin;

create or replace function public.prism_strip_signup_token()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  new.raw_user_meta_data := coalesce(new.raw_user_meta_data, '{}'::jsonb) - 'turnstile';
  return new;
end;
$$;
revoke all on function public.prism_strip_signup_token() from public, anon, authenticated;

drop trigger if exists prism_strip_signup_token on auth.users;
create trigger prism_strip_signup_token before insert or update of raw_user_meta_data on auth.users
  for each row execute function public.prism_strip_signup_token();

commit;
