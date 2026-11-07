// Relio's AI server. The app sends Gemini-format requests here, signed in with its Supabase session; this function
// forwards them to OpenRouter with the OPENROUTER_API_KEY secret and answers in the same Gemini format.
// The key lives only in Supabase's secrets, never in the app. Set it with Project Settings → Edge Functions → Secrets.
// OPENROUTER_MODEL (default Mimo) is tried first, then one paid fallback (OPENROUTER_FALLBACK_MODEL) that takes audio,
// images and text. Every failed attempt is logged in the ai_failures table. The web app uses UI/api/gemini.js instead.

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
// No free models: they are rate-limited exactly when they are needed.
const DEFAULT_MODEL = "xiaomi/mimo-v2.6-flash";
const DEFAULT_FALLBACK = "google/gemini-3.8-flash";
// Only providers that keep no data (zero data retention) and don't train on it; among those, the quickest to answer.
const PROVIDER = { zdr: true, data_collection: "deny", sort: "latency" };

type Part = { text?: string; inlineData?: { mimeType: string; data: string } };
type GeminiRequest = {
  contents: { role: string; parts: Part[] }[];
  generationConfig?: { temperature?: number; responseSchema?: unknown };
};

/// Gemini schemas use upper-case type names ("OBJECT"); JSON Schema uses lower-case ones.
function lowerTypes(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(lowerTypes);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) =>
        [key, key === "type" && typeof item === "string" ? item.toLowerCase() : lowerTypes(item)]),
    );
  }
  return value;
}

/// OpenRouter wants the audio's format by name: the web app sends WAV, the desktop apps send AAC in an MP4 (m4a).
function audioFormat(mimeType: string): string {
  if (/wav/i.test(mimeType)) return "wav";
  if (/mpeg|mp3/i.test(mimeType)) return "mp3";
  return "m4a";
}

function toOpenRouter(body: GeminiRequest) {
  const content: unknown[] = [];
  let hasAudio = false, hasImage = false;
  for (const part of body.contents.flatMap((turn) => turn.parts)) {
    if (part.text !== undefined) {
      content.push({ type: "text", text: part.text });
    } else if (part.inlineData) {
      const { mimeType, data } = part.inlineData;
      if (mimeType.startsWith("image/")) {
        content.push({ type: "image_url", image_url: { url: `data:${mimeType};base64,${data}` } });
        hasImage = true;
      } else if (mimeType.startsWith("audio/")) {
        content.push({ type: "input_audio", input_audio: { data, format: audioFormat(mimeType) } });
        hasAudio = true;
      } else {
        throw new Error(`Unsupported attachment type ${mimeType}`);
      }
    }
  }
  const messages: unknown[] = [];
  const schema = body.generationConfig?.responseSchema;
  if (schema) {
    messages.push({
      role: "system",
      content: `Reply with only one JSON object, no other text and no code fences, that matches this JSON Schema: ${JSON.stringify(lowerTypes(schema))}`,
    });
  }
  messages.push({ role: "user", content });
  // No response_format: most free models don't support JSON mode, and asking for it hides them. The prompt asks instead.

  // Reasoning models (Mimo) think for minutes on a whole transcript by default, past Supabase's 150 s limit per
  // function; low effort answers in seconds. Models without reasoning ignore it.
  const request = { messages, temperature: body.generationConfig?.temperature ?? 0.2, reasoning: { effort: "low", exclude: true }, provider: PROVIDER };
  return { kind: hasAudio ? "audio" : hasImage ? "image" : "text", wantsJSON: Boolean(schema), request };
}

/// Models without JSON mode sometimes wrap the object in prose or ``` fences; keep only the object.
function cleanJSON(text: string): string {
  const start = text.indexOf("{"), end = text.lastIndexOf("}");
  return start >= 0 && end > start ? text.slice(start, end + 1) : text;
}

// The website's app calls this function from the browser, which asks permission first (a preflight OPTIONS request) and only
// lets the page read answers that carry these headers. Sign-in is a bearer token, never a cookie, so any origin may ask.
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info, x-prism-video, x-prism-minutes, x-prism-day, x-prism-run",
  "Access-Control-Max-Age": "86400",
};
const JSON_HEADERS = { "Content-Type": "application/json", ...CORS };

function fail(status: number, message: string): Response {
  return new Response(JSON.stringify({ error: { message } }), {
    status,
    headers: JSON_HEADERS,
  });
}

const LIMIT_MESSAGE = "You've reached your beta usage limit. Ask for a promo code to get more, then enter it in Settings › Usage.";

/// Verify the caller, then reserve usage through a service-only database function.
type Session = { url: string; headers: Record<string, string>; user: string };
async function checkVideoLimit(request: Request): Promise<{ refused: Response | null; session: Session | null }> {
  const stop = (response: Response) => ({ refused: response, session: null });
  const video = request.headers.get("x-prism-video") ?? "";
  const minutes = Number(request.headers.get("x-prism-minutes"));
  if (!/^[0-9a-f]{64}$/.test(video) || !Number.isFinite(minutes) || !(minutes > 0 && minutes <= 600)) {
    return stop(fail(400, "Relio AI needs the video it is working on. Make Shorts from a video in the app."));
  }
  // Each analysis run sends one id with all its requests, so the server counts re-analyses per video.
  // Other requests (framing at export, chat, descriptions) send none and are not runs.
  const run = request.headers.get("x-prism-run");
  if (run !== null && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(run)) {
    return stop(fail(400, "Relio AI got an invalid analysis run. Update Relio and try again."));
  }
  const url = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const auth = request.headers.get("Authorization") ?? "";
  const apikey = request.headers.get("apikey") ?? "";
  if (!url || !serviceKey) return stop(fail(503, "Relio AI is not configured for secure usage tracking."));
  if (!auth.startsWith("Bearer ") || !apikey) return stop(fail(401, "Sign in to your Relio account to continue."));
  const identity = await fetch(`${url}/auth/v1/user`, { headers: { "Authorization": auth, "apikey": apikey } });
  if (identity.status === 401 || identity.status === 403) return stop(fail(401, "Sign in to your Relio account to continue."));
  if (!identity.ok) return stop(fail(503, "Relio could not verify your sign-in right now."));
  const user = await identity.json().catch(() => null);
  if (typeof user?.id !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(user.id)) {
    return stop(fail(401, "Sign in to your Relio account to continue."));
  }
  const headers = { "Authorization": `Bearer ${serviceKey}`, "apikey": serviceKey, "Content-Type": "application/json" };
  const session: Session = { url, headers, user: user.id };
  const record = await fetch(`${url}/rest/v1/rpc/prism_reserve_beta_usage`, {
    method: "POST",
    headers,
    body: JSON.stringify({ p_user: user.id, p_video: video, p_minutes: minutes }),
  });
  if (!record.ok) return stop(fail(503, "Relio could not check your allowance right now. Try again shortly."));
  if ((await record.json()) !== true) return stop(limitReached());
  if (run !== null) {
    // The first run is covered by the reservation above; the database charges each re-analysis a share of the minutes.
    const begun = await fetch(`${url}/rest/v1/rpc/prism_begin_analysis_run`, {
      method: "POST",
      headers,
      body: JSON.stringify({ p_user: user.id, p_video: video, p_run: run, p_minutes: minutes }),
    });
    if (!begun.ok) return stop(fail(503, "Relio could not check your allowance right now. Try again shortly."));
    if ((await begun.json()) !== true) return stop(limitReached());
  }
  return { refused: null, session };
}

// A model reporting a cost of 0 would be free to use without limit. Every answer counts at least this much, so the spend
// cap bounds use: the default cap of 60 minutes × $0.05 allows about 1,500 answers.
const MIN_ANSWER_USD = 0.002;
// Mimo gets this long; the fallback gets what is left of the budget.
const MODEL_TIMEOUT_MS = 75_000;
// All models together must answer before Supabase stops the function at 150 s (the sign-in and usage checks come first).
const REQUEST_BUDGET_MS = 135_000;
// A fallback model gets tried only with at least this much of the budget left.
const MIN_MODEL_TIME_MS = 20_000;

/** OpenRouter keeps a slow request alive by sending ": OPENROUTER PROCESSING" lines before the JSON answer. */
export function parseOpenRouter(body: string): any {
  return JSON.parse(body.split("\n").filter((line) => !line.startsWith(":")).join("\n"));
}

/// One row per failed model attempt, so the owner can see how often each model and provider fails. Never blocks the answer.
async function logFailure(session: Session, row: Record<string, unknown>) {
  console.error(`${row.model}: ${row.error_type} ${row.message ?? ""}`);
  const response = await fetch(`${session.url}/rest/v1/ai_failures`, {
    method: "POST",
    headers: { ...session.headers, Prefer: "return=minimal" },
    body: JSON.stringify({ ...row, user_id: session.user, source: "desktop" }),
    signal: AbortSignal.timeout(5_000),
  }).catch((error) => new Response(String(error), { status: 0 }));
  if (!response.ok) console.error(`ai_failures row not saved (${response.status}):`, row.model, row.error_type);
}

function errorType(status: number): string {
  if (status === 429) return "rate_limit";
  if (status === 404) return "no_provider";
  if (status === 401 || status === 402 || status === 403) return "account";
  if (status === 400 || status === 413) return "bad_request";
  return "provider_error";
}

/// Adds what one model answer cost to the account. OpenRouter reports the cost in each response.
async function recordSpend(session: Session, answer: any) {
  const reported = Number(answer?.usage?.cost ?? 0);
  const usd = Math.max(Number.isFinite(reported) ? reported : 0, MIN_ANSWER_USD);
  const response = await fetch(`${session.url}/rest/v1/rpc/prism_record_beta_spend`, {
    method: "POST",
    headers: session.headers,
    body: JSON.stringify({ p_user: session.user, p_usd: usd }),
  });
  if (!response.ok) throw new Error("Usage accounting failed");
  // The real cost for the ai_cost_daily view; a failed write must not fail an answer that was already paid for.
  const spendRow = await fetch(`${session.url}/rest/v1/ai_spend`, {
    method: "POST",
    headers: { ...session.headers, Prefer: "return=minimal" },
    signal: AbortSignal.timeout(5_000),
    body: JSON.stringify({
      user_id: session.user, source: "desktop", model: answer?.model ?? null, provider: answer?.provider ?? null,
      usd: Number.isFinite(reported) && reported > 0 ? reported : 0, prompt_tokens: answer?.usage?.prompt_tokens ?? null,
      completion_tokens: answer?.usage?.completion_tokens ?? null,
    }),
  }).catch((error) => new Response(String(error), { status: 0 }));
  if (!spendRow.ok) console.error(`ai_spend row not saved (${spendRow.status}):`, answer?.model, answer?.provider);
}

function limitReached(): Response {
  return new Response(JSON.stringify({ error: { code: "usage_limit", message: LIMIT_MESSAGE } }), {
    status: 429,
    headers: JSON_HEADERS,
  });
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (request.method !== "POST") return fail(405, "Use POST.");
  const key = Deno.env.get("OPENROUTER_API_KEY");
  if (!key) return fail(500, "The AI key is not set on the server.");

  let body: GeminiRequest;
  try {
    body = await request.json();
  } catch {
    return fail(400, "The request is not valid JSON.");
  }
  let converted: ReturnType<typeof toOpenRouter>;
  try {
    converted = toOpenRouter(body);
  } catch (error) {
    return fail(400, (error as Error).message);
  }

  const { refused, session } = await checkVideoLimit(request);
  if (refused || !session) return refused ?? fail(401, "Sign in to your Relio account to continue.");

  const models = [Deno.env.get("OPENROUTER_MODEL") || DEFAULT_MODEL, Deno.env.get("OPENROUTER_FALLBACK_MODEL") || DEFAULT_FALLBACK];
  let status = 503, reply: any = null;
  const failures: string[] = [];
  const started = Date.now();
  for (const [attempt, model] of models.entries()) {
    // Supabase stops the function at 150 s: a model started with too little time left could only be cut off.
    const left = REQUEST_BUDGET_MS - (Date.now() - started);
    if (left < MIN_MODEL_TIME_MS) {
      status = 504;
      failures.push(`no time left to try ${model}`);
      break;
    }
    // The last model gets all the time that is left.
    const limit = attempt === models.length - 1 ? left : Math.min(MODEL_TIMEOUT_MS, left);
    const tried = Date.now();
    const failure = (error_type: string, extra: Record<string, unknown> = {}) =>
      logFailure(session, { model, kind: converted.kind, attempt: attempt + 1, error_type, ms: Date.now() - tried, ...extra });
    // Every attempt, served or not, is logged with its model, time and provider when OpenRouter named one (never on a timeout).
    const attemptLog = (outcome: string, provider: string | null = null) =>
      console.log(JSON.stringify({ at: new Date().toISOString(), kind: converted.kind, model, attempt: attempt + 1, outcome, ms: Date.now() - tried, provider, limit_ms: limit }));
    let upstream: Response, answer: any;
    try {
      const signal = AbortSignal.timeout(limit);
      upstream = await fetch(OPENROUTER_URL, {
        method: "POST",
        headers: { "Authorization": `Bearer ${key}`, "Content-Type": "application/json", "HTTP-Referer": "https://relioclips.com", "X-Title": "Relio Clips" },
        body: JSON.stringify({ model, ...converted.request }),
        // Answer before Supabase stops the function at 150 s, so the app gets a clear "busy" and retries.
        signal,
      });
      // The timeout covers reading the body too: OpenRouter sends headers at once and the answer only when it's done.
      answer = await upstream.text().then(parseOpenRouter).catch((error) => { if (signal.aborted) throw error; return {}; });
    } catch {
      status = 504;
      failures.push(`${model}: no answer within ${Math.round(limit / 1000)} s`);
      attemptLog("timeout");
      await failure("timeout");
      continue;
    }
    // Only answers count toward the cap, so a model that refuses or is down doesn't use up the person's allowance.
    if (upstream.ok && answer?.choices?.length) {
      attemptLog("served", answer.provider ?? null);
      try { await recordSpend(session, answer); } catch { return fail(503, "Relio could not record usage. Please try again later."); }
      reply = answer; break;
    }
    // A 200 without a choice is an empty answer; treat it like a provider error so the next model gets a turn.
    status = upstream.ok ? 502 : upstream.status;
    // The provider's own explanation is in error.metadata.raw; without it every refusal reads "Provider returned error".
    const raw = typeof answer?.error?.metadata?.raw === "string" ? ` (${answer.error.metadata.raw.slice(0, 200)})` : "";
    const message = `${model}: ${answer?.error?.message ?? `HTTP ${upstream.status}`}${raw}`;
    failures.push(message);
    attemptLog(upstream.ok ? "empty_answer" : errorType(upstream.status), answer?.error?.metadata?.provider_name ?? null);
    await failure(upstream.ok ? "empty_answer" : errorType(upstream.status), {
      status: upstream.status, provider: answer?.error?.metadata?.provider_name ?? null, message: message.slice(0, 500),
    });
    // A bad key fails every model alike; anything else may work on the next one.
    if (status === 401) break;
  }
  // Pass the last status through so the app's retry and "model busy" handling still works.
  // Every model that was tried is named, so the first choice's refusal isn't hidden behind the last fallback's.
  if (!reply) {
    await logFailure(session, { model: "all", kind: converted.kind, attempt: models.length, error_type: "gave_up", status, ms: Date.now() - started });
    return fail(status, failures.join(" · ") || "No model answered.");
  }

  const choice = reply.choices[0];
  const raw: string = choice?.message?.content ?? "";
  const text = converted.wantsJSON ? cleanJSON(raw) : raw;
  const finished = choice?.finish_reason === "length" ? "MAX_TOKENS" : "STOP";
  return new Response(
    JSON.stringify({ candidates: [{ content: { parts: [{ text }] }, finishReason: finished }] }),
    { headers: JSON_HEADERS },
  );
});
