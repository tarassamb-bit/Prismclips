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
    if (upstream.ok && answer?.choices?.length) { reply = answer; break; }
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
  // Visible in Supabase → Edge Functions → Logs, so a model that answers in an unexpected shape can be diagnosed.
  console.log(`answer from ${reply.model ?? "model"} (first 300 characters): ${text.slice(0, 300)}`);
  const finished = choice?.finish_reason === "length" ? "MAX_TOKENS" : "STOP";
  return new Response(
    JSON.stringify({ candidates: [{ content: { parts: [{ text }] }, finishReason: finished }] }),
    { headers: { "Content-Type": "application/json" } },
  );
});
