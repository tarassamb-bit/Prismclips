-- Free is 20 minutes a month (plan_limits), not the old 60-minute lifetime beta allowance; a usage_allowance grant still overrides it.
-- Paid plans export 4K, matching the pricing page.
create or replace function public.prism_allowance(p_user uuid)
returns double precision language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce((select l.upload_minutes from public.plan_limits l where l.tier = public.prism_plan(p_user)),
                  (select minutes from public.usage_allowance where user_id = p_user),
                  (select upload_minutes from public.plan_limits where tier = 'free'))
       + coalesce((select sum(minutes) from public.minute_packs where user_id = p_user and bought >= date_trunc('month', now())), 0);
$$;

-- shortcut: the month is the calendar month, not the Paddle billing period; switch to the subscription's period when billing goes live.
create or replace function public.prism_used_minutes(p_user uuid)
returns double precision language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce((select sum(m) from (select max(minutes) as m from public.usage_videos
           where user_id = p_user and day >= date_trunc('month', now())::date group by video) videos), 0)
       + coalesce((select sum(charged_minutes) from public.usage_runs where user_id = p_user and created >= date_trunc('month', now())), 0);
$$;

update public.plan_limits set export = '4K' where tier in ('tier1', 'creator', 'studio');

-- Only signed-in people read their usage; anon got the default allowance back.
revoke execute on function public.my_usage() from public, anon;
grant execute on function public.my_usage() to authenticated;
