# Supabase email confirmation

Production website: https://prismclips.vercel.app

In [Supabase Authentication → URL Configuration](https://supabase.com/dashboard/project/isdplhahgggundbohmlr/auth/url-configuration), keep these settings:

- **Site URL:** `https://prismclips.vercel.app/login`. Existing desktop builds omit a redirect URL, so their new confirmation emails use this default.
- **Redirect URLs:** `https://prismclips.vercel.app/login`, `https://prismclips.vercel.app/signup`, `https://prismclips.vercel.app/login.html`, and `https://prismclips.vercel.app/signup.html`. The signup paths also support the currently deployed website's return URL.

The website sends users to `/login` on its current origin after confirmation. The desktop apps explicitly request `https://prismclips.vercel.app/login`. That page consumes the Supabase session and opens the user's dashboard. Desktop users must then sign in inside Prism with the same credentials.

For local website testing, add `http://localhost:4173/login` to Redirect URLs; keep the production Site URL. Supabase falls back to the Site URL when a requested redirect is not allowed.

Keep the confirmation email's link set to `{{ .ConfirmationURL }}` so Supabase verifies the email before redirecting. After changing URL settings, request a fresh confirmation email: an already-sent link can still contain the old localhost destination.

Verify with `node UI/account-check.js` and `dotnet test Shared/Prism.Core.Tests --filter FullyQualifiedName~AccountTests`. A full delivery check also requires a fresh signup and opening its confirmation email.
