using System.Security.Cryptography;
using System.Text;

namespace Prism.Core;

/// How a video is named to Prism's server and how long it counts, as in the macOS app. The server enforces the allowance.
public static class UsageLimit
{
    /// <summary>Minutes of video a beta account starts with; promo codes add more on the server.</summary>
    public const int Allowance = 60;

    /// <summary>Two imports of the same file count as one video.</summary>
    public static string VideoKey(MediaItem media) => $"{media.Name}|{(long)Math.Round(media.Duration, MidpointRounding.AwayFromZero)}";

    /// <summary>What Supabase stores: the content hash, or for videos without one a SHA-256 of the video key; the file name never leaves the computer.</summary>
    public static string ServerKey(MediaItem media) => media.ContentHash ?? Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(VideoKey(media))));

    public static double Minutes(MediaItem media) => media.Duration / 60;

    /// <summary>SHA-256 of the file's bytes as lowercase hex, the same value the Mac app computes for the same file.</summary>
    public static async Task<string> ContentHash(string path, CancellationToken cancellation = default)
    {
        await using var file = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read, 1 << 20, useAsync: true);
        return Convert.ToHexStringLower(await SHA256.HashDataAsync(file, cancellation));
    }
}
