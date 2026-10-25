using System.Diagnostics;
using System.Globalization;
using System.Text;
using System.Text.Json;

namespace Prism.Core;

/// What ffprobe reports about a file. Width and height are as displayed: a phone video's rotation is already applied.
public sealed record MediaInfo(double Duration, int Width, int Height, bool HasVideo, bool HasAudio, double FrameRate);

public sealed class FFmpegMissingException() : Exception(
    "Prism needs ffmpeg and ffprobe. " + (OperatingSystem.IsWindows()
        ? "Put ffmpeg.exe and ffprobe.exe next to Prism.exe, or install ffmpeg and add it to PATH."
        : "Install them with your package manager, for example: sudo apt install ffmpeg"));

/// Every video and audio operation runs through ffmpeg and ffprobe, the way the macOS app uses AVFoundation.
public static class FFmpeg
{
    static string? ffmpeg, ffprobe;
    static int? majorVersion;
    static HashSet<string>? encoders;

    /// <summary>PRISM_FFMPEG, then ffmpeg next to the app, then PATH.</summary>
    public static string FFmpegPath => ffmpeg ??= Locate("ffmpeg", "PRISM_FFMPEG") ?? throw new FFmpegMissingException();
    public static string FFprobePath => ffprobe ??= Locate("ffprobe", "PRISM_FFPROBE") ?? throw new FFmpegMissingException();

    public static bool IsAvailable
    {
        get
        {
            try { _ = FFmpegPath; _ = FFprobePath; return true; }
            catch (FFmpegMissingException) { return false; }
        }
    }

    static string? Locate(string tool, string variable)
    {
        var exe = OperatingSystem.IsWindows() ? tool + ".exe" : tool;
        if (Environment.GetEnvironmentVariable(variable) is { Length: > 0 } configured && File.Exists(configured)) return configured;
        foreach (var folder in new[] { AppContext.BaseDirectory, Path.Combine(AppContext.BaseDirectory, "ffmpeg") })
            if (File.Exists(Path.Combine(folder, exe))) return Path.Combine(folder, exe);
        foreach (var folder in (Environment.GetEnvironmentVariable("PATH") ?? "").Split(Path.PathSeparator, StringSplitOptions.RemoveEmptyEntries))
        {
            var candidate = Path.Combine(folder.Trim('"'), exe);
            if (File.Exists(candidate)) return candidate;
        }
        return null;
    }

    public sealed record Result(int ExitCode, byte[] Output, string Errors);

    /// <summary>Runs a tool without a shell or console window; cancelling kills it. Output is collected as bytes.</summary>
    public static async Task<Result> Run(string tool, IEnumerable<string> arguments, CancellationToken cancellation = default,
                                         Action<string>? onOutputLine = null)
    {
        cancellation.ThrowIfCancellationRequested();
        var start = new ProcessStartInfo(tool)
        {
            RedirectStandardOutput = true, RedirectStandardError = true, RedirectStandardInput = true,
            UseShellExecute = false, CreateNoWindow = true,
        };
        foreach (var argument in arguments) start.ArgumentList.Add(argument);
        using var process = Process.Start(start) ?? throw new FFmpegMissingException();
        process.StandardInput.Close();
        using var registration = cancellation.Register(() => { try { process.Kill(entireProcessTree: true); } catch { } });
        using var output = new MemoryStream();
        Task readOutput;
        if (onOutputLine is null) readOutput = process.StandardOutput.BaseStream.CopyToAsync(output);
        else readOutput = Task.Run(async () =>
        {
            try { while (await process.StandardOutput.ReadLineAsync() is { } line) onOutputLine(line); }
            catch
            {
                // A failed progress callback must not leave the encoder running or blocked on a full stdout pipe.
                try { process.Kill(entireProcessTree: true); } catch { }
                throw;
            }
        });
        var readErrors = process.StandardError.ReadToEndAsync();
        try { await Task.WhenAll(readOutput, readErrors, process.WaitForExitAsync()); }
        catch { cancellation.ThrowIfCancellationRequested(); throw; }
        cancellation.ThrowIfCancellationRequested();
        return new Result(process.ExitCode, output.ToArray(), readErrors.Result);
    }

    static Task<Result> Tool(IEnumerable<string> arguments, CancellationToken cancellation = default) =>
        Run(FFmpegPath, ["-hide_banner", "-nostdin", "-loglevel", "error", .. arguments], cancellation);

    static string Number(double value) => value.ToString("0.###", CultureInfo.InvariantCulture);

    /// <summary>ffmpeg's major version; filter graphs are passed differently before version 7.</summary>
    public static int MajorVersion
    {
        get
        {
            if (majorVersion is { } known) return known;
            var result = Run(FFmpegPath, ["-hide_banner", "-version"]).GetAwaiter().GetResult();
            var text = Encoding.UTF8.GetString(result.Output);
            var match = System.Text.RegularExpressions.Regex.Match(text, @"version n?(\d+)");
            majorVersion = match.Success ? int.Parse(match.Groups[1].Value, CultureInfo.InvariantCulture) : 7;
            return majorVersion.Value;
        }
    }

    /// <summary>Whether this ffmpeg build can encode with the named encoder (libx265 is missing from some builds).</summary>
    public static bool HasEncoder(string name)
    {
        if (encoders is null)
        {
            var result = Run(FFmpegPath, ["-hide_banner", "-encoders"]).GetAwaiter().GetResult();
            encoders = Encoding.UTF8.GetString(result.Output).Split('\n')
                .Select(line => line.Trim().Split(' ', StringSplitOptions.RemoveEmptyEntries))
                .Where(parts => parts.Length > 1).Select(parts => parts[1]).ToHashSet();
        }
        return encoders.Contains(name);
    }

    public static async Task<MediaInfo?> Probe(string path, CancellationToken cancellation = default)
    {
        if (!File.Exists(path)) return null;
        var result = await Run(FFprobePath, ["-v", "error", "-print_format", "json", "-show_streams", "-show_format", path], cancellation);
        if (result.ExitCode != 0) return null;
        try
        {
            using var json = JsonDocument.Parse(result.Output);
            double duration = 0;
            if (json.RootElement.TryGetProperty("format", out var format) && format.TryGetProperty("duration", out var d))
                double.TryParse(d.GetString(), NumberStyles.Float, CultureInfo.InvariantCulture, out duration);
            int width = 0, height = 0;
            double rate = 0;
            bool hasVideo = false, hasAudio = false;
            foreach (var stream in json.RootElement.GetProperty("streams").EnumerateArray())
            {
                var type = stream.TryGetProperty("codec_type", out var t) ? t.GetString() : null;
                if (type == "audio") hasAudio = true;
                // Cover art arrives as a one-frame "video" stream; it isn't a playable picture.
                var attached = stream.TryGetProperty("disposition", out var disposition)
                    && disposition.TryGetProperty("attached_pic", out var pic) && pic.GetInt32() == 1;
                if (type != "video" || hasVideo || attached) continue;
                hasVideo = true;
                width = stream.TryGetProperty("width", out var w) ? w.GetInt32() : 0;
                height = stream.TryGetProperty("height", out var h) ? h.GetInt32() : 0;
                rate = Rate(stream, "avg_frame_rate") is > 0 and var average ? average : Rate(stream, "r_frame_rate");
                if (Math.Abs(Rotation(stream)) % 180 == 90) (width, height) = (height, width);
            }
            return new MediaInfo(duration, width, height, hasVideo, hasAudio, rate);
        }
        catch (Exception) { return null; }
    }

    static double Rate(JsonElement stream, string key)
    {
        if (!stream.TryGetProperty(key, out var value) || value.GetString() is not { } text) return 0;
        var parts = text.Split('/');
        return parts.Length == 2 && double.TryParse(parts[0], NumberStyles.Float, CultureInfo.InvariantCulture, out var n)
               && double.TryParse(parts[1], NumberStyles.Float, CultureInfo.InvariantCulture, out var den) && den > 0 ? n / den : 0;
    }

    /// Phone videos store their frames sideways with a display rotation; ffmpeg applies it when decoding.
    static int Rotation(JsonElement stream)
    {
        if (stream.TryGetProperty("side_data_list", out var sideData))
            foreach (var item in sideData.EnumerateArray())
                if (item.TryGetProperty("rotation", out var rotation) && rotation.TryGetDouble(out var degrees)) return (int)Math.Round(degrees);
        if (stream.TryGetProperty("tags", out var tags) && tags.TryGetProperty("rotate", out var rotate)
            && int.TryParse(rotate.GetString(), out var tagged)) return tagged;
        return 0;
    }

    static string FitWithin(int size) => $"scale=w='min({size},iw)':h='min({size},ih)':force_original_aspect_ratio=decrease";

    /// <summary>One frame as JPEG, at most <paramref name="maxSize"/> pixels on its longer side.</summary>
    public static async Task<byte[]?> FrameJpeg(string path, double time, int maxSize = 640, CancellationToken cancellation = default)
    {
        var result = await Tool(["-ss", Number(Math.Max(0, time)), "-i", path, "-frames:v", "1", "-vf", FitWithin(maxSize),
                                 "-q:v", "5", "-f", "image2pipe", "-vcodec", "mjpeg", "pipe:1"], cancellation);
        return result.ExitCode == 0 && result.Output.Length > 0 ? result.Output : null;
    }

    public static async Task<bool> Thumbnail(string path, double time, string output, int maxSize = 480, CancellationToken cancellation = default)
    {
        var jpeg = await FrameJpeg(path, time, maxSize, cancellation);
        if (jpeg is null) return false;
        Directory.CreateDirectory(Path.GetDirectoryName(output)!);
        await File.WriteAllBytesAsync(output, jpeg, cancellation);
        return true;
    }

    /// <summary>Frames every <paramref name="step"/> seconds across a range, decoded in one pass. Times are from the range start.</summary>
    public static async Task<List<(double Time, byte[] Jpeg)>> FramesJpeg(string path, double start, double duration, double step,
                                                                        int maxSize = 512, CancellationToken cancellation = default)
    {
        var result = await Tool(["-ss", Number(start), "-t", Number(duration), "-i", path,
                                 "-vf", $"fps=1/{Number(step)},{FitWithin(maxSize)}", "-q:v", "5", "-f", "image2pipe", "-vcodec", "mjpeg", "pipe:1"], cancellation);
        var frames = SplitJpegs(result.Output);
        return frames.Select((jpeg, index) => (Math.Min(duration - 0.001, index * step), jpeg)).ToList();
    }

    /// Concatenated JPEGs split at each start-of-image marker, which can't occur inside compressed data.
    internal static List<byte[]> SplitJpegs(byte[] data)
    {
        var starts = new List<int>();
        for (var i = 0; i + 2 < data.Length; i++)
            if (data[i] == 0xFF && data[i + 1] == 0xD8 && data[i + 2] == 0xFF) starts.Add(i);
        return starts.Select((s, n) => data[s..(n + 1 < starts.Count ? starts[n + 1] : data.Length)]).ToList();
    }

    /// <summary>32×18 grayscale grids ten times a second across a range, for spotting scene cuts.</summary>
    public static async Task<List<byte[]>> GrayGrids(string path, double start, double duration, CancellationToken cancellation = default)
    {
        var result = await Tool(["-ss", Number(start), "-t", Number(duration), "-i", path,
                                 "-vf", "fps=10,scale=32:18:flags=area,format=gray", "-f", "rawvideo", "-pix_fmt", "gray", "pipe:1"], cancellation);
        const int size = 32 * 18;
        return Enumerable.Range(0, result.Output.Length / size).Select(i => result.Output[(i * size)..((i + 1) * size)]).ToList();
    }

    /// <summary>A stretch of audio as small mono AAC for Gemini; null when the file has no readable audio there.</summary>
    public static async Task<byte[]?> AudioChunk(string path, double start, double length, CancellationToken cancellation = default)
    {
        var temporary = Path.Combine(Path.GetTempPath(), $"prism-gemini-{Guid.NewGuid()}.m4a");
        try
        {
            var result = await Tool(["-ss", Number(start), "-t", Number(length), "-i", path, "-vn", "-ac", "1", "-ar", "16000",
                                     "-c:a", "aac", "-b:a", "48k", "-f", "mp4", "-y", temporary], cancellation);
            return result.ExitCode == 0 && File.Exists(temporary) ? await File.ReadAllBytesAsync(temporary, cancellation) : null;
        }
        finally { try { File.Delete(temporary); } catch { } }
    }

    /// <summary>Loudness (RMS) of the audio in 10 ms frames as 16 kHz mono; null when the file has no readable audio.</summary>
    public static async Task<float[]?> AudioLevels(string path, double from, double to, CancellationToken cancellation = default)
    {
        if (to <= from) return null;
        var result = await Tool(["-ss", Number(from), "-t", Number(to - from), "-i", path, "-vn", "-ac", "1", "-ar", "16000",
                                 "-f", "f32le", "pipe:1"], cancellation);
        if (result.ExitCode != 0 || result.Output.Length < 4) return null;
        var samples = new float[result.Output.Length / 4];
        Buffer.BlockCopy(result.Output, 0, samples, 0, samples.Length * 4);
        if (!BitConverter.IsLittleEndian) for (var i = 0; i < samples.Length; i++) samples[i] = BitConverter.ToSingle(BitConverter.GetBytes(samples[i]).Reverse().ToArray());
        var levels = new float[(samples.Length + 159) / 160];
        for (var frame = 0; frame < levels.Length; frame++)
        {
            double sum = 0;
            var first = frame * 160;
            var count = Math.Min(160, samples.Length - first);
            for (var i = 0; i < count; i++) sum += samples[first + i] * samples[first + i];
            levels[frame] = (float)Math.Sqrt(sum / count);
        }
        return levels;
    }
}
