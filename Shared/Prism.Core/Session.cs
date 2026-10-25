using System.ComponentModel;
using System.Globalization;
using System.Runtime.CompilerServices;
using System.Text.Json.Nodes;

namespace Prism.Core;

public enum Screen { Home, Create, ImportSource, Editor, Settings }

public sealed record ChatMessage(bool IsUser, string Text);

public enum GenerationFailureKind { NoMoments, Settings, Temporary, Other }

/// <summary>Why the last Shorts run produced nothing. The popup's title, advice and buttons follow <see cref="Kind"/>,
/// so a busy server is never blamed on the video or its range.</summary>
public sealed record GenerationFailure(string Message, GenerationFailureKind Kind, bool IsExport = false);

/// <summary>What the export card is set to.</summary>
public sealed record ExportChoice(IReadOnlySet<Guid> ShortIds, bool IncludeSource, ExportQuality Quality, string Folder, string? Error = null);

/// Everything the Prism window shows and does, independent of the toolkit: the Windows (WPF) and Linux (GTK) apps both drive
/// this one object, a port of the macOS app's AppModel. Call it from the UI thread; it reports changes through PropertyChanged
/// on the UI thread.
public sealed partial class AppSession : INotifyPropertyChanged, IDisposable
{
    public event PropertyChangedEventHandler? PropertyChanged;
    readonly SynchronizationContext? context;
    readonly IPlatform platform;
    public AppSettings Settings { get; }
    /// <summary>The optional Prism account that counts exports on the website.</summary>
    public Account Account { get; }

    public AppSession(IPlatform platform, AppSettings? settings = null)
    {
        this.platform = platform;
        context = SynchronizationContext.Current;
        Settings = settings ?? AppSettings.Load();
        isGeminiKeySaved = Settings.GeminiKeySaved;
        geminiKeyStatus = isGeminiKeySaved ? "Your API key is saved securely. For security, the saved value stays hidden." : "";
        geminiModel = Settings.GeminiModel;
        Account = new Account(platform.AccountStore);
        Account.PropertyChanged += (_, _) => Post(() => Changed(nameof(Account)));
        Directory.CreateDirectory(AppPaths.Projects);
        RestoreSavedProjects();
    }

    void Changed([CallerMemberName] string? name = null) => PropertyChanged?.Invoke(this, new PropertyChangedEventArgs(name));

    bool Set<T>(ref T field, T value, [CallerMemberName] string? name = null)
    {
        if (EqualityComparer<T>.Default.Equals(field, value)) return false;
        field = value;
        Changed(name);
        return true;
    }

    /// Runs on the UI thread; work finishing on a background thread hops back before touching state.
    void Post(Action action)
    {
        if (context is null || SynchronizationContext.Current == context) action();
        else context.Post(_ => action(), null);
    }

    // MARK: State

    Screen screen = Screen.Home;
    public Screen Screen
    {
        get => screen;
        set { if (Set(ref screen, value) && value == Screen.Editor) IsStartingNewVideo = false; }
    }

    bool isStartingNewVideo;
    public bool IsStartingNewVideo { get => isStartingNewVideo; set => Set(ref isStartingNewVideo, value); }

    bool isPlayerExpanded;
    /// <summary>The preview fills the app window.</summary>
    public bool IsPlayerExpanded { get => isPlayerExpanded; set => Set(ref isPlayerExpanded, value); }

    ProjectData? project;
    public ProjectData? Project { get => project; private set { project = value; Changed(); } }
    /// <summary>Raised after the open project's Shorts, media or title change.</summary>
    void ProjectChanged() => Changed(nameof(Project));

    string? projectPath;
    public string? ProjectPath { get => projectPath; private set => Set(ref projectPath, value); }
    ProjectStore? store;

    string message = "Create a project to begin.";
    public string Message { get => message; set => Set(ref message, value); }

    bool isBusy;
    public bool IsBusy { get => isBusy; set => Set(ref isBusy, value); }

    double? generationProgress;
    public double? GenerationProgress
    {
        get => generationProgress;
        set
        {
            if (generationProgress is null && value is not null) GenerationStartedAt = DateTime.Now;
            Set(ref generationProgress, value);
        }
    }

    DateTime generationStartedAt = DateTime.Now;
    public DateTime GenerationStartedAt { get => generationStartedAt; private set => Set(ref generationStartedAt, value); }

    string generationStage = "";
    public string GenerationStage { get => generationStage; set => Set(ref generationStage, value); }

    GenerationFailure? generationError;
    public GenerationFailure? GenerationError { get => generationError; set => Set(ref generationError, value); }

    bool isExporting;
    /// <summary>Export uses the progress popup too, but its Cancel keeps you in the editor.</summary>
    public bool IsExporting { get => isExporting; private set => Set(ref isExporting, value); }

    string? exportSummary;
    /// <summary>Set when an export finishes; shown as a popup with a file manager shortcut.</summary>
    public string? ExportSummary { get => exportSummary; set => Set(ref exportSummary, value); }

    ExportChoice? exportChoice;
    public ExportChoice? ExportChoice { get => exportChoice; set => Set(ref exportChoice, value); }

    string? lastExportFolder;
    public string? LastExportFolder { get => lastExportFolder; private set => Set(ref lastExportFolder, value); }
    public ExportQuality LastExportQuality { get; private set; } = ExportQuality.Full;
    public int LastExportShortCount { get; private set; }

    /// <summary>Set when an overloaded model handed requests to another model during the current task.</summary>
    public string? ModelFallbackNote { get; private set; }

    Guid? selection;
    /// <summary>The source video the editor shows.</summary>
    public Guid? Selection { get => selection; set => Set(ref selection, value); }

    Guid? previewShortId;
    public Guid? PreviewShortId { get => previewShortId; private set => Set(ref previewShortId, value); }

    int previewRevision;
    string? previewPath;
    /// <summary>The file the player should show: the source video, or the selected Short's rendered preview.</summary>
    public string? PreviewPath { get => previewPath; private set => Set(ref previewPath, value); }

    EditSegment? previewSegment;
    /// <summary>The Short the player shows, or null for the source video.</summary>
    public EditSegment? PreviewSegment { get => previewSegment; private set => Set(ref previewSegment, value); }

    bool isPreviewLoading;
    public bool IsPreviewLoading { get => isPreviewLoading; private set => Set(ref isPreviewLoading, value); }

    string? previewError;
    public string? PreviewError { get => previewError; private set => Set(ref previewError, value); }

    int? subjectTrackingRevision;
    CancellationTokenSource? previewCancellation;
    public List<string> ExportedFiles { get; private set; } = [];

    /// <summary>The app's player, so edits can read the playhead.</summary>
    public IPreviewPlayer? Player { get; set; }

    DateTime? lastSavedAt;
    /// <summary>When the open project last reached disk; the editor header shows it so saving is visible.</summary>
    public DateTime? LastSavedAt { get => lastSavedAt; private set => Set(ref lastSavedAt, value); }

    string sourcePath = "";
    public string SourcePath { get => sourcePath; set => Set(ref sourcePath, value); }

    // Gemini key and model

    string geminiModel;
    public string GeminiModel
    {
        get => geminiModel;
        set { if (Set(ref geminiModel, value)) { Settings.GeminiModel = value; Settings.Save(); } }
    }

    string geminiKey = "";
    /// <summary>The key typed into the key card or Settings; cleared after saving.</summary>
    public string GeminiKey { get => geminiKey; set => Set(ref geminiKey, value); }

    string revealedGeminiKey = "";
    public string RevealedGeminiKey { get => revealedGeminiKey; private set => Set(ref revealedGeminiKey, value); }
    string cachedGeminiKey = "";
    /// <summary>Tests set this so the session never reads the person's real key or calls Gemini.</summary>
    public bool DidLoadGeminiKey { get; set; }

    bool isGeminiKeySaved;
    /// <summary>False shows the key card over the whole app: Prism can't work without Gemini.</summary>
    public bool IsGeminiKeySaved { get => isGeminiKeySaved; set => Set(ref isGeminiKeySaved, value); }

    bool isEditingGeminiKey;
    public bool IsEditingGeminiKey { get => isEditingGeminiKey; private set => Set(ref isEditingGeminiKey, value); }

    bool isShowingGeminiKey;
    public bool IsShowingGeminiKey { get => isShowingGeminiKey; private set => Set(ref isShowingGeminiKey, value); }

    string geminiKeyStatus;
    public string GeminiKeyStatus { get => geminiKeyStatus; private set => Set(ref geminiKeyStatus, value); }

    bool geminiKeyRejected;
    /// <summary>Google refused the last key that was checked; the key card shows the reason as a warning.</summary>
    public bool GeminiKeyRejected { get => geminiKeyRejected; private set => Set(ref geminiKeyRejected, value); }

    bool isTestingGemini;
    public bool IsTestingGemini { get => isTestingGemini; private set => Set(ref isTestingGemini, value); }

    // Create flow settings

    int shortCount = 3;
    public int ShortCount { get => shortCount; set => Set(ref shortCount, Math.Clamp(value, 1, 20)); }
    double shortDuration = 30;
    public double ShortDuration { get => shortDuration; set => Set(ref shortDuration, value); }
    SourceRegion shortSourceRegion = SourceRegion.EntireVideo;
    public SourceRegion ShortSourceRegion { get => shortSourceRegion; set => Set(ref shortSourceRegion, value); }
    CaptionStyle shortCaptionStyle = CaptionStyle.Auto;
    public CaptionStyle ShortCaptionStyle { get => shortCaptionStyle; set => Set(ref shortCaptionStyle, value); }
    VideoType shortVideoType = VideoType.Auto;
    /// <summary>Chosen after captions, so it never overrides the caption style picked on the step before.</summary>
    public VideoType ShortVideoType { get => shortVideoType; set => Set(ref shortVideoType, value); }
    string customStartMinutes = "0";
    public string CustomStartMinutes { get => customStartMinutes; set => Set(ref customStartMinutes, value); }
    string customEndMinutes = "";
    public string CustomEndMinutes { get => customEndMinutes; set => Set(ref customEndMinutes, value); }

    string chatInput = "";
    public string ChatInput { get => chatInput; set => Set(ref chatInput, value); }
    List<ChatMessage> chatMessages = [new(false, "Tell me what you want to make. I can analyze the imported video, plan a Short, and prepare it for export.")];
    public IReadOnlyList<ChatMessage> ChatMessages => chatMessages;
    void Say(bool isUser, string text) { chatMessages = [.. chatMessages, new ChatMessage(isUser, text)]; Changed(nameof(ChatMessages)); }

    List<List<EditSegment>> editHistory = [];
    public bool CanUndo => editHistory.Count > 0;
    readonly List<List<EditSegment>> redoHistory = [];
    public bool CanRedo => redoHistory.Count > 0;
    const string EditingAIName = "Gemini";

    List<string> recentProjectPaths = [];
    public IReadOnlyList<string> RecentProjectPaths => recentProjectPaths;
    public IReadOnlyList<ProjectFolder> ProjectFolders => Settings.ProjectFolders;
    int projectListRevision;
    /// <summary>Bumped when a project changes from Home, so its card reloads.</summary>
    public int ProjectListRevision { get => projectListRevision; private set => Set(ref projectListRevision, value); }

    public MediaItem? ShortsSource => IsStartingNewVideo ? null
        : project?.Media.FirstOrDefault(m => m.Id == selection && m.Kind == "video") ?? project?.Media.FirstOrDefault(m => m.Kind == "video");

    public EditSegment? ActiveSegment => project?.Segments.FirstOrDefault(s => s.Id == previewShortId);

    public double PreviewLength => ActiveSegment?.Duration ?? project?.Media.FirstOrDefault(m => m.Id == selection)?.Duration ?? 0;

    public static double? MinuteSeconds(string text)
    {
        if (!double.TryParse(text.Trim().Replace(',', '.'), NumberStyles.Float, CultureInfo.InvariantCulture, out var value) || !double.IsFinite(value)) return null;
        var seconds = value * 60;
        return double.IsFinite(seconds) ? seconds : null;
    }

    public string? CustomRangeError
    {
        get
        {
            if (shortSourceRegion != SourceRegion.Custom) return null;
            if (ShortsSource is not { } video) return "Import a video first.";
            if (MinuteSeconds(customStartMinutes) is not { } start || MinuteSeconds(customEndMinutes) is not { } end) return "Enter valid start and end times in minutes.";
            if (start < 0 || end > video.Duration)
                return string.Create(CultureInfo.InvariantCulture, $"Times must be between 0 and {video.Duration / 60:0.000} minutes (the video’s duration).");
            if (end <= start) return "End time must be after start time.";
            return null;
        }
    }

    public void ResetSourceRange(MediaItem video)
    {
        ShortSourceRegion = SourceRegion.EntireVideo;
        CustomStartMinutes = "0";
        // Rounded down so a displayed value never exceeds the actual source duration.
        CustomEndMinutes = (Math.Floor(video.Duration / 60 * 1_000_000) / 1_000_000).ToString("0.######", CultureInfo.InvariantCulture);
    }

    // MARK: Gemini

    public string GeminiApiKey()
    {
        if (DidLoadGeminiKey) return cachedGeminiKey;
        try { cachedGeminiKey = platform.KeyStore.Read(); } catch (Exception) { cachedGeminiKey = ""; }
        DidLoadGeminiKey = true;
        return cachedGeminiKey;
    }

    /// <summary>Reconcile the welcome card with the actual platform key store at app startup.</summary>
    public void RefreshGeminiKeyState()
    {
        IsGeminiKeySaved = GeminiApiKey().Length > 0;
        Settings.GeminiKeySaved = IsGeminiKeySaved;
        Settings.Save();
        if (!IsGeminiKeySaved) GeminiKeyStatus = "";
    }

    public void Dispose()
    {
        generationCancellation?.Cancel();
        previewCancellation?.Cancel();
        Player?.Clear();
        store?.Dispose();
        store = null;
        project = null;
    }

    /// <summary>Null when no key is saved. Every task shows its retries while they happen, and a switch to another model is
    /// added to the task's final message (<see cref="WithModelNote"/>).</summary>
    public GeminiConfiguration? GeminiConfiguration()
    {
        var key = GeminiApiKey();
        if (key.Length == 0) return null;
        return new GeminiConfiguration(key, geminiModel)
        {
            OnRetry = note => Post(() =>
            {
                Message = note;
                if (GenerationProgress is not null && GenerationStage != "Cancelling…") GenerationStage = note;
            }),
            OnFallback = (from, to) => Post(() => ModelFallbackNote = $"{from} was overloaded, so Prism switched to {to}."),
        };
    }

    /// <summary>The text plus the model switch made during the task that just finished, reported once.</summary>
    public string WithModelNote(string text)
    {
        if (ModelFallbackNote is not { } note) return text;
        ModelFallbackNote = null;
        return text + " " + note;
    }

    public void SaveGeminiKey() => SaveGeminiKey(geminiKey.Trim());

    void SaveGeminiKey(string key)
    {
        try { platform.KeyStore.Save(key); }
        catch (Exception error) { GeminiKeyStatus = $"Could not save the Gemini key: {error.Message}"; return; }
        cachedGeminiKey = key;
        DidLoadGeminiKey = true;
        IsGeminiKeySaved = key.Length > 0;
        Settings.GeminiKeySaved = key.Length > 0;
        Settings.Save();
        GeminiKeyStatus = key.Length > 0 ? "Saved securely." : "Saved key removed.";
        GeminiKey = "";
        IsEditingGeminiKey = false;
        IsShowingGeminiKey = false;
        RevealedGeminiKey = "";
    }

    public void EditGeminiKey()
    {
        GeminiKey = "";
        IsShowingGeminiKey = false;
        RevealedGeminiKey = "";
        IsEditingGeminiKey = true;
    }

    public void CancelGeminiKeyEdit()
    {
        GeminiKey = "";
        IsEditingGeminiKey = false;
    }

    public void RemoveGeminiKey()
    {
        GeminiKey = "";
        SaveGeminiKey();
    }

    public void ToggleGeminiKeyVisibility()
    {
        if (IsShowingGeminiKey)
        {
            RevealedGeminiKey = "";
            IsShowingGeminiKey = false;
            return;
        }
        var saved = GeminiApiKey();
        if (saved.Length == 0)
        {
            GeminiKeyStatus = "Could not read the saved key. You can replace it here.";
            return;
        }
        RevealedGeminiKey = saved;
        IsShowingGeminiKey = true;
    }

    static readonly JsonNode OkSchema = JsonNode.Parse("""{"type":"OBJECT","properties":{"ok":{"type":"BOOLEAN"}},"required":["ok"]}""")!;

    /// <summary>Checks the typed key with one tiny Gemini request, then saves it. A key Google refuses is never saved. When Google is
    /// busy or the computer is offline the key is saved anyway, so an outage can't lock anyone out of the app.</summary>
    public async Task VerifyAndSaveGeminiKey(HttpMessageHandler? handler = null)
    {
        var key = geminiKey.Trim();
        if (key.Length == 0 || IsTestingGemini) return;
        IsTestingGemini = true;
        GeminiKeyRejected = false;
        GeminiKeyStatus = "Checking your key with Google…";
        string? unconfirmed = null;
        try
        {
            await Gemini.Generate<System.Text.Json.JsonElement>([Gemini.Text("Return ok true.")], OkSchema, new GeminiConfiguration(key, geminiModel) { Handler = handler });
        }
        catch (GeminiException error) when (error.Failure == GeminiFailure.Request && error.Status is 400 or 401 or 403)
        {
            GeminiKeyRejected = true;
            GeminiKeyStatus = $"Google didn’t accept this key (HTTP {error.Status}). Copy the whole key from Google AI Studio and paste it again.";
            IsTestingGemini = false;
            return;
        }
        catch (Exception error)
        {
            unconfirmed = $"Saved. Google couldn’t confirm the key right now ({error.Message}); Prism will use it when Google answers.";
        }
        IsTestingGemini = false;
        SaveGeminiKey(key);
        if (unconfirmed is not null && IsGeminiKeySaved && GeminiKey.Length == 0) GeminiKeyStatus = unconfirmed;
    }

    public async Task TestGeminiKey()
    {
        if (IsTestingGemini) return;
        if (GeminiConfiguration() is not { } configuration) { GeminiKeyStatus = "Save a Google AI Studio key first."; return; }
        ModelFallbackNote = null;
        IsTestingGemini = true;
        GeminiKeyStatus = "Testing Gemini access…";
        try
        {
            await Gemini.Generate<System.Text.Json.JsonElement>([Gemini.Text("Return ok true.")], OkSchema, configuration);
            GeminiKeyStatus = WithModelNote("Connected. Gemini is ready for cloud editing.");
        }
        catch (Exception error) { GeminiKeyStatus = error.Message; }
        finally { IsTestingGemini = false; }
    }

    /// <summary>What a failed run needs: another range, a Settings change, or simply another try later.</summary>
    public static GenerationFailureKind FailureKind(Exception error)
    {
        if (error is StageFailure stage) error = stage.Underlying;
        if (error is HttpRequestException or TaskCanceledException) return GenerationFailureKind.Temporary;
        if (error is GeminiException gemini)
            return gemini.Failure switch
            {
                GeminiFailure.NoStrongClips or GeminiFailure.NoDistinctClips or GeminiFailure.RequestTooLarge => GenerationFailureKind.NoMoments,
                GeminiFailure.InvalidConfiguration => GenerationFailureKind.Settings,
                GeminiFailure.Request => gemini.Status is 400 or 401 or 403 or 404 ? GenerationFailureKind.Settings : GenerationFailureKind.Temporary,
                GeminiFailure.InvalidResponse or GeminiFailure.InvalidTiming => GenerationFailureKind.Temporary,
                _ => GenerationFailureKind.Other,
            };
        return error is ShortMakerException { Failure: ShortMakerFailure.InvalidRange } ? GenerationFailureKind.NoMoments : GenerationFailureKind.Other;
    }
}
