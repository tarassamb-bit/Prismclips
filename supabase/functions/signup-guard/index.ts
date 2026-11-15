// Supabase Auth "Before User Created" hook: refuses a sign-up unless it carries a valid Cloudflare Turnstile token, so bots
// can't create accounts. Sign-in is not affected (Supabase's own Bot protection stays off so the desktop apps keep signing in).
// The sign-up forms put the token in the user metadata as `turnstile`; a database trigger removes it before the account is
// saved (migration 202611040002).
//
// Secrets (Project Settings → Edge Functions → Secrets):
//   TURNSTILE_SECRET            the Turnstile widget's secret key (Cloudflare → Turnstile)
//   SIGNUP_HOOK_SECRET          the hook's signing secret, "v1,whsec_…" (Authentication → Hooks → Before User Created)
// Deploy without JWT checks (Supabase Auth signs the request instead): supabase functions deploy signup-guard --no-verify-jwt
// Fails closed: with a secret missing, every sign-up is refused.

const SITEVERIFY = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
const TOLERANCE_SECONDS = 5 * 60;

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
// A refused sign-up is answered with HTTP 200 and an `error` object: Supabase Auth shows its message to the person signing up.
// Any other status makes Auth report a generic failure ("Invalid payload sent to hook") instead.
const refuse = (message: string, status = 400) => json({ error: { http_code: status, message } });
const unauthorized = () => json({ error: { http_code: 401, message: "Unauthorized." } }, 401);
const base64 = (bytes: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(bytes)));

/** Standard Webhooks: HMAC-SHA256 of "id.timestamp.body" with the base64 secret after "v1,whsec_", recent timestamp. */
export async function signedBySupabase(body: string, headers: Headers, secret: string, now = Date.now()): Promise<boolean> {
  const id = headers.get("webhook-id"), timestamp = headers.get("webhook-timestamp"), signatures = headers.get("webhook-signature");
  if (!id || !timestamp || !signatures || !secret) return false;
  if (!/^\d+$/.test(timestamp) || Math.abs(now / 1000 - Number(timestamp)) > TOLERANCE_SECONDS) return false;
  let raw: Uint8Array;
  try { raw = Uint8Array.from(atob(secret.replace(/^v1,/, "").replace(/^whsec_/, "")), (c) => c.charCodeAt(0)); } catch { return false; }
  const key = await crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const expected = base64(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${id}.${timestamp}.${body}`)));
  return signatures.split(" ").some((entry) => {
    const [version, signature] = entry.split(",");
    if (version !== "v1" || !signature || signature.length !== expected.length) return false;
    let difference = 0;
    for (let i = 0; i < expected.length; i++) difference |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
    return difference === 0;
  });
}

export async function handle(req: Request, env: (name: string) => string | undefined = (n) => Deno.env.get(n)): Promise<Response> {
  if (req.method !== "POST") return json({ error: { http_code: 405, message: "Method not allowed." } }, 405);
  const body = await req.text();
  if (!(await signedBySupabase(body, req.headers, env("SIGNUP_HOOK_SECRET") ?? ""))) return unauthorized();
  let payload: { user?: { user_metadata?: Record<string, unknown>; app_metadata?: { provider?: string } }; metadata?: { ip_address?: string } };
  try { payload = JSON.parse(body); } catch { return refuse("Bad request."); }
  // Sign-up with Google can't carry the check, and Google has already checked the person; only email sign-ups need it.
  const provider = payload.user?.app_metadata?.provider;
  if (provider && provider !== "email") return json({});
  const token = payload.user?.user_metadata?.turnstile;
  const secret = env("TURNSTILE_SECRET");
  if (typeof token !== "string" || token.length === 0 || token.length > 2048) {
    return refuse("Please complete the “I’m human” check, then try again.");
  }
  if (!secret) {
    console.error("TURNSTILE_SECRET is not set; refusing sign-ups.");
    return refuse("Sign-up is unavailable right now. Please try again later.", 503);
  }
  const form = new URLSearchParams({ secret, response: token });
  if (payload.metadata?.ip_address) form.set("remoteip", payload.metadata.ip_address);
  try {
    const answer = await fetch(SITEVERIFY, { method: "POST", body: form, signal: AbortSignal.timeout(8000) });
    const result = await answer.json() as { success?: boolean; "error-codes"?: string[] };
    if (result.success === true) return json({});
    console.warn("Turnstile refused a sign-up:", result["error-codes"]?.join(", "));
    // A wrong or missing secret is a setup problem, not the person's: don't ask them to retry the check.
    if (result["error-codes"]?.some((code) => code.endsWith("-secret"))) {
      return refuse("Sign-up is unavailable right now. Please try again later.", 503);
    }
  } catch (error) {
    console.error("Turnstile could not be reached:", error);
    return refuse("Sign-up is unavailable right now. Please try again in a moment.", 503);
  }
  return refuse("The “I’m human” check expired or failed. Please try it again.");
}

Deno.serve((req) => handle(req));
