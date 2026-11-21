-- Deleting an account needs a code from the account's email entered in the last 15 minutes (an "otp" sign-in in the
-- session's amr claim), so a stolen session or an open laptop can't delete it. The app asks for the code first.
create or replace function public.delete_my_account() returns void
language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null then
    raise exception 'Not signed in' using errcode = '42501';
  end if;
  if not exists (
    select 1 from jsonb_array_elements(coalesce(auth.jwt() -> 'amr', '[]'::jsonb)) as a
    where a ->> 'method' in ('otp', 'magiclink') and (a ->> 'timestamp')::bigint > extract(epoch from now()) - 900
  ) then
    raise exception 'EMAIL_CODE_REQUIRED' using errcode = '42501', hint = 'Enter the code we emailed you, then try again.';
  end if;
  delete from auth.users where id = auth.uid();
end;
$$;
revoke all on function public.delete_my_account() from public, anon;
grant execute on function public.delete_my_account() to authenticated;
