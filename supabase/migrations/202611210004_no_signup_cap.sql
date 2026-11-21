-- Launch: no sign-up cap. Drops the beta cap trigger and its counters (the web app no longer asks for them).
drop trigger if exists prism_beta_cap on auth.users;
drop function if exists public.prism_enforce_beta_cap();
drop function if exists public.beta_spots_left();
drop function if exists public.prism_beta_user_cap();
