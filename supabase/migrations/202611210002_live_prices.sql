-- The live Paddle catalog of 2026-11-21: the same plans as the sandbox prices, which stay for testing.
insert into public.plan_prices (price_id, tier) values
  ('pri_01m7z8ybf53k8xtd0cghm6hrnb', 'tier1'),
  ('pri_01m7z8ybvx3b7d6k0nx0r2edb9', 'creator'),
  ('pri_01m7z8yc8ysxtmph5v5gv94y2c', 'studio')
on conflict (price_id) do update set tier = excluded.tier;
