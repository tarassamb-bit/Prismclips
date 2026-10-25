using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using static System.FormattableString;

namespace Prism.Core;

/// Renders a Short to a 9:16 MP4 with ffmpeg: the layout (crop, Fit or split screen), the camera path and the caption track.
/// Previews use the same graph at a smaller size, so what you preview is what you export.
public static class Renderer
{
    /// <summary>Finished previews kept between edits, so going back to a Short doesn't render it again.</summary>
    public static string CacheDirectory { get; set; } = Path.Combine(Path.GetTempPath(), "PrismRenderCache");

    /// <summary>Renders the Short into <paramref name="destination"/>, which must not exist yet.</summary>
    public static async Task Export(string source, EditSegment segment, string destination, ExportQuality quality = ExportQuality.Full,
                                    Action<double>? progress = null, CancellationToken cancellation = default)
    {
        if (File.Exists(destination)) throw new ShortMakerException(ShortMakerFailure.DestinationExists);
        var folder = Path.GetDirectoryName(Path.GetFullPath(destination))!;
        Directory.CreateDirectory(folder);
        var temporary = Path.Combine(folder, $".prism-{Guid.NewGuid()}.mp4");
        try
        {
            var (width, height) = quality == ExportQuality.Small ? (720, 1280) : (1080, 1920);
            var video = quality switch
            {
                ExportQuality.Compact when FFmpeg.HasEncoder("libx265") => new[] { "-c:v", "libx265", "-preset", "medium", "-crf", "23", "-tag:v", "hvc1" },
                ExportQuality.Compact => throw new ShortMakerException(ShortMakerFailure.CannotExport, "This ffmpeg has no HEVC (libx265) encoder; choose 1080p · H.264."),
                ExportQuality.Small => ["-c:v", "libx264", "-preset", "medium", "-crf", "21", "-profile:v", "high"],
                _ => ["-c:v", "libx264", "-preset", "medium", "-crf", "18", "-profile:v", "high"],
            };
            await Render(source, segment, temporary, width, height, video, "160k", progress, cancellation);
            if (File.Exists(destination)) throw new ShortMakerException(ShortMakerFailure.DestinationExists);
            File.Move(temporary, destination);
        }
        finally { try { File.Delete(temporary); } catch { } }
    }

    /// <summary>A fast 540×960 render for the editor's player, cached by everything that changes the picture or sound.</summary>
    public static async Task<string> Preview(string source, EditSegment segment, CancellationToken cancellation = default)
    {
        var file = new FileInfo(source);
        var key = $"preview-v2|{source}|{(file.Exists ? file.Length : 0)}|{(file.Exists ? file.LastWriteTimeUtc.Ticks : 0)}|{PrismJson.Serialize(segment)}";
        var cached = Path.Combine(CacheDirectory, $"preview-{Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(key)))[..32]}.mp4");
        if (File.Exists(cached)) { File.SetLastWriteTimeUtc(cached, DateTime.UtcNow); return cached; }
        Directory.CreateDirectory(CacheDirectory);
        var temporary = Path.Combine(CacheDirectory, $".render-{Guid.NewGuid()}.mp4");
        try
        {
            await Render(source, segment, temporary, 540, 960, ["-c:v", "libx264", "-preset", "ultrafast", "-crf", "28"], "96k", null, cancellation);
            // Fails only if a parallel render stored the same preview first.
            try { File.Move(temporary, cached); } catch (IOException) when (File.Exists(cached)) { }
            Prune();
            return cached;
        }
        finally { try { File.Delete(temporary); } catch { } }
    }

    /// Each cached file is a full Short, so only the newest ones are kept.
    static void Prune(int keep = 24)
    {
        try
        {
            foreach (var old in new DirectoryInfo(CacheDirectory).GetFiles("preview-*.mp4").OrderByDescending(f => f.LastWriteTimeUtc).Skip(keep)) old.Delete();
        }
        catch (Exception) { }
    }

    static string N(double value) => value.ToString("0.######", CultureInfo.InvariantCulture);

    static async Task Render(string source, EditSegment segment, string output, int width, int height, string[] videoCodec, string audioBitrate,
                             Action<double>? progress, CancellationToken cancellation)
    {
        var info = await FFmpeg.Probe(source, cancellation);
        if (info is not { HasVideo: true, Width: > 0, Height: > 0 }) throw new ShortMakerException(ShortMakerFailure.NoVideo);
        if (!double.IsFinite(segment.Start) || !double.IsFinite(segment.Duration) || segment.Start < 0 || segment.Duration <= 0
            || segment.Start + segment.Duration > info.Duration + 0.05 || !double.IsFinite(segment.CaptionStart ?? 0)
            || !double.IsFinite(segment.CaptionDuration ?? segment.Duration)) throw new ShortMakerException(ShortMakerFailure.InvalidRange);
        var work = Path.Combine(Path.GetTempPath(), $"prism-render-{Guid.NewGuid()}");
        Directory.CreateDirectory(work);
        try
        {
            var captions = CaptionRenderer.WriteTrack(segment, Path.Combine(work, "captions"));
            var graph = new StringBuilder(Layout(segment, info.Width, info.Height));
            var last = "picture";
            if (captions is not null)
            {
                graph.Append(";[picture][1:v]overlay=0:0:format=auto:eof_action=repeat[captioned]");
                last = "captioned";
            }
            graph.Append(Invariant($";[{last}]scale={width}:{height}:flags=lanczos,setsar=1,format=yuv420p[out]"));
            var graphFile = Path.Combine(work, "graph.txt");
            await File.WriteAllTextAsync(graphFile, graph.ToString(), cancellation);
            var arguments = new List<string> { "-hide_banner", "-nostdin", "-loglevel", "error", "-y",
                "-ss", N(segment.Start), "-t", N(segment.Duration), "-i", source };
            if (captions is not null) arguments.AddRange(["-f", "concat", "-safe", "0", "-i", captions]);
            // ffmpeg 7 reads a filter graph from a file with "-/filter_complex"; older builds use -filter_complex_script.
            arguments.AddRange(FFmpeg.MajorVersion >= 7 ? ["-/filter_complex", graphFile] : ["-filter_complex_script", graphFile]);
            arguments.AddRange(["-map", "[out]"]);
            if (segment.IsMuted == true || !info.HasAudio) arguments.Add("-an");
            else arguments.AddRange(["-map", "0:a:0", "-c:a", "aac", "-b:a", audioBitrate]);
            arguments.AddRange(videoCodec);
            arguments.AddRange(["-pix_fmt", "yuv420p", "-r", "30", "-t", N(segment.Duration), "-movflags", "+faststart",
                "-progress", "pipe:1", "-nostats", output]);
            var result = await FFmpeg.Run(FFmpeg.FFmpegPath, arguments, cancellation, line =>
            {
                if (progress is null || !line.StartsWith("out_time_us=", StringComparison.Ordinal)) return;
                if (long.TryParse(line["out_time_us=".Length..], out var micros)) progress(Math.Clamp(micros / 1e6 / segment.Duration, 0, 1));
            });
            if (result.ExitCode != 0 || !File.Exists(output))
                throw new ShortMakerException(ShortMakerFailure.CannotExport, result.Errors.Trim().Split('\n').LastOrDefault());
        }
        finally { try { Directory.Delete(work, recursive: true); } catch { } }
    }

    /// <summary>The filter graph from the source's first video stream to a 1080×1920 stream labelled [picture].</summary>
    public static string Layout(EditSegment segment, int sourceWidth, int sourceHeight)
    {
        double ow = sourceWidth, oh = sourceHeight;
        var keyframes = (segment.CropKeyframes ?? []).Where(k => double.IsFinite(k.Time) && double.IsFinite(k.Position)).ToList();
        // A tracked path Gemini marked as screens or slides shows the whole frame, like Fit.
        var wholeFrame = keyframes.Count > 0 && keyframes.All(k => k.PreserveWholeFrame == true);
        if (segment.SplitScreen == true)
        {
            // The left speaker fills the top, the right speaker the bottom, each in a half-width window centered on them.
            var half = ow / 2;
            var centers = segment.SplitCenters is { Count: 2 } c ? c : null;
            double WindowX(double center) => Math.Min(ow - half, Math.Max(0, center * ow - half / 2));
            var top = centers is null ? 0 : WindowX(centers[0]);
            var bottom = centers is null ? half : WindowX(centers[1]);
            return Invariant($"[0:v]fps=30,split=2[a][b];[a]crop={Even(half)}:{Even(oh)}:{Math.Round(top)}:0,scale=1080:960:force_original_aspect_ratio=increase,crop=1080:960[top];") +
                   Invariant($"[b]crop={Even(half)}:{Even(oh)}:{Math.Round(bottom)}:0,scale=1080:960:force_original_aspect_ratio=increase,crop=1080:960[bottom];[top][bottom]vstack[picture]");
        }
        if (segment.FitToFrame == true || wholeFrame)
        {
            if (ow / oh <= 1080.0 / 1920)
                return "[0:v]fps=30,scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2:black[picture]";
            // The whole source over a blurred, zoomed copy of itself. A heavy blur keeps no detail, so it runs at 1/8 size.
            return "[0:v]fps=30,split=2[bgsource][fgsource];" +
                   "[bgsource]scale=146:260:force_original_aspect_ratio=increase,crop=135:240,gblur=sigma=4.5,eq=saturation=0.68:contrast=1.04:brightness=-0.08,scale=1080:1920:flags=bilinear[background];" +
                   "[fgsource]scale=1080:1920:force_original_aspect_ratio=decrease[foreground];[background][foreground]overlay=(W-w)/2:(H-h)/2[picture]";
        }
        var scale = Math.Max(1080 / ow, 1920 / oh) * Math.Clamp(segment.CropZoom ?? 1.08, 1, 2);
        var scaledWidth = Even(Math.Ceiling(ow * scale));
        var scaledHeight = Even(Math.Ceiling(oh * scale));
        var pan = ow / oh < 1.2 ? 0 : Math.Max(0, scaledWidth - 1080);
        var y = Math.Max(0, (scaledHeight - 1920) / 2);
        string x;
        if (pan <= 2) x = N(Math.Max(0, (scaledWidth - 1080) / 2.0));
        else if (keyframes.Count == 0) x = N(pan * Math.Clamp(segment.CropPosition ?? 0.5, 0, 1));
        else x = PanExpression(keyframes, segment.Duration, (segment.CropPosition ?? 0.5) - 0.5, pan);
        return Invariant($"[0:v]fps=30,scale={scaledWidth}:{scaledHeight}:flags=bicubic,crop=1080:1920:x='{x}':y={y}[picture]");
    }

    /// Rounds down: rounding to nearest made an odd source size like 1083 into a 1084 crop, larger than the frame.
    static int Even(double value) => Math.Max(2, (int)Math.Floor(value / 2) * 2);

    /// <summary>The crop's left edge over time: the eased camera path, offset by the tracking bias, holding until each scene cut.</summary>
    public static string PanExpression(IReadOnlyList<CropKeyframe> keyframes, double duration, double bias, double pan)
    {
        var points = keyframes.Select(k => k with { Time = Math.Clamp(k.Time, 0, duration), Position = Math.Clamp(k.Position + bias, 0, 1) })
                              .OrderBy(k => k.Time).ToList();
        if (points[0].Time > 0) points.Insert(0, points[0] with { Time = 0, IsSceneCut = null });
        if (points[^1].Time < duration) points.Add(points[^1] with { Time = duration, IsSceneCut = null });
        var path = SubjectFramer.Eased(points);
        // Nested ifs from the last segment outward; ffmpeg evaluates it once per frame.
        var expression = N(pan * path[^1].Position);
        for (var index = path.Count - 2; index >= 0; index--)
        {
            CropKeyframe a = path[index], b = path[index + 1];
            if (b.Time <= a.Time) continue;
            string segmentValue = b.IsSceneCut == true
                ? N(pan * a.Position)
                : Invariant($"{N(pan * a.Position)}+{N(pan * (b.Position - a.Position))}*(t-{N(a.Time)})/{N(b.Time - a.Time)}");
            expression = Invariant($"if(lt(t,{N(b.Time)}),{segmentValue},{expression})");
        }
        return expression;
    }
}
