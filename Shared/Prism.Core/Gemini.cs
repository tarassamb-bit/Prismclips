using System.Net;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace Prism.Core;

public sealed class GeminiConfiguration(string apiKey, string model)
{
    public string ApiKey { get; } = apiKey;
    public string Model { get; } = model;
    /// <summary>Tests send requests through a fake handler; the app uses the real network.</summary>
    public HttpMessageHandler? Handler { get; init; }
    /// <summary>Told when a request waits to retry, so a long pause shows as "retrying" instead of a frozen progress bar.</summary>
    public Action<string>? OnRetry { get; set; }
    /// <summary>Told when an overloaded model hands a request to another model, so the person learns which model made their Shorts.</summary>
    public Action<string, string>? OnFallback { get; set; }
}

/// Gemini's generateContent API with structured JSON output, retries and model fallback, as in the macOS app.
public static class Gemini
{
    /// <summary>Seconds to wait before each retry of a server error (500–504). An overloaded model often stays busy for tens of
    /// seconds, so the waits grow to about a minute in all. Tests shorten these.</summary>
    public static double[] RetryWaits { get; set; } = [2, 4, 8, 15, 30];

    /// <summary>Models tried when the chosen one is overloaded, in order. All are generally available Gemini models in Settings.</summary>
    public static readonly string[] FallbackModels = ["gemini-3.5-flash-lite", "gemini-3.1-flash-lite", "gemini-3.6-flash"];

    /// <summary>The models Settings offers, with the picker's labels.</summary>
    public static readonly (string Id, string Title)[] Models =
    [
        ("gemini-3.1-flash-lite", "Gemini 3.1 Flash-Lite · Recommended"),
        ("gemini-3.5-flash-lite", "Gemini 3.5 Flash-Lite · Low cost"),
        ("gemini-3.6-flash", "Gemini 3.6 Flash · Higher capability"),
    ];

    static readonly HttpClient SharedClient = new() { Timeout = Timeout.InfiniteTimeSpan };
    static readonly Dictionary<string, (string Model, DateTime Until)> Working = [];
    static readonly JsonSerializerOptions ResponseOptions = new() { PropertyNameCaseInsensitive = true };

    /// <summary>A fallback that worked is tried first for ten minutes, so every request in a run doesn't wait a minute on the busy model.</summary>
    public static List<string> ModelOrder(string chosen)
    {
        string? preferred;
        lock (Working) preferred = Working.TryGetValue(chosen, out var entry) && entry.Until > DateTime.UtcNow ? entry.Model : null;
        return new[] { preferred, chosen }.OfType<string>().Concat(FallbackModels).Distinct().ToList();
    }

    public static void RememberWorking(string model, string chosen)
    {
        lock (Working)
        {
            if (model == chosen) Working.Remove(chosen);
            else Working[chosen] = (model, DateTime.UtcNow.AddMinutes(10));
        }
    }

    public static JsonObject Text(string text) => new() { ["text"] = text };
    public static JsonObject Inline(string mimeType, byte[] data) => new() { ["inlineData"] = new JsonObject { ["mimeType"] = mimeType, ["data"] = Convert.ToBase64String(data) } };

    /// <summary>Sends one request and decodes Gemini's JSON answer into <typeparamref name="T"/>.</summary>
    public static async Task<T> Generate<T>(IEnumerable<JsonNode> parts, JsonNode schema, GeminiConfiguration configuration,
                                            CancellationToken cancellation = default)
    {
        var name = configuration.Model.Trim();
        var key = configuration.ApiKey.Trim();
        if (key.Length == 0 || name.Length == 0 || !name.All(c => char.IsAscii(c) && (char.IsLetterOrDigit(c) || c is '-' or '.')))
            throw new GeminiException(GeminiFailure.InvalidConfiguration);
        var body = new JsonObject
        {
            ["contents"] = new JsonArray(new JsonObject { ["role"] = "user", ["parts"] = new JsonArray(parts.Select(p => p.DeepClone()).ToArray()) }),
            ["generationConfig"] = new JsonObject { ["temperature"] = 0.2, ["responseMimeType"] = "application/json", ["responseSchema"] = schema.DeepClone() },
        };
        var bytes = Encoding.UTF8.GetBytes(body.ToJsonString());
        if (bytes.Length > 19_000_000) throw new GeminiException(GeminiFailure.RequestTooLarge);
        using var ownClient = configuration.Handler is null ? null : new HttpClient(configuration.Handler, disposeHandler: false) { Timeout = Timeout.InfiniteTimeSpan };
        var client = ownClient ?? SharedClient;
        (HttpStatusCode Status, string Body)? received = null;
        var models = ModelOrder(name);
        for (var index = 0; index < models.Count; index++)
        {
            var model = models[index];
            received = await Send(client, model, key, bytes, configuration, cancellation);
            var status = received?.Status;
            // A fallback's 404 means this key can't use it; the chosen model's 404 still sends the person to Settings.
            var modelFailed = status is { } code && ((int)code is 500 or 502 or 503 or 504 || ((int)code == 404 && model != name));
            if (!modelFailed || index + 1 >= models.Count)
            {
                if (status == HttpStatusCode.OK) RememberWorking(model, name);
                break;
            }
            configuration.OnRetry?.Invoke($"{model} is unavailable (HTTP {(int)status!}) · switching to {models[index + 1]}");
            configuration.OnFallback?.Invoke(model, models[index + 1]);
        }
        cancellation.ThrowIfCancellationRequested();
        if (received is not { } response) throw new GeminiException(GeminiFailure.InvalidResponse);
        if (response.Status != HttpStatusCode.OK) throw new GeminiException(GeminiFailure.Request, (int)response.Status);
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
        try { return JsonSerializer.Deserialize<T>(text, ResponseOptions) ?? throw new GeminiException(GeminiFailure.InvalidResponse); }
        catch (Exception error) when (error is not GeminiException) { throw new GeminiException(GeminiFailure.InvalidResponse); }
    }

    /// One model's attempts: server errors and short rate-limit waits are retried; the last response is returned as is.
    static async Task<(HttpStatusCode, string)?> Send(HttpClient client, string model, string key, byte[] body,
                                                      GeminiConfiguration configuration, CancellationToken cancellation)
    {
        (HttpStatusCode, string)? received = null;
        for (var attempt = 0; attempt <= RetryWaits.Length; attempt++)
        {
            cancellation.ThrowIfCancellationRequested();
            var canRetry = attempt < RetryWaits.Length;
            // A little randomness keeps the batches that run side by side from retrying in lockstep.
            var wait = canRetry ? RetryWaits[attempt] * (1 + Random.Shared.NextDouble() * 0.25) : 0;
            try
            {
                using var request = new HttpRequestMessage(HttpMethod.Post, $"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent")
                {
                    Content = new ByteArrayContent(body) { Headers = { ContentType = new MediaTypeHeaderValue("application/json") } },
                };
                request.Headers.Add("x-goog-api-key", key);
                using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellation);
                timeout.CancelAfter(TimeSpan.FromSeconds(180));
                using var response = await client.SendAsync(request, timeout.Token);
                var text = await response.Content.ReadAsStringAsync(timeout.Token);
                var status = (int)response.StatusCode;
                if (canRetry && status is 500 or 502 or 503 or 504)
                {
                    var pause = Math.Min(60, Math.Max(wait, RetryDelay(response, text) ?? 0));
                    configuration.OnRetry?.Invoke($"Gemini is busy (HTTP {status}) · retrying in {Math.Round(pause)} s");
                    await Task.Delay(TimeSpan.FromSeconds(pause), cancellation);
                    continue;
                }
                // A per-minute limit says how long to wait; a daily limit doesn't, or asks for too long, so it still fails.
                if (canRetry && status == 429 && RetryDelay(response, text) is { } delay && delay <= 60)
                {
                    configuration.OnRetry?.Invoke($"Gemini rate limit · retrying in {Math.Round(delay) + 1} s");
                    await Task.Delay(TimeSpan.FromSeconds(delay + 1), cancellation);
                    continue;
                }
                received = (response.StatusCode, text);
                break;
            }
            catch (Exception error) when (!cancellation.IsCancellationRequested && attempt < 2 && error is HttpRequestException or TaskCanceledException)
            {
                // Requests may run three minutes before timing out, so lost connections get only two more tries.
                configuration.OnRetry?.Invoke($"Connection to Google dropped · retrying in {Math.Round(wait)} s");
                await Task.Delay(TimeSpan.FromSeconds(wait), cancellation);
            }
        }
        return received;
    }

    /// <summary>Seconds Gemini asks us to wait, from Retry-After or the error's RetryInfo ("37s").</summary>
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
