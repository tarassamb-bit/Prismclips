// Prism's AI server. The app sends Gemini-format requests here, signed in with its Supabase session; this function
// forwards them to OpenRouter with the OPENROUTER_API_KEY secret and answers in the same Gemini format.
// The key lives only in Supabase's secrets, never in the app. Set it with Project Settings → Edge Functions → Secrets.
// Optional secret OPENROUTER_MODEL is tried first; the free models below follow, so one that is down or refuses
// hands the request to the next. Requests with audio only go to models that accept audio.

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
// Free models only: each request goes to models that accept its input. The thinkingmachines models are left out, because
// OpenRouter blocks them outside its own apps.
const AUDIO_MODELS = ["nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free"];
const IMAGE_MODELS = ["google/gemma-4-31b-it:free", "google/gemma-4-26b-a4b-it:free", "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free"];
const TEXT_MODELS = ["nvidia/nemotron-3-ultra-550b-a55b:free", "google/gemma-4-31b-it:free", "google/gemma-4-26b-a4b-it:free"];

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
        content.push({ type: "input_audio", input_audio: { data, format: "m4a" } });
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
  const models = hasAudio ? AUDIO_MODELS : hasImage ? IMAGE_MODELS : TEXT_MODELS;
  return { models, wantsJSON: Boolean(schema), request: { messages, temperature: body.generationConfig?.temperature ?? 0.2 } };
}

/// Models without JSON mode sometimes wrap the object in prose or ``` fences; keep only the object.
function cleanJSON(text: string): string {
  const start = text.indexOf("{"), end = text.lastIndexOf("}");
  return start >= 0 && end > start ? text.slice(start, end + 1) : text;
}

function fail(status: number, message: string): Response {
  return new Response(JSON.stringify({ error: { message } }), {
    status,
    headers: { "Content-Type": "application/json" },
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
    return stop(fail(400, "Prism AI needs the video it is working on. Make Shorts from a video in the app."));
  }
  const url = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const auth = request.headers.get("Authorization") ?? "";
  const apikey = request.headers.get("apikey") ?? "";
  if (!url || !serviceKey) return stop(fail(503, "Prism AI is not configured for secure usage tracking."));
  if (!auth.startsWith("Bearer ") || !apikey) return stop(fail(401, "Sign in to your Prism account to continue."));
  const identity = await fetch(`${url}/auth/v1/user`, { headers: { "Authorization": auth, "apikey": apikey } });
  if (identity.status === 401 || identity.status === 403) return stop(fail(401, "Sign in to your Prism account to continue."));
  if (!identity.ok) return stop(fail(503, "Prism could not verify your sign-in right now."));
  const user = await identity.json().catch(() => null);
  if (typeof user?.id !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(user.id)) {
    return stop(fail(401, "Sign in to your Prism account to continue."));
  }
  const headers = { "Authorization": `Bearer ${serviceKey}`, "apikey": serviceKey, "Content-Type": "application/json" };
  const session: Session = { url, headers, user: user.id };
  const record = await fetch(`${url}/rest/v1/rpc/prism_reserve_beta_usage`, {
    method: "POST",
    headers,
    body: JSON.stringify({ p_user: user.id, p_video: video, p_minutes: minutes }),
  });
  if (!record.ok) return stop(fail(503, "Prism could not check your allowance right now. Try again shortly."));
  if ((await record.json()) !== true) return stop(limitReached());
  return { refused: null, session };
}

// Free models report a cost of 0, which would let an account use them without limit. Every answer counts at least this
// much, so the spend cap also bounds free use: the default cap of 60 minutes × $0.05 allows about 1,500 answers.
const MIN_ANSWER_USD = 0.002;

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
}

function limitReached(): Response {
  return new Response(JSON.stringify({ error: { code: "usage_limit", message: LIMIT_MESSAGE } }), {
    status: 429,
    headers: { "Content-Type": "application/json" },
  });
}

Deno.serve(async (request) => {
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
  if (refused || !session) return refused ?? fail(401, "Sign in to your Prism account to continue.");

  const chosen = Deno.env.get("OPENROUTER_MODEL");
  const models = [...new Set([...(chosen ? [chosen] : []), ...converted.models])];
  let status = 503, message = "No model answered.", reply: any = null;
  for (const model of models) {
    const upstream = await fetch(OPENROUTER_URL, {
      method: "POST",
      headers: { "Authorization": `Bearer ${key}`, "Content-Type": "application/json", "X-Title": "Prism" },
      body: JSON.stringify({ model, ...converted.request }),
    });
    const answer = await upstream.json().catch(() => ({}));
    // Only answers count toward the cap, so a model that refuses or is down doesn't use up the person's allowance.
    if (upstream.ok && answer?.choices?.length) {
      try { await recordSpend(session, answer); } catch { return fail(503, "Prism could not record usage. Please try again later."); }
      reply = answer; break;
    }
    status = upstream.status;
    message = `${model}: ${answer?.error?.message ?? `HTTP ${upstream.status}`}`;
    console.error(message);
    // A bad key fails every model alike; anything else may work on the next one.
    if (status === 401) break;
  }
  // Pass the last status through so the app's retry and "model busy" handling still works.
  if (!reply) return fail(status, message);

  const choice = reply.choices[0];
  const raw: string = choice?.message?.content ?? "";
  const text = converted.wantsJSON ? cleanJSON(raw) : raw;
  const finished = choice?.finish_reason === "length" ? "MAX_TOKENS" : "STOP";
  return new Response(
    JSON.stringify({ candidates: [{ content: { parts: [{ text }] }, finishReason: finished }] }),
    { headers: { "Content-Type": "application/json" } },
  );
});
