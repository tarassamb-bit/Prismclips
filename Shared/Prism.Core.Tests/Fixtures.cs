using System.Net;
using System.Runtime.CompilerServices;
using System.Text;
using System.Text.Json.Nodes;
using Prism.Core;
using SkiaSharp;

[assembly: CollectionBehavior(DisableTestParallelization = true)]

namespace Prism.Core.Tests;

/// Points the engine at throwaway folders and fast retries before any test runs, so tests never touch a real library or wait a minute.
static class TestSetup
{
    public static readonly string Root = Path.Combine(Path.GetTempPath(), $"prism-tests-{Guid.NewGuid()}");

    [ModuleInitializer]
    internal static void Initialize()
    {
        Directory.CreateDirectory(Root);
        AppPaths.AppData = Path.Combine(Root, "appdata");
        AppPaths.Config = Path.Combine(Root, "config");
        Renderer.CacheDirectory = Path.Combine(Root, "render-cache");
        Gemini.RetryWaits = [0.01, 0.01, 0.01, 0.01, 0.01];
    }
}

/// A fake Prism AI server: answers queued payloads with queued statuses and checks every request carries the session and its video.
sealed class FakeGemini : HttpMessageHandler
{
    public readonly Queue<int> Statuses = new();
    public readonly Queue<string> Payloads = new();
    public readonly List<string> Bodies = [];
    public int DefaultStatus = 200;
    public string Finish = "STOP";
    public string? ErrorBody;

    protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
    {
        Assert.Equal(Gemini.GatewayUrl, request.RequestUri);
        Assert.Equal("Bearer test-token", request.Headers.Authorization?.ToString());
        Assert.Equal(Account.PublishableKey, request.Headers.GetValues("apikey").Single());
        Assert.Equal(Usage.Video, request.Headers.GetValues("x-prism-video").Single());
        Assert.Equal("1.5", request.Headers.GetValues("x-prism-minutes").Single());
        Assert.Equal(Usage.Day, request.Headers.GetValues("x-prism-day").Single());
        Assert.Equal(Usage.Run is null, !request.Headers.Contains("x-prism-run"));
        string body = await request.Content!.ReadAsStringAsync(cancellationToken);
        int status;
        string payload;
        lock (this)
        {
            Bodies.Add(body);
            status = Statuses.Count > 0 ? Statuses.Dequeue() : DefaultStatus;
            payload = Payloads.Count > 0 ? Payloads.Dequeue() : """{"ok":true}""";
        }
        var text = status != 200 && ErrorBody is not null ? ErrorBody : new JsonObject
        {
            ["candidates"] = new JsonArray(new JsonObject
            {
                ["finishReason"] = Finish,
                ["content"] = new JsonObject { ["parts"] = new JsonArray(new JsonObject { ["thought"] = true, ["text"] = "ignore" }, new JsonObject { ["text"] = payload }) },
            }),
        }.ToJsonString();
        return new HttpResponseMessage((HttpStatusCode)status) { Content = new StringContent(text, Encoding.UTF8, "application/json") };
    }

    public GeminiUsage Usage = new(new string('a', 64), 1.5, "2026-10-30");
    public GeminiConfiguration Configuration() => new(() => Task.FromResult<string?>("test-token"), Usage) { Handler = this };
}

/// Test media made with ffmpeg's built-in sources.
static class Media
{
    static readonly Dictionary<string, string> Made = [];

    static async Task<string> Make(string name, params string[] arguments)
    {
        if (Made.TryGetValue(name, out var existing)) return existing;
        var path = Path.Combine(TestSetup.Root, name);
        var result = await FFmpeg.Run(FFmpeg.FFmpegPath, ["-hide_banner", "-loglevel", "error", "-y", .. arguments, path]);
        Assert.True(result.ExitCode == 0, result.Errors);
        Made[name] = path;
        return path;
    }

    /// <summary>A 640×360, 6-second test picture with a 440 Hz tone.</summary>
    public static Task<string> Pictures() => Make("pictures.mp4",
        "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=30:duration=6", "-f", "lavfi", "-i", "sine=frequency=440:duration=6",
        "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest");

    /// <summary>60 seconds of silence, for transcription requests the fake Gemini answers.</summary>
    public static Task<string> Silence() => Make("silence.m4a", "-f", "lavfi", "-i", "anullsrc=r=16000:cl=mono", "-t", "60", "-c:a", "aac");

    /// <summary>A plain gray picture with a tone: nothing in it can look like a yellow caption.</summary>
    public static Task<string> Gray() => Make("gray.mp4",
        "-f", "lavfi", "-i", "color=c=gray:size=640x360:rate=30:duration=4", "-f", "lavfi", "-i", "sine=frequency=330:duration=4",
        "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest");

    /// <summary>Tone with pauses at 2.0–2.4 s and 5.0–5.5 s, as 48 kHz stereo AAC like real videos carry.</summary>
    public static Task<string> Pauses() => Make("pauses.m4a",
        "-f", "lavfi", "-i", "aevalsrc=exprs='if(between(t,2,2.4)+between(t,5,5.5),0,0.4*sin(2*PI*220*t))':s=48000:d=8",
        "-ac", "2", "-c:a", "aac");

    /// <summary>A video stored 360×640 with a 90° display rotation, so it shows as 640×360 landscape. Quadrants are red, green,
    /// blue and yellow in storage; the decoded frame is the ground truth for orientation checks.</summary>
    public static async Task<string> Rotated()
    {
        if (Made.TryGetValue("rotated.mp4", out var existing)) return existing;
        var png = Path.Combine(TestSetup.Root, "quadrants.png");
        using (var surface = SKSurface.Create(new SKImageInfo(360, 640)))
        {
            var canvas = surface.Canvas;
            void Fill(float x, float y, SKColor color) { using var paint = new SKPaint { Color = color }; canvas.DrawRect(x, y, 180, 320, paint); }
            Fill(0, 0, SKColors.Red); Fill(180, 0, new SKColor(0, 255, 0)); Fill(0, 320, SKColors.Blue); Fill(180, 320, SKColors.Yellow);
            using var image = surface.Snapshot();
            using var data = image.Encode(SKEncodedImageFormat.Png, 100);
            File.WriteAllBytes(png, data.ToArray());
        }
        var plain = await Make("rotated-plain.mp4", "-loop", "1", "-i", png, "-t", "3", "-r", "30", "-c:v", "libx264", "-pix_fmt", "yuv420p");
        return await Make("rotated.mp4", "-display_rotation:v:0", "90", "-i", plain, "-c", "copy");
    }

    public static async Task<SKBitmap> Frame(string path, double time)
    {
        var jpeg = await FFmpeg.FrameJpeg(path, time, 4000);
        Assert.NotNull(jpeg);
        return SKBitmap.Decode(jpeg);
    }

    public static string Color(SKBitmap bitmap, double fx, double fy)
    {
        var c = bitmap.GetPixel((int)(bitmap.Width * fx), (int)(bitmap.Height * fy));
        return (c.Red > 128 ? "R" : "") + (c.Green > 128 ? "G" : "") + (c.Blue > 128 ? "B" : "");
    }
}
