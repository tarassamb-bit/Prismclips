-- Lets a signed-in person delete their own account from the web app (Settings > Account > Delete account).
-- Every table that belongs to a user references auth.users with "on delete cascade", so deleting the user removes their
-- projects, folders, exports, usage and promo codes too. The app removes the account's videos from Cloudflare R2 first.
-- Safe to run more than once. Apply it in the Supabase SQL editor.
begin;

create or replace function public.delete_my_account() returns void
language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null then
    raise exception 'Not signed in' using errcode = '42501';
  end if;
  delete from auth.users where id = auth.uid();
end;
$$;

revoke all on function public.delete_my_account() from public, anon;
grant execute on function public.delete_my_account() to authenticated;

commit;
