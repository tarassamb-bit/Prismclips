-- Only run after the secure gateway is live, verified, and old requests have drained.
-- Running this before gateway cutover interrupts AI requests.
begin;
drop policy if exists "Add own usage" on public.usage_videos;
revoke insert, update, delete, truncate, references, trigger on public.usage_videos from anon, authenticated;
revoke insert, update, delete, truncate, references, trigger on public.usage_allowance from anon, authenticated;
revoke insert, update, delete, truncate, references, trigger on public.usage_spend from anon, authenticated;
revoke insert, update, delete, truncate, references, trigger on public.subscriptions from anon, authenticated;
do $$
begin
  if to_regprocedure('public.add_spend(double precision)') is not null then
    revoke all on function public.add_spend(double precision) from public, anon, authenticated;
  end if;
end;
$$;
commit;
