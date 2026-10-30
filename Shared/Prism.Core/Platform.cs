using System.Runtime.InteropServices;

namespace Prism.Core;

/// Where a secret such as the Prism account's sign-in is kept: Windows protects it with DPAPI, Linux uses the Secret Service when available.
public interface IKeyStore
{
    /// <summary>The saved secret, or an empty string.</summary>
    string Read();
    /// <summary>Saves the secret; an empty one removes it.</summary>
    void Save(string key);
}

/// What each system does its own way.
public interface IPlatform
{
    /// <summary>Where the Prism account's sign-in is kept.</summary>
    IKeyStore AccountStore { get; }
    /// <summary>Moves a project folder to the Recycle Bin or Trash, where it can be restored. Throws when that fails.</summary>
    void MoveToTrash(string path);
    /// <summary>Shows the files selected in Explorer or the file manager.</summary>
    void Reveal(IReadOnlyList<string> paths);
    void OpenFolder(string path);
    string DownloadsFolder { get; }
}

/// The player the editor shows; the app's player implements it so edits can read the playhead.
public interface IPreviewPlayer
{
    double CurrentTime { get; }
    void Seek(double seconds);
    void TogglePlayback();
    /// <summary>Synchronously release the current file before its project is moved or closed.</summary>
    void Clear() { }
}

/// RAM and disk use for the sidebar.
public sealed record MachineProfile(int MemoryGB, double MemoryUsedGB, int FreeGB, int StorageGB, int Cores, string OS)
{
    public double MemoryUsage => Math.Clamp(MemoryUsedGB / Math.Max(MemoryGB, 1), 0, 1);
    public double FreeStorageRatio => Math.Clamp((double)FreeGB / Math.Max(StorageGB, 1), 0, 1);

    public static MachineProfile Detect()
    {
        double totalBytes = 0, availableBytes = 0;
        try
        {
            if (OperatingSystem.IsWindows())
            {
                var status = new MemoryStatus { Length = (uint)Marshal.SizeOf<MemoryStatus>() };
                if (GlobalMemoryStatusEx(ref status)) { totalBytes = status.TotalPhysical; availableBytes = status.AvailablePhysical; }
            }
            else if (File.Exists("/proc/meminfo"))
            {
                foreach (var line in File.ReadLines("/proc/meminfo"))
                {
                    var parts = line.Split(' ', StringSplitOptions.RemoveEmptyEntries);
                    if (parts.Length < 2 || !double.TryParse(parts[1], out var kilobytes)) continue;
                    if (parts[0] == "MemTotal:") totalBytes = kilobytes * 1024;
                    if (parts[0] == "MemAvailable:") availableBytes = kilobytes * 1024;
                }
            }
            else totalBytes = GC.GetGCMemoryInfo().TotalAvailableMemoryBytes;
        }
        catch (Exception) { }
        long free = 0, size = 0;
        try
        {
            var drive = new DriveInfo(Path.GetPathRoot(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile)) ?? "/");
            free = drive.AvailableFreeSpace;
            size = drive.TotalSize;
        }
        catch (Exception) { }
        const double gigabyte = 1_073_741_824;
        return new MachineProfile((int)Math.Round(totalBytes / gigabyte), Math.Max(0, (totalBytes - availableBytes) / gigabyte),
            (int)(free / gigabyte), (int)(size / gigabyte), Environment.ProcessorCount, RuntimeInformation.OSDescription);
    }

    [StructLayout(LayoutKind.Sequential)]
    struct MemoryStatus
    {
        public uint Length, MemoryLoad;
        public ulong TotalPhysical, AvailablePhysical, TotalPageFile, AvailablePageFile, TotalVirtual, AvailableVirtual, AvailableExtendedVirtual;
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    static extern bool GlobalMemoryStatusEx(ref MemoryStatus status);
}

/// A project as Home shows it: its title, Short count and a frame from its first Short.
public sealed record ProjectSummary(string Title, double? Duration, int ShortCount, DateTime? Created, byte[]? Poster);

/// Read-only facts about a project for its stats sheet.
public sealed record ProjectStats(string Title, DateTime Created, int ShortCount, double ShortsSeconds, int ExportCount,
                                  string? SourceName, double? SourceSeconds, string? Resolution, long Bytes);

public static class ProjectInfo
{
    public static async Task<ProjectSummary> Summary(string path, CancellationToken cancellation = default)
    {
        var project = ProjectStore.ReadProject(path);
        if (project is null) return new ProjectSummary(Path.GetFileNameWithoutExtension(path), null, 0, null, null);
        var video = project.Media.FirstOrDefault(m => m.Kind == "video");
        byte[]? poster = null;
        if (video is not null)
        {
            // Moved projects keep their media inside the project folder.
            var source = File.Exists(video.Path) ? video.Path : Path.Combine(path, "Media", video.Name);
            var first = project.Segments.FirstOrDefault();
            var time = first is null ? 1 : first.Start + Math.Min(1, first.Duration / 2);
            if (FFmpeg.IsAvailable) poster = await FFmpeg.FrameJpeg(source, time, 480, cancellation);
        }
        return new ProjectSummary(project.DisplayTitle, video?.Duration, project.Segments.Count, project.Created, poster);
    }

    public static ProjectStats? Stats(string path)
    {
        var project = ProjectStore.ReadProject(path);
        if (project is null) return null;
        var video = project.Media.FirstOrDefault(m => m.Kind == "video");
        var exports = Directory.Exists(Path.Combine(path, "Exports")) ? Directory.GetFiles(Path.Combine(path, "Exports"), "*.mp4").Length : 0;
        long bytes = 0;
        try { bytes = new DirectoryInfo(path).EnumerateFiles("*", SearchOption.AllDirectories).Sum(f => f.Length); } catch (Exception) { }
        return new ProjectStats(project.DisplayTitle, project.Created, project.Segments.Count, project.Segments.Sum(s => s.Duration), exports,
            video?.Name, video?.Duration, video is { Width: > 0 } v ? $"{v.Width} × {v.Height}" : null, bytes);
    }

    /// <summary>How many Shorts each project has, for sorting finished from unfinished on Home.</summary>
    public static Dictionary<string, int> ShortCounts(IEnumerable<string> paths) =>
        paths.Distinct(AppPaths.PathComparer).Select(p => (p, ProjectStore.ReadProject(p))).Where(x => x.Item2 is not null)
             .ToDictionary(x => x.p, x => x.Item2!.Segments.Count, AppPaths.PathComparer);
}

/// Formatting shared by both apps.
public static class Format
{
    public static string Clock(double seconds)
    {
        var total = (int)Math.Max(0, double.IsFinite(seconds) ? seconds : 0);
        return $"{total / 60:00}:{total % 60:00}";
    }

    public static string Duration(double seconds)
    {
        var total = Math.Max(0, (int)Math.Round(seconds));
        return total >= 3600 ? $"{total / 3600}:{total / 60 % 60:00}:{total % 60:00}" : $"{total / 60}:{total % 60:00}";
    }

    public static string Bytes(long bytes)
    {
        string[] units = ["bytes", "KB", "MB", "GB", "TB"];
        double value = bytes;
        var unit = 0;
        while (value >= 1000 && unit < units.Length - 1) { value /= 1000; unit++; }
        return unit == 0 ? $"{bytes} bytes" : $"{value:0.#} {units[unit]}";
    }
}
