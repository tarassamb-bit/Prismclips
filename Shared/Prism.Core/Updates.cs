using System.ComponentModel;
using System.Net.Http.Headers;
using System.Runtime.CompilerServices;
using System.Security.Cryptography;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace Prism.Core;

/// Updates from the GitHub releases that .github/workflows/release.yml publishes, the Windows counterpart of the Mac's Sparkle
/// updater. Prism checks on launch and every few hours, downloads the installer in the background, verifies it against the
/// release's SHA256SUMS.txt and then offers "Restart to update".
public sealed partial class AppUpdater : INotifyPropertyChanged
{
    public const string Repository = "tarassamb-bit/Prismclips";
    public static readonly TimeSpan CheckInterval = TimeSpan.FromHours(6);

    readonly AppSettings settings;
    readonly string asset;
    readonly HttpClient client;
    readonly SemaphoreSlim checking = new(1, 1);

    public event PropertyChangedEventHandler? PropertyChanged;
    /// <summary>The running version, e.g. 0.2.0.</summary>
    public string Version { get; }
    /// <summary>Only an installed release updates; a development build never does.</summary>
    public bool IsEnabled { get; }

    string? readyVersion, readyInstaller, updatedVersion, availableVersion, checkResult;
    List<string> releaseNotes = [], updatedNotes = [], availableNotes = [];
    bool isBannerDismissed;
    /// <summary>The downloaded, verified update waiting for a restart.</summary>
    public string? ReadyVersion { get => readyVersion; private set => Set(ref readyVersion, value); }
    public string? ReadyInstaller { get => readyInstaller; private set => Set(ref readyInstaller, value); }
    public List<string> ReleaseNotes { get => releaseNotes; private set => Set(ref releaseNotes, value); }
    public bool IsBannerDismissed { get => isBannerDismissed; set => Set(ref isBannerDismissed, value); }
    /// <summary>Set on the first launch after an update: the new version and what changed, until the person dismisses it.</summary>
    public string? UpdatedVersion { get => updatedVersion; set => Set(ref updatedVersion, value); }
    public List<string> UpdatedNotes { get => updatedNotes; private set => Set(ref updatedNotes, value); }
    /// <summary>A newer version the last check found, while it downloads.</summary>
    public string? AvailableVersion { get => availableVersion; private set => Set(ref availableVersion, value); }
    public List<string> AvailableNotes { get => availableNotes; private set => Set(ref availableNotes, value); }
    /// <summary>What the last check said when nothing is pending, e.g. "You're up to date."</summary>
    public string? CheckResult { get => checkResult; private set => Set(ref checkResult, value); }
    public DateTime? LastCheck => settings.LastUpdateCheck;
    public IReadOnlyList<ReleaseRecord> History => settings.UpdateHistory;

    /// <param name="asset">The release file this system installs, e.g. Prism-Windows-Setup.exe.</param>
    public AppUpdater(AppSettings settings, string version, bool enabled, string asset, HttpMessageHandler? network = null)
    {
        this.settings = settings;
        this.asset = asset;
        Version = version;
        IsEnabled = enabled;
        client = network is null ? new HttpClient() : new HttpClient(network, disposeHandler: false);
        client.Timeout = TimeSpan.FromMinutes(10);
        client.DefaultRequestHeaders.UserAgent.Add(new ProductInfoHeaderValue("Prism", version));
        ShowWhatChangedIfJustUpdated();
    }

    /// <summary>Checks the latest release; a newer one is downloaded and verified before it is offered.</summary>
    public async Task CheckForUpdates()
    {
        if (!IsEnabled || !await checking.WaitAsync(0)) return;
        try
        {
            using var response = await client.GetAsync($"https://api.github.com/repos/{Repository}/releases/latest");
            settings.LastUpdateCheck = DateTime.Now;
            settings.Save();
            if (!response.IsSuccessStatusCode) { CheckResult = $"Couldn't check for updates (HTTP {(int)response.StatusCode})."; return; }
            var release = JsonNode.Parse(await response.Content.ReadAsStringAsync()) as JsonObject;
            var tag = release?["tag_name"]?.GetValue<string>() ?? "";
            var version = tag.TrimStart('v', 'V');
            if (!IsNewer(version, Version)) { AvailableVersion = null; AvailableNotes = []; CheckResult = "You're up to date."; return; }
            var notes = NoteLines(release?["body"]?.GetValue<string>());
            if (ReadyVersion == version) return;
            string? Download(string name) => (release?["assets"] as JsonArray)?.OfType<JsonObject>()
                .FirstOrDefault(item => item["name"]?.GetValue<string>() == name)?["browser_download_url"]?.GetValue<string>();
            if (Download(asset) is not { } installerUrl || Download("SHA256SUMS.txt") is not { } sumsUrl)
            { CheckResult = $"Prism {version} is out, but its installer is missing."; return; }
            AvailableVersion = version; AvailableNotes = notes; CheckResult = null;
            var sums = await client.GetStringAsync(sumsUrl);
            var expected = Regex.Match(sums, @"^([0-9a-fA-F]{64})\s+\*?" + Regex.Escape(asset) + @"\s*$", RegexOptions.Multiline).Groups[1].Value.ToLowerInvariant();
            if (expected.Length == 0) { CheckResult = $"Prism {version} couldn't be verified, so it wasn't installed."; AvailableVersion = null; return; }
            var folder = Path.Combine(Path.GetTempPath(), "Prism-update");
            Directory.CreateDirectory(folder);
            var path = Path.Combine(folder, $"{Path.GetFileNameWithoutExtension(asset)}-{version}{Path.GetExtension(asset)}");
            await using (var download = await client.GetStreamAsync(installerUrl))
            await using (var file = File.Create(path)) await download.CopyToAsync(file);
            string actual;
            await using (var file = File.OpenRead(path)) actual = Convert.ToHexStringLower(await SHA256.HashDataAsync(file));
            if (actual != expected)
            {
                File.Delete(path);
                CheckResult = $"Prism {version} didn't match its checksum, so it wasn't installed."; AvailableVersion = null; return;
            }
            AvailableVersion = null; AvailableNotes = [];
            ReleaseNotes = notes; ReadyInstaller = path; IsBannerDismissed = false; ReadyVersion = version;
        }
        catch (Exception error) { CheckResult = "Couldn't check for updates: " + error.Message; }
        finally { checking.Release(); }
    }

    /// <summary>Remembers the update before the installer replaces Prism, so the relaunched app can say what changed. Returns the installer.</summary>
    public string? PrepareInstall()
    {
        if (ReadyInstaller is not { } installer || !File.Exists(installer)) return null;
        settings.PendingUpdateVersion = ReadyVersion;
        settings.PendingUpdateNotes = [.. ReleaseNotes];
        settings.Save();
        return installer;
    }

    /// After a relaunch into the version that was waiting, shows its notes once and forgets them.
    void ShowWhatChangedIfJustUpdated()
    {
        // The first launch of each version is recorded with the notes it was installed with.
        if (settings.UpdateHistory.LastOrDefault()?.Version != Version)
        {
            var notes = settings.PendingUpdateVersion == Version ? settings.PendingUpdateNotes : [];
            settings.UpdateHistory = [.. settings.UpdateHistory.Append(new ReleaseRecord(Version, [.. notes])).TakeLast(12)];
            settings.Save();
        }
        if (settings.PendingUpdateVersion != Version) return;
        UpdatedVersion = Version;
        UpdatedNotes = [.. settings.PendingUpdateNotes];
        settings.PendingUpdateVersion = null;
        settings.PendingUpdateNotes = [];
        settings.Save();
    }

    /// <summary>Whether <paramref name="candidate"/> (e.g. 0.3.0) is a later version than <paramref name="current"/>.</summary>
    public static bool IsNewer(string candidate, string current)
        => System.Version.TryParse(Pad(candidate), out var next) && System.Version.TryParse(Pad(current), out var now) && next > now;

    static string Pad(string version)
    {
        var core = version.Split('-', '+')[0];
        return core.Count(c => c == '.') == 0 ? core + ".0" : core;
    }

    /// <summary>Release notes as at most three short lines: list items, or else lines of text, without Markdown or HTML.</summary>
    public static List<string> NoteLines(string? body)
    {
        if (string.IsNullOrWhiteSpace(body)) return [];
        var lines = body.Split('\n').Select(line => line.Trim()).ToList();
        var items = lines.Where(line => line.StartsWith("- ") || line.StartsWith("* ")).ToList();
        return (items.Count > 0 ? items.Select(line => line[2..]) : lines.Where(line => !line.StartsWith('#')))
            .Select(line => Markup().Replace(line, "").Trim())
            .Where(line => line.Length > 0)
            .Take(3).ToList();
    }

    [GeneratedRegex(@"<[^>]+>|\*\*|__|`|\[|\]\([^)]*\)")]
    private static partial Regex Markup();

    void Set<T>(ref T field, T value, [CallerMemberName] string? name = null)
    {
        if (EqualityComparer<T>.Default.Equals(field, value)) return;
        field = value;
        PropertyChanged?.Invoke(this, new PropertyChangedEventArgs(name));
    }
}
