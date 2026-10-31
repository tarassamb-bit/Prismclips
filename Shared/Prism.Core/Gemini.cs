using System.Net;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace Prism.Core;

/// <summary>The video a request is for. The server checks the account's allowance against it, so every request needs one.</summary>
/// <param name="Video">The video's server key: its content hash, or a hash of its name and length (<see cref="UsageLimit.ServerKey"/>).</param>
/// <param name="Day">The local calendar day, yyyy-MM-dd.</param>
public sealed record GeminiUsage(string Video, double Minutes, string Day)
{
    /// <summary>One id for all requests of an analysis run, so the server can count re-analyses; null outside a run.</summary>
    public string? Run { get; init; }
}

/// <summary>Requests go through Prism's server with the signed-in person's session; the server holds the AI key and picks the model.</summary>
public sealed class GeminiConfiguration(Func<Task<string?>> accessToken, GeminiUsage usage)
{
    /// <summary>The signed-in session's token, or null when signed out.</summary>
    public Func<Task<string?>> AccessToken { get; } = accessToken;
    public GeminiUsage Usage { get; set; } = usage;
    /// <summary>Tests send requests through a fake handler; the app uses the real network.</summary>
    public HttpMessageHandler? Handler { get; init; }
    /// <summary>Told when a request waits to retry, so a long pause shows as "retrying" instead of a frozen progress bar.</summary>
    public Action<string>? OnRetry { get; set; }
}

/// Prism AI requests (Gemini's generateContent shape) with structured JSON output and retries, as in the macOS app.
public static class Gemini
{
    /// <summary>Prism's server: it takes Gemini-format requests, forwards them to the AI model and answers in the same shape.</summary>
    public static readonly Uri GatewayUrl = new(Account.ProjectUrl, "functions/v1/gemini");

    /// <summary>Seconds to wait before each retry of a server error (500–504, or Supabase's 546 when a worker runs out of memory). An overloaded model often stays busy for tens of
    /// seconds, so the waits grow to about a minute in all. Tests shorten these.</summary>
    public static double[] RetryWaits { get; set; } = [2, 4, 8, 15, 30];

    static readonly HttpClient SharedClient = new() { Timeout = Timeout.InfiniteTimeSpan };
    static readonly JsonSerializerOptions ResponseOptions = new() { PropertyNameCaseInsensitive = true };

    public static JsonObject Text(string text) => new() { ["text"] = text };
    public static JsonObject Inline(string mimeType, byte[] data) => new() { ["inlineData"] = new JsonObject { ["mimeType"] = mimeType, ["data"] = Convert.ToBase64String(data) } };

    /// <summary>Sends one request and decodes Gemini's JSON answer into <typeparamref name="T"/>.</summary>
    public static async Task<T> Generate<T>(IEnumerable<JsonNode> parts, JsonNode schema, GeminiConfiguration configuration,
                                            CancellationToken cancellation = default)
    {
        var text = await GenerateText(parts, schema, configuration, cancellation);
        try { return JsonSerializer.Deserialize<T>(text, ResponseOptions) ?? throw new GeminiException(GeminiFailure.InvalidResponse); }
        catch (Exception error) when (error is not GeminiException) { throw new GeminiException(GeminiFailure.InvalidResponse); }
    }

    /// <summary>Sends one request and returns the answer's text as the model wrote it, for callers that can read more than JSON.</summary>
    public static async Task<string> GenerateText(IEnumerable<JsonNode> parts, JsonNode schema, GeminiConfiguration configuration,
                                                  CancellationToken cancellation = default)
    {
        // Every request names its video, so the server can count it against the limit. No video, no request.
        if (configuration.Usage.Video.Length == 0) throw new GeminiException(GeminiFailure.SignIn);
        if (await configuration.AccessToken() is not { Length: > 0 } token) throw new GeminiException(GeminiFailure.SignIn);
        var body = new JsonObject
        {
            ["contents"] = new JsonArray(new JsonObject { ["role"] = "user", ["parts"] = new JsonArray(parts.Select(p => p.DeepClone()).ToArray()) }),
            ["generationConfig"] = new JsonObject { ["temperature"] = 0.2, ["responseMimeType"] = "application/json", ["responseSchema"] = schema.DeepClone() },
        };
        var bytes = Encoding.UTF8.GetBytes(body.ToJsonString());
        if (bytes.Length > 19_000_000) throw new GeminiException(GeminiFailure.RequestTooLarge);
        using var ownClient = configuration.Handler is null ? null : new HttpClient(configuration.Handler, disposeHandler: false) { Timeout = Timeout.InfiniteTimeSpan };
        var received = await Send(ownClient ?? SharedClient, token, bytes, configuration, cancellation);
        cancellation.ThrowIfCancellationRequested();
        if (received is not { } response) throw new GeminiException(GeminiFailure.InvalidResponse);
        if (response.Status != HttpStatusCode.OK)
        {
            // The reason is in the body; show it instead of guessing from the status code.
            var (code, reason) = ServerError(response.Body);
            if (code == "usage_limit") throw new GeminiException(GeminiFailure.UsageLimit, (int)response.Status, reason);
            throw new GeminiException(GeminiFailure.Request, (int)response.Status, reason);
        }
        string text;
        try
        {
            using var json = JsonDocument.Parse(response.Body);
            var candidate = json.RootElement.GetProperty("candidates")[0];
            if (candidate.GetProperty("finishReason").GetString() != "STOP") throw new GeminiException(GeminiFailure.InvalidResponse);
            text = string.Concat(candidate.GetProperty("content").GetProperty("parts").EnumerateArray()
                .Where(part => !(part.TryGetProperty("thought", out var thought) && thought.ValueKind == JsonValueKind.True))
                .Select(part => part.TryGetProperty("text", out var value) ? value.GetString() : ""));
        }
        catch (Exception error) when (error is not GeminiException) { throw new GeminiException(GeminiFailure.InvalidResponse); }
        return text;
    }

    /// Server errors and short rate-limit waits are retried; the last response is returned as is.
    static async Task<(HttpStatusCode Status, string Body)?> Send(HttpClient client, string token, byte[] body,
                                                                  GeminiConfiguration configuration, CancellationToken cancellation)
    {
        var usage = configuration.Usage;
        (HttpStatusCode, string)? received = null;
        for (var attempt = 0; attempt <= RetryWaits.Length; attempt++)
        {
            cancellation.ThrowIfCancellationRequested();
            var canRetry = attempt < RetryWaits.Length;
            // A little randomness keeps the batches that run side by side from retrying in lockstep.
            var wait = canRetry ? RetryWaits[attempt] * (1 + Random.Shared.NextDouble() * 0.25) : 0;
            try
            {
                using var request = new HttpRequestMessage(HttpMethod.Post, GatewayUrl)
                {
                    Content = new ByteArrayContent(body) { Headers = { ContentType = new MediaTypeHeaderValue("application/json") } },
                };
                request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
                request.Headers.Add("apikey", Account.PublishableKey);
                request.Headers.Add("x-prism-video", usage.Video);
                request.Headers.Add("x-prism-minutes", usage.Minutes.ToString("R", System.Globalization.CultureInfo.InvariantCulture));
                request.Headers.Add("x-prism-day", usage.Day);
                if (usage.Run is { } run) request.Headers.Add("x-prism-run", run);
                using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellation);
                timeout.CancelAfter(TimeSpan.FromSeconds(180));
                using var response = await client.SendAsync(request, timeout.Token);
                var text = await response.Content.ReadAsStringAsync(timeout.Token);
                var status = (int)response.StatusCode;
                if (canRetry && status is 500 or 502 or 503 or 504 or 546)
                {
                    var pause = Math.Min(60, Math.Max(wait, RetryDelay(response, text) ?? 0));
                    configuration.OnRetry?.Invoke($"Prism AI is busy (HTTP {status}) · retrying in {Math.Round(pause)} s");
                    await Task.Delay(TimeSpan.FromSeconds(pause), cancellation);
                    continue;
                }
                // A per-minute limit says how long to wait; a usage limit or a daily limit doesn't, so it still fails.
                if (canRetry && status == 429 && RetryDelay(response, text) is { } delay && delay <= 60)
                {
                    configuration.OnRetry?.Invoke($"Prism AI rate limit · retrying in {Math.Round(delay) + 1} s");
                    await Task.Delay(TimeSpan.FromSeconds(delay + 1), cancellation);
                    continue;
                }
                received = (response.StatusCode, text);
                break;
            }
            catch (Exception error) when (!cancellation.IsCancellationRequested && attempt < 2 && error is HttpRequestException or TaskCanceledException)
            {
                // Requests may run three minutes before timing out, so lost connections get only two more tries.
                configuration.OnRetry?.Invoke($"Connection to Prism AI dropped · retrying in {Math.Round(wait)} s");
                await Task.Delay(TimeSpan.FromSeconds(wait), cancellation);
            }
        }
        return received;
    }

    /// <summary>The server's error code and message: {"error":{"code","message"}}, or a top-level message; null when absent.</summary>
    static (string? Code, string? Message) ServerError(string body)
    {
        try
        {
            if (JsonNode.Parse(body) is not JsonObject root) return (null, null);
            var error = root["error"] as JsonObject;
            string? Read(JsonNode? node) => node is JsonValue value && value.TryGetValue<string>(out var text) && text.Trim().Length > 0 ? text.Trim() : null;
            return (Read(error?["code"]), Read(error?["message"]) ?? Read(root["message"]) ?? Read(root["msg"]));
        }
        catch (JsonException) { return (null, null); }
    }

    /// <summary>Seconds the server asks us to wait, from Retry-After or the error's RetryInfo ("37s").</summary>
    public static double? RetryDelay(HttpResponseMessage response, string body)
    {
        if (response.Headers.RetryAfter?.Delta is { } delta && delta.TotalSeconds >= 0) return delta.TotalSeconds;
        if (response.Headers.TryGetValues("Retry-After", out var values) && double.TryParse(values.FirstOrDefault(), System.Globalization.NumberStyles.Float,
                System.Globalization.CultureInfo.InvariantCulture, out var seconds) && double.IsFinite(seconds) && seconds >= 0) return seconds;
        try
        {
            using var json = JsonDocument.Parse(body);
            foreach (var detail in json.RootElement.GetProperty("error").GetProperty("details").EnumerateArray())
                if (detail.TryGetProperty("retryDelay", out var value) && value.GetString() is { } text && text.EndsWith('s')
                    && double.TryParse(text[..^1], System.Globalization.NumberStyles.Float, System.Globalization.CultureInfo.InvariantCulture, out var parsed)
                    && double.IsFinite(parsed) && parsed >= 0)
                    return parsed;
        }
        catch (Exception) { }
        return null;
    }
}
