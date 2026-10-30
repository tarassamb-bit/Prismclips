namespace Prism.Core;

public enum ShortMakerFailure { NoVideo, CannotExport, InvalidRange, DestinationExists }

public sealed class ShortMakerException(ShortMakerFailure failure, string? detail = null) : Exception(Describe(failure, detail))
{
    public ShortMakerFailure Failure { get; } = failure;

    static string Describe(ShortMakerFailure failure, string? detail) => failure switch
    {
        ShortMakerFailure.NoVideo => "No playable video track was found.",
        ShortMakerFailure.CannotExport => "The video encoder could not complete the render." + (detail is null ? "" : " " + detail),
        ShortMakerFailure.InvalidRange => "The edit contains an invalid time range. Choose a range within the source video.",
        _ => "A file already exists at the export destination. Choose another filename.",
    };
}

public enum GeminiFailure { SignIn, UsageLimit, Request, InvalidResponse, InvalidTiming, NoDistinctClips, NoStrongClips, AudioExport, RequestTooLarge }

/// <param name="reason">The server's own explanation, shown instead of the generic text when it sent one.</param>
public sealed class GeminiException(GeminiFailure failure, int status = 0, string? reason = null) : Exception(reason ?? Describe(failure, status))
{
    public GeminiFailure Failure { get; } = failure;
    /// <summary>The HTTP status for <see cref="GeminiFailure.Request"/> and <see cref="GeminiFailure.UsageLimit"/>.</summary>
    public int Status { get; } = status;

    static string Describe(GeminiFailure failure, int status) => failure switch
    {
        GeminiFailure.SignIn => "Sign in to your Prism account to use Prism AI.",
        GeminiFailure.UsageLimit => "You've reached your beta usage limit. Ask for a promo code to get more, then enter it in Settings › Usage.",
        GeminiFailure.AudioExport => "Could not prepare audio for Prism AI. Your existing Shorts were kept.",
        GeminiFailure.RequestTooLarge => "This Prism AI request exceeds the safe upload size. Choose a shorter source region.",
        GeminiFailure.NoDistinctClips => "No new distinct moments were found in this range. Try another region or length. Your existing clips were kept.",
        GeminiFailure.NoStrongClips => "Prism could not find a strong, self-contained Short in this part of the video. Try another part of the video or a different clip length.",
        GeminiFailure.InvalidTiming => "Prism AI returned speech timestamps that could not be aligned safely.",
        GeminiFailure.Request => status switch
        {
            401 or 403 => "Your Prism sign-in was not accepted. Sign in again in Settings › Account.",
            429 => "Prism AI is handling too many requests right now. Wait a moment, then try again.",
            503 => "Prism AI is overloaded right now (HTTP 503). Wait a moment, then try again.",
            _ => $"Prism AI could not complete the request (HTTP {status}). Please try again.",
        },
        _ => "Prism AI returned an incomplete or invalid response. Your existing edits were kept.",
    };
}

/// A failure in one stage of a long run, kept whole so the app can tell a busy server from a sign-in problem or an unusable range.
public sealed class StageFailure(string stage, Exception underlying) : Exception($"{stage}: {underlying.Message} Your existing clips were kept.", underlying)
{
    public string Stage { get; } = stage;
    public Exception Underlying { get; } = underlying;
}
