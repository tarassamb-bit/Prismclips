using System.Text.Json.Serialization;

namespace Prism.Core;

/// A video, photo or audio file copied into a project. JSON names match the macOS app, so project folders open on every system.
public sealed class MediaItem
{
    public Guid Id { get; set; } = Guid.NewGuid();
    public string Path { get; set; } = "";
    public string Kind { get; set; } = "video";
    public double Duration { get; set; }
    public int Width { get; set; }
    public int Height { get; set; }
    public string? Thumbnail { get; set; }
    public bool? HasAudio { get; set; }
    public string Note { get; set; } = "";
    public int Priority { get; set; } = 50;
    public DateTime Created { get; set; } = DateTime.UtcNow;

    [JsonIgnore] public string Name => FileName(Path);
    /// <summary>Managed projects can have paths saved on either Windows or a Unix system.</summary>
    public static string FileName(string path) => System.IO.Path.GetFileName(path.Replace('\\', '/'));
}

/// One Short: a range of a source video plus its framing, captions and text.
public sealed class EditSegment
{
    public Guid Id { get; set; } = Guid.NewGuid();
    [JsonPropertyName("mediaID")] public Guid MediaId { get; set; }
    public double Start { get; set; }
    public double Duration { get; set; }
    /// <summary>The on-screen text overlay (not speech subtitles).</summary>
    public string Caption { get; set; } = "";
    public bool? IsMuted { get; set; } = false;
    public double? CaptionStart { get; set; } = 0;
    public double? CaptionDuration { get; set; }
    public bool? FitToFrame { get; set; }
    public List<TimedCaption>? Captions { get; set; }
    public double? CropZoom { get; set; } = 1.08;
    /// <summary>Horizontal crop center as a fraction of the pan range (0 left, 0.5 center, 1 right).</summary>
    public double? CropPosition { get; set; } = 0.5;
    /// <summary>Time-stamped framing positions; null means the path has not been analyzed yet.</summary>
    public List<CropKeyframe>? CropKeyframes { get; set; }
    /// <summary>Framing algorithm version that made <see cref="CropKeyframes"/>; older paths are redone on next preview or export.</summary>
    public int? CropTrackingVersion { get; set; }
    /// <summary>Gemini word timings relative to this Short, used to keep trims from clipping speech.</summary>
    public List<TimedSpeechWord>? SpeechWords { get; set; }
    public int? Score { get; set; }
    public string? SuggestedTitle { get; set; }
    public string? SelectionReason { get; set; }
    public string? CaptionNotice { get; set; }
    public CaptionStyle? CaptionStyle { get; set; }
    public VideoType? VideoType { get; set; }
    /// <summary>Where subtitles sit; null is the bottom.</summary>
    public CaptionPosition? CaptionPosition { get; set; }
    /// <summary>Subtitle size; null is medium.</summary>
    public CaptionSize? CaptionSize { get; set; }
    /// <summary>New subtitle text pops in with a quick scale bounce.</summary>
    public bool? CaptionAnimated { get; set; }
    /// <summary>Two-person layout: the source's left half fills the top, its right half the bottom.</summary>
    public bool? SplitScreen { get; set; }
    /// <summary>Horizontal centers (0–1) of the top and bottom speakers; null uses the left and right quarters.</summary>
    public List<double>? SplitCenters { get; set; }
}

/// A Home folder: a name and the project folders inside it. Projects stay where they are on disk.
public sealed class ProjectFolder
{
    public Guid Id { get; set; } = Guid.NewGuid();
    public string Name { get; set; } = "";
    public List<string> ProjectPaths { get; set; } = [];
}

public sealed record CropKeyframe(double Time, double Position, bool? IsSceneCut = null, bool? PreserveWholeFrame = null);

public readonly record struct SourceInterval(double Start, double End);

public sealed record TimedCaption(string Text, double Start, double Duration);

public sealed record TimedSpeechWord(string Text, double Start, double Duration);

public enum CaptionStyle { Classic, Viral, Clean, HighlightBox, BoldCaps, Minimal, OneWord, Podcast, Auto }

public enum CaptionPosition { Top, Middle, Bottom }

public enum CaptionSize { Small, Medium, Large }

public enum VideoType { Auto, General, Informational, Podcast, Tutorial, Vlog, Gaming }

public static class CaptionStyles
{
    /// <summary>The styles people can pick; the retired boxed style (Clean) still decodes and draws as Simple.</summary>
    public static readonly CaptionStyle[] Choices =
        [CaptionStyle.Auto, CaptionStyle.Viral, CaptionStyle.HighlightBox, CaptionStyle.BoldCaps, CaptionStyle.OneWord, CaptionStyle.Podcast, CaptionStyle.Classic, CaptionStyle.Minimal];

    public static CaptionStyle Resolved(this CaptionStyle style, VideoType? videoType = null, bool splitScreen = false) => style switch
    {
        CaptionStyle.Clean => CaptionStyle.Classic,
        CaptionStyle.Auto when splitScreen || videoType == VideoType.Podcast => CaptionStyle.Podcast,
        CaptionStyle.Auto when videoType == VideoType.Gaming => CaptionStyle.BoldCaps,
        CaptionStyle.Auto when videoType == VideoType.Tutorial => CaptionStyle.Minimal,
        CaptionStyle.Auto => CaptionStyle.Viral,
        _ => style,
    };

    public static string Title(this CaptionStyle style) => style switch
    {
        CaptionStyle.Auto => "Auto",
        CaptionStyle.Classic or CaptionStyle.Clean => "Simple",
        CaptionStyle.Viral => "Viral highlight",
        CaptionStyle.HighlightBox => "Highlight box",
        CaptionStyle.BoldCaps => "Bold caps",
        CaptionStyle.Minimal => "Minimal",
        CaptionStyle.OneWord => "One word",
        _ => "Podcast",
    };

    public static string Detail(this CaptionStyle style) => style switch
    {
        CaptionStyle.Auto => "Prism picks the style that fits this video.",
        CaptionStyle.Classic or CaptionStyle.Clean => "White text with a black outline.",
        CaptionStyle.Viral => "Each spoken word turns yellow.",
        CaptionStyle.HighlightBox => "The spoken word sits on a yellow box.",
        CaptionStyle.BoldCaps => "Big all-caps text, three words at a time.",
        CaptionStyle.Minimal => "Smaller text on a soft dark band.",
        CaptionStyle.OneWord => "One big word at a time.",
        _ => "Soft-shadowed text; the spoken word turns green.",
    };

    /// <summary>Styles that follow each spoken word need word timing; without it they fall back to whole phrases.</summary>
    public static bool UsesWordTiming(this CaptionStyle style) =>
        style is CaptionStyle.Viral or CaptionStyle.HighlightBox or CaptionStyle.OneWord or CaptionStyle.Podcast;

    public static string Title(this CaptionPosition position) => position.ToString();

    /// <summary>Bottom edge of the subtitle layer in the 1080×1920 frame, measured from the bottom.</summary>
    public static double Y(this CaptionPosition position) => position switch
    {
        CaptionPosition.Top => 1460,
        CaptionPosition.Middle => 855,
        _ => 330,
    };

    public static string Title(this CaptionSize size) => size.ToString();

    public static double Scale(this CaptionSize size) => size switch
    {
        CaptionSize.Small => 0.8,
        CaptionSize.Large => 1.25,
        _ => 1,
    };
}

public static class VideoTypes
{
    public static readonly VideoType[] All = Enum.GetValues<VideoType>();

    public static string Title(this VideoType type) => type switch
    {
        VideoType.Auto => "Auto-detect",
        VideoType.General => "Any video",
        VideoType.Informational => "Informational / explainer",
        VideoType.Podcast => "Podcast / interview",
        VideoType.Tutorial => "Tutorial / screen",
        VideoType.Vlog => "Vlog / talking head",
        _ => "Gaming / stream",
    };

    public static string Detail(this VideoType type) => type switch
    {
        VideoType.Auto => "Prism decides from what is said in the video.",
        VideoType.General => "No special rules. Good for mixed content.",
        VideoType.Informational => "Facts and explanations. Each Short keeps one idea with its setup and payoff.",
        VideoType.Podcast => "Two people talking. Split screen: one person on top, one on the bottom, captions in the middle.",
        VideoType.Tutorial => "Screen recordings and lessons. The whole screen stays visible.",
        VideoType.Vlog => "One person talking to camera. The crop follows them.",
        _ => "Gameplay and streams. The whole game stays visible.",
    };

    /// <summary>Screen recordings and gameplay lose their edges in a vertical crop, so they always show the whole frame.</summary>
    public static bool ForcesFit(this VideoType type) => type is VideoType.Tutorial or VideoType.Gaming;

    /// <summary>Added to the AI's instructions: what makes a strong Short for this kind of video.</summary>
    public static string SelectionGuidance(this VideoType type) => type switch
    {
        VideoType.Informational => "This is an informational or explainer video. Favor one clear fact, insight or explanation per clip, with the setup that makes it understandable and its payoff. Prefer the 'track' layout on the speaker.",
        VideoType.Podcast => "This is a podcast or interview. Favor strong opinions, surprising answers, complete stories and quotable lines; keep the question when the answer needs it. Prefer the 'track' layout so the speaker stays in frame.",
        VideoType.Tutorial => "This is a tutorial or screen recording. Favor one complete step, tip or result per clip, including what it achieves. Use the 'fit' layout so the whole screen stays readable.",
        VideoType.Vlog => "This is a vlog or talking-head video. Favor clear hooks, personal moments, reactions and payoffs told to camera. Prefer the 'track' layout on the person.",
        VideoType.Gaming => "This is gameplay or a stream. Favor wins, fails, clutch plays, funny reactions and hype moments, with enough lead-up to understand them. Use the 'fit' layout so the game and facecam stay visible.",
        _ => "",
    };
}

/// Gemini's sentence transcript of one source range.
public sealed class SentenceTranscript
{
    public double Start { get; set; }
    public double End { get; set; }
    public List<TimedCaption> Cues { get; set; } = [];

    public SentenceTranscript() { }
    public SentenceTranscript(double start, double end, List<TimedCaption> cues) { Start = start; End = end; Cues = cues; }

    /// <summary>The cues inside the interval, or null when this transcript doesn't cover all of it.</summary>
    public List<TimedCaption>? CuesCovering(double start, double end)
    {
        if (Start > start + 0.01 || End < end - 0.01) return null;
        return Cues.Where(c => c.Start >= start - 0.001 && c.Start + c.Duration <= end + 0.001).ToList();
    }
}

public sealed class ProjectData
{
    public Guid Id { get; set; } = Guid.NewGuid();
    public string Name { get; set; } = "";
    public List<MediaItem> Media { get; set; } = [];
    public List<EditSegment> Segments { get; set; } = [];
    public string Memory { get; set; } = "";
    public DateTime Created { get; set; } = DateTime.UtcNow;
    /// <summary>A name the person chose; older projects have none.</summary>
    public string? Title { get; set; }
    /// <summary>Cloud sentence transcripts by media ID, so later runs on the same video skip transcription.</summary>
    public Dictionary<string, SentenceTranscript>? Transcripts { get; set; }

    /// <summary>The chosen name, else the first Short's title, else the video's name, else the folder name.</summary>
    [JsonIgnore]
    public string DisplayTitle
    {
        get
        {
            if (!string.IsNullOrEmpty(Title)) return Title;
            var clipTitle = Segments.FirstOrDefault(s => !string.IsNullOrEmpty(s.SuggestedTitle))?.SuggestedTitle;
            if (clipTitle != null) return clipTitle;
            var video = Media.FirstOrDefault(m => m.Kind == "video");
            if (video != null) return System.IO.Path.GetFileNameWithoutExtension(video.Name);
            return Name;
        }
    }
}

/// Which part of the video Shorts are taken from.
public enum SourceRegion { EntireVideo, FirstHalf, LastHalf, Custom }

public static class SourceRegions
{
    public static string Title(this SourceRegion region) => region switch
    {
        SourceRegion.EntireVideo => "Entire video",
        SourceRegion.FirstHalf => "First half",
        SourceRegion.LastHalf => "Last half",
        _ => "Custom range",
    };

    public static (double Start, double End) Interval(this SourceRegion region, double videoDuration, double? customStart = null, double? customEnd = null)
    {
        if (!double.IsFinite(videoDuration) || videoDuration <= 0) throw new ShortMakerException(ShortMakerFailure.InvalidRange);
        return region switch
        {
            SourceRegion.EntireVideo => (0, videoDuration),
            SourceRegion.FirstHalf => (0, videoDuration / 2),
            SourceRegion.LastHalf => (videoDuration / 2, videoDuration),
            _ => customStart is { } s && customEnd is { } e && double.IsFinite(s) && double.IsFinite(e) && s >= 0 && e > s && e <= videoDuration
                ? (s, e)
                : throw new ShortMakerException(ShortMakerFailure.InvalidRange),
        };
    }
}

/// Output quality for exported Shorts. Every Short is composed at 1080×1920; quality sets the file's size and codec.
public enum ExportQuality { Full, Compact, Small }

public static class ExportQualities
{
    public static string Title(this ExportQuality quality) => quality switch
    {
        ExportQuality.Full => "1080p · H.264",
        ExportQuality.Compact => "1080p · HEVC",
        _ => "720p · H.264",
    };

    public static string Detail(this ExportQuality quality) => quality switch
    {
        ExportQuality.Full => "Best quality. Plays everywhere.",
        ExportQuality.Compact => "Same quality, smaller files. Plays on recent phones and apps.",
        _ => "Smallest files, fastest to send.",
    };

    public static string Resolution(this ExportQuality quality) => quality == ExportQuality.Small ? "720 × 1280" : "1080 × 1920";
    public static string Codec(this ExportQuality quality) => quality == ExportQuality.Compact ? "HEVC" : "H.264";
}

/// The result of analysis: one Short before it becomes an <see cref="EditSegment"/>.
public sealed record ShortResult(
    double Start, double Duration, string Caption, List<TimedCaption> Captions, List<CropKeyframe> CropKeyframes,
    List<TimedSpeechWord> SpeechWords, string? AnalysisWarning, string? SuggestedTitle, string? SelectionReason, bool FitToFrame, VideoType VideoType = VideoType.General, int? Score = null);
