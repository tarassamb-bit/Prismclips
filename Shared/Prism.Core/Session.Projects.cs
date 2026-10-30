using System.Globalization;

namespace Prism.Core;

public sealed partial class AppSession
{
    /// <summary>Video files Prism imports; ffmpeg reads them all.</summary>
    public static readonly string[] VideoExtensions = ["mov", "mp4", "m4v", "avi", "mkv", "webm"];

    void ResetPreview()
    {
        previewCancellation?.Cancel();
        Player?.Clear();
        Selection = null;
        PreviewShortId = null;
        PreviewPath = null;
        PreviewSegment = null;
        IsPreviewLoading = false;
        PreviewError = null;
        previewRevision += 1;
    }

    public void Create()
    {
        if (IsBusy) return;
        var name = "Video " + DateTime.Now.ToString("yyyy-MM-dd HH-mm-ss", CultureInfo.InvariantCulture);
        var path = Path.Combine(AppPaths.Projects, $"{name} {Guid.NewGuid():N}.relio");
        ProjectStore? created = null;
        try
        {
            Directory.CreateDirectory(Path.Combine(path, "Media"));
            Directory.CreateDirectory(Path.Combine(path, "Exports"));
            created = new ProjectStore(path);
            var next = new ProjectData { Name = name };
            created.Save(next, "project");
            store?.Dispose();
            store = created;
            created = null;
            ProjectPath = path;
            ResetPreview();
            SourcePath = "";
            editHistory = [];
            ClearRedo();
            Changed(nameof(CanUndo));
            ExportedFiles = [];
            LastExportFolder = null;
            chatMessages = [];
            Changed(nameof(ChatMessages));
            Project = next;
            LastSavedAt = DateTime.Now;
            Settings.LastProject = path;
            Remember(path);
            Screen = Screen.Editor;
            Message = "Import a long video to make your first Short.";
        }
        catch (Exception error) { Message = $"Could not create project: {error.Message}"; }
        finally { created?.Dispose(); }
    }

    public void StartLongVideoToShort()
    {
        if (IsBusy) return;
        IsStartingNewVideo = true;
        Screen = Screen.ImportSource;
        SourcePath = "";
        Message = "Upload a video to begin.";
    }

    public void Open(string path)
    {
        if (IsBusy) return;
        ProjectStore? opened = null;
        try
        {
            opened = new ProjectStore(path, create: false);
            var loaded = opened.Load<ProjectData>("project");
            if (loaded is null) throw new StoreException("The project database could not be read.");
            // Resolve managed assets relative to the project when a project folder is moved, even from another computer.
            foreach (var media in loaded.Media)
            {
                var relocated = Path.Combine(path, "Media", FileName(media.Path));
                if (File.Exists(relocated)) media.Path = relocated;
                if (media.Thumbnail is { } thumbnail)
                {
                    var relocatedThumbnail = Path.Combine(path, "Thumbnails", FileName(thumbnail));
                    if (File.Exists(relocatedThumbnail)) media.Thumbnail = relocatedThumbnail;
                }
            }
            store?.Dispose();
            store = opened;
            opened = null;
            editHistory = [];
            ClearRedo();
            Changed(nameof(CanUndo));
            ExportedFiles = [];
            LastExportFolder = null;
            chatMessages = [];
            Changed(nameof(ChatMessages));
            ResetPreview();
            Project = loaded;
            ProjectPath = path;
            Selection = loaded.Media.FirstOrDefault()?.Id;
            LastSavedAt = File.GetLastWriteTime(Path.Combine(path, "project.sqlite"));
            Settings.LastProject = path;
            Remember(path);
            Screen = Screen.Editor;
            SelectPreview(null);
            Message = "Project ready.";
        }
        catch (Exception error) { Message = $"Could not open project: {error.Message}"; }
        finally { opened?.Dispose(); }
    }

    /// Paths saved on macOS use "/", paths saved on Windows "\"; either can appear in a moved project.
    static string FileName(string path) => MediaItem.FileName(path);

    void Remember(string path)
    {
        recentProjectPaths.RemoveAll(existing => AppPaths.PathComparer.Equals(existing, path));
        recentProjectPaths.Insert(0, path);
        Settings.RecentProjects = [.. recentProjectPaths];
        Settings.Save();
        Changed(nameof(RecentProjectPaths));
    }

    void RestoreSavedProjects()
    {
        var paths = Settings.RecentProjects.Where(Directory.Exists).Distinct(AppPaths.PathComparer).ToList();
        var known = paths.ToHashSet(AppPaths.PathComparer);
        var recovered = new List<(string Path, DateTime Created)>();
        try
        {
            foreach (var folder in Directory.GetDirectories(AppPaths.Projects, "*.relio"))
            {
                if (known.Contains(folder) || !File.Exists(Path.Combine(folder, "project.sqlite"))) continue;
                if (ProjectStore.ReadProject(folder) is { } found) recovered.Add((folder, found.Created));
            }
        }
        catch (Exception) { }
        paths.AddRange(recovered.OrderByDescending(r => r.Created).Select(r => r.Path));
        recentProjectPaths = paths;
        Settings.RecentProjects = [.. paths];
        Settings.Save();
        Changed(nameof(RecentProjectPaths));
    }

    public void Save()
    {
        if (project is null) return;
        if (store is null) throw new StoreException("Reopen this project before saving changes.");
        store.Save(project, "project");
        LastSavedAt = DateTime.Now;
    }

    /// Keeps the cloud transcript with the project; "Create more Shorts" then skips uploading and transcribing again. It's saved
    /// straight away, so it survives a later cancel or failure in the same run.
    void StoreTranscript(SentenceTranscript transcript, Guid mediaId)
    {
        if (project is null || project.Media.All(m => m.Id != mediaId)) return;
        project.Transcripts ??= [];
        var key = PrismJson.Key(mediaId);
        if (project.Transcripts.TryGetValue(key, out var existing) && existing.End - existing.Start > transcript.End - transcript.Start) return;
        project.Transcripts[key] = transcript;
        try { Save(); } catch (Exception) { }
    }

    /// The same video's cloud transcript from another project (same name, length, size and file size), so starting over with a
    /// video used before skips uploading and transcribing it again.
    SentenceTranscript? TranscriptFromOtherProjects(MediaItem video)
    {
        static long? Size(string path) { try { return new FileInfo(path).Length; } catch (Exception) { return null; } }
        var size = Size(video.Path);
        SentenceTranscript? best = null;
        foreach (var path in recentProjectPaths.Where(p => p != projectPath))
        {
            if (ProjectStore.ReadProject(path) is not { } other) continue;
            foreach (var media in other.Media.Where(m => m.Name == video.Name && Math.Abs(m.Duration - video.Duration) < 0.01
                                                         && m.Width == video.Width && m.Height == video.Height && Size(m.Path) == size))
            {
                if (other.Transcripts?.GetValueOrDefault(PrismJson.Key(media.Id)) is not { } transcript) continue;
                if (transcript.End - transcript.Start > (best is null ? -1 : best.End - best.Start)) best = transcript;
            }
        }
        return best;
    }

    // MARK: Home folders

    void SaveFolders()
    {
        Settings.Save();
        Changed(nameof(ProjectFolders));
    }

    public Guid? CreateFolder(string name)
    {
        var trimmed = name.Trim();
        if (trimmed.Length == 0) return null;
        var folder = new ProjectFolder { Name = trimmed.Length > 60 ? trimmed[..60] : trimmed };
        Settings.ProjectFolders.Add(folder);
        SaveFolders();
        return folder.Id;
    }

    public void RenameFolder(Guid id, string name)
    {
        var trimmed = name.Trim();
        if (trimmed.Length == 0 || Settings.ProjectFolders.FirstOrDefault(f => f.Id == id) is not { } folder) return;
        folder.Name = trimmed.Length > 60 ? trimmed[..60] : trimmed;
        SaveFolders();
    }

    /// <summary>Removes only the folder; its projects go back to Home.</summary>
    public void DeleteFolder(Guid id)
    {
        Settings.ProjectFolders.RemoveAll(f => f.Id == id);
        SaveFolders();
    }

    /// <summary>Puts a project in a folder (null takes it out); a project is in at most one folder.</summary>
    public void MoveProject(string path, Guid? folderId)
    {
        // Drops can carry any text; only known projects belong in folders.
        if (folderId is not null && !recentProjectPaths.Contains(path)) return;
        if (folderId is { } targetId && Settings.ProjectFolders.All(folder => folder.Id != targetId)) return;
        foreach (var folder in Settings.ProjectFolders) folder.ProjectPaths.RemoveAll(existing => AppPaths.PathComparer.Equals(existing, path));
        if (folderId is { } id && Settings.ProjectFolders.FirstOrDefault(f => f.Id == id) is { } target) target.ProjectPaths.Insert(0, path);
        SaveFolders();
    }

    public void RenameProject(string path, string newTitle)
    {
        var title = newTitle.Trim();
        if (title.Length == 0) return;
        try
        {
            // The open project is saved from memory, so it changes there too or the next save would undo the rename.
            if (projectPath == path && project is not null)
            {
                var previous = project.Title;
                project.Title = title;
                try { Save(); }
                catch { project.Title = previous; throw; }
                ProjectChanged();
            }
            else
            {
                using var other = new ProjectStore(path, create: false);
                var stored = other.Load<ProjectData>("project") ?? throw new StoreException("The project database could not be read.");
                stored.Title = title;
                other.Save(stored, "project");
            }
            ProjectListRevision += 1;
            Message = $"Renamed project to “{title}”.";
        }
        catch (Exception error) { Message = $"Could not rename project: {error.Message}"; }
    }

    /// <summary>Moves the project folder to the Recycle Bin or Trash, where it can still be restored.</summary>
    public void DeleteProject(string path)
    {
        if (IsBusy) return;
        var deletingOpen = projectPath == path;
        var previousSelection = Selection;
        var previousShort = PreviewShortId;
        try
        {
            if (deletingOpen) { ResetPreview(); store?.Dispose(); store = null; }
            platform.MoveToTrash(path);
            if (deletingOpen)
            {
                Project = null;
                ProjectPath = null;
                editHistory = [];
            ClearRedo();
                Changed(nameof(CanUndo));
                LastSavedAt = null;
                Settings.LastProject = null;
            }
            recentProjectPaths.Remove(path);
            Settings.RecentProjects = [.. recentProjectPaths];
            Changed(nameof(RecentProjectPaths));
            MoveProject(path, null);
            Message = OperatingSystem.IsWindows() ? "Moved the project to the Recycle Bin." : "Moved the project to the Trash.";
        }
        catch (Exception error)
        {
            if (deletingOpen && projectPath == path && project is not null)
            {
                try { store ??= new ProjectStore(path, create: false); } catch { }
                Selection = previousSelection;
                SelectPreview(previousShort);
            }
            Message = $"Could not delete project: {error.Message}";
        }
    }

    // MARK: Import

    public void ImportFromPath()
    {
        var typed = SourcePath.Trim().Trim('"');
        var expanded = typed.StartsWith('~') ? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), typed[1..].TrimStart('/', '\\')) : typed;
        if (!File.Exists(expanded)) { Message = "No file exists at that path."; return; }
        _ = ImportSource(expanded);
    }

    public async Task ImportSource(string path)
    {
        if (IsBusy) return;
        if (!VideoExtensions.Contains(Path.GetExtension(path).TrimStart('.').ToLowerInvariant()))
        {
            Message = "Choose a MOV, MP4, M4V, AVI, MKV or WebM video.";
            return;
        }
        if (IsStartingNewVideo || projectPath is null)
        {
            Create();
            if (Screen != Screen.Editor) return;
            Screen = Screen.ImportSource;
        }
        if (projectPath is not { } folder) return;
        SourcePath = path;
        await ImportVideo(path, folder);
    }

    async Task ImportVideo(string path, string folder)
    {
        var returnToEditor = Screen == Screen.Editor;
        IsBusy = true;
        Message = "Copying video into your Prism library…";
        var mediaDirectory = Path.Combine(folder, "Media");
        var copied = UniqueDestination(path, mediaDirectory);
        var temporary = Path.Combine(mediaDirectory, $".import-{Guid.NewGuid():N}");
        try
        {
            Directory.CreateDirectory(mediaDirectory);
            await Task.Run(() => { File.Copy(path, temporary); File.Move(temporary, copied); });
        }
        catch (Exception error)
        {
            Message = $"Could not copy video: {error.Message}";
            IsBusy = false;
            return;
        }
        finally { try { File.Delete(temporary); } catch { } }
        Message = "Reading video metadata and creating thumbnail…";
        MediaItem? item;
        try { item = await Inspect(copied, Path.Combine(folder, "Thumbnails")); }
        catch (Exception error)
        {
            try { File.Delete(copied); } catch { }
            Message = $"Could not read video: {error.Message}";
            IsBusy = false;
            return;
        }
        if (item is null || project is null)
        {
            try { File.Delete(copied); } catch { }
            Message = FFmpeg.IsAvailable ? "This video format could not be opened." : new FFmpegMissingException().Message;
            IsBusy = false;
            return;
        }
        // The hash names the video to Prism's server; without one (unreadable file) it keeps its name-based usage key.
        item.ContentHash = await HashOrNull(copied);
        // "Choose a different video" before any Shorts exist replaces the first pick; otherwise the project kept the rejected
        // copy and was named after it.
        var previousMedia = project.Media.ToList();
        var previousTranscripts = project.Transcripts is null ? null : new Dictionary<string, SentenceTranscript>(project.Transcripts);
        var replaced = !returnToEditor && project.Segments.Count == 0 ? previousMedia : [];
        project.Media = [.. previousMedia.Where(m => replaced.All(r => r.Id != m.Id)), item];
        foreach (var old in replaced) project.Transcripts?.Remove(PrismJson.Key(old.Id));
        try { Save(); }
        catch (Exception error)
        {
            project.Media = previousMedia;
            project.Transcripts = previousTranscripts;
            try { File.Delete(copied); } catch { }
            Message = $"Could not save import: {error.Message}";
            IsBusy = false;
            return;
        }
        // Only the project's own copies are deleted, never a file outside it.
        foreach (var old in replaced.SelectMany(m => new[] { m.Path, m.Thumbnail }).OfType<string>()
                                    .Where(p => Path.GetFullPath(p).StartsWith(Path.GetFullPath(folder) + Path.DirectorySeparatorChar, StringComparison.Ordinal)))
            try { File.Delete(old); } catch { }
        ProjectChanged();
        Selection = item.Id;
        ResetSourceRange(item);
        PreviewShortId = null;
        PreviewSegment = null;
        PreviewPath = copied;
        Screen = returnToEditor ? Screen.Editor : Screen.ImportSource;
        Message = returnToEditor ? "Video imported. Add a clip or create Shorts." : "Video imported. Choose your settings, then press Continue.";
        IsBusy = false;
    }

    /// <summary>Reads a video's length, size and audio, and saves a thumbnail; null for files that aren't playable video.</summary>
    static async Task<string?> HashOrNull(string path)
    {
        try { return await Task.Run(() => UsageLimit.ContentHash(path)); }
        catch (Exception) { return null; }
    }

    public static async Task<MediaItem?> Inspect(string path, string thumbnailDirectory)
    {
        if (!VideoExtensions.Contains(Path.GetExtension(path).TrimStart('.').ToLowerInvariant()) || !FFmpeg.IsAvailable) return null;
        var info = await FFmpeg.Probe(path);
        if (info is not { HasVideo: true, Width: > 0, Height: > 0 } || !double.IsFinite(info.Duration) || info.Duration <= 0) return null;
        var item = new MediaItem { Path = path, Kind = "video", Duration = info.Duration, Width = info.Width, Height = info.Height, HasAudio = info.HasAudio };
        var thumbnail = Path.Combine(thumbnailDirectory, $"{PrismJson.Key(item.Id)}.jpg");
        if (await FFmpeg.Thumbnail(path, Math.Min(info.Duration / 2, 0.5), thumbnail)) item.Thumbnail = thumbnail;
        return item;
    }

    public static string UniqueDestination(string source, string directory)
    {
        var name = Path.GetFileNameWithoutExtension(source);
        var extension = Path.GetExtension(source);
        var destination = Path.Combine(directory, Path.GetFileName(source));
        for (var index = 2; File.Exists(destination) || Directory.Exists(destination); index++) destination = Path.Combine(directory, $"{name} {index}{extension}");
        return destination;
    }

    /// <summary>A Short's title as a file name: no path or file-system-unsafe characters, at most 80 characters.</summary>
    public static string? ExportFileName(string? title)
    {
        var unsafeCharacters = "/\\:*?\"<>|";
        var cleaned = new string((title ?? "").Select(c => unsafeCharacters.Contains(c) || char.IsControl(c) ? ' ' : c).ToArray());
        cleaned = string.Join(" ", cleaned.Split(' ', StringSplitOptions.RemoveEmptyEntries)).Trim('.', ' ');
        var stem = cleaned.Split('.')[0].TrimEnd().ToUpperInvariant();
        if (stem is "CON" or "PRN" or "AUX" or "NUL" or "CONIN$" or "CONOUT$"
            || stem.Length == 4 && (stem.StartsWith("COM", StringComparison.Ordinal) || stem.StartsWith("LPT", StringComparison.Ordinal))
                && stem[3] is >= '1' and <= '9') cleaned = "_" + cleaned;
        return cleaned.Length == 0 ? null : cleaned.Length > 80 ? cleaned[..80] : cleaned;
    }

    /// <summary>"Downloads › Prism › My project" for a folder in the home folder, else the full path.</summary>
    public static string DisplayPath(string path)
    {
        var home = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile).TrimEnd(Path.DirectorySeparatorChar);
        var full = Path.GetFullPath(path);
        if (!full.StartsWith(home + Path.DirectorySeparatorChar, OperatingSystem.IsWindows() ? StringComparison.OrdinalIgnoreCase : StringComparison.Ordinal)) return full;
        return string.Join(" › ", full[(home.Length + 1)..].Split(Path.DirectorySeparatorChar, StringSplitOptions.RemoveEmptyEntries));
    }

    public void RevealLibrary() => platform.OpenFolder(AppPaths.Library);
}
