using Microsoft.Data.Sqlite;
using Prism.Core;
using System.Text.Json;

namespace Prism.Core.Tests;

/// Exercises the shared app model behind both native front ends. All files, settings, keys and cloud replies are disposable.
public class SessionTests
{
    sealed class MemoryKeys : IKeyStore
    {
        public string Value = "";
        public int Reads;
        public bool RejectSave;
        public string Read() { Reads++; return Value; }
        public void Save(string key)
        {
            if (RejectSave) throw new IOException("The test key store is unavailable.");
            Value = key;
        }
    }

    sealed class FakePlatform(string root) : IPlatform
    {
        public IKeyStore AccountStore { get; } = new MemoryKeys();
        public string DownloadsFolder => Path.Combine(root, "Downloads");
        public readonly List<string> Trashed = [];
        public readonly List<string> Opened = [];
        public IReadOnlyList<string> Revealed = [];
        public Action? BeforeTrash;
        public void MoveToTrash(string path) { BeforeTrash?.Invoke(); Trashed.Add(path); }
        public void Reveal(IReadOnlyList<string> paths) => Revealed = paths.ToArray();
        public void OpenFolder(string path) => Opened.Add(path);
    }

    sealed class Player(double time) : IPreviewPlayer
    {
        public double CurrentTime { get; private set; } = time;
        public bool Playing;
        public bool Cleared;
        public void Seek(double seconds) => CurrentTime = seconds;
        public void TogglePlayback() => Playing = !Playing;
        public void Clear() { Cleared = true; Playing = false; }
    }

    [Fact]
    public void RedoRestoresEditsAndSurvivesFailedSaves()
    {
        using var fixture = new Fixture();
        var clip = new EditSegment { Duration = 1, Caption = "Original" };
        fixture.Open(null, clip);
        var session = fixture.Session;
        session.ApplyEdit(clip.Id, false, (value, _) => { value.Caption = "Edited"; return "Updated"; });
        session.UndoFromEditor();
        Assert.True(session.CanRedo);
        Assert.Equal("Original", session.Project!.Segments[0].Caption);
        fixture.BlockSaves(true);
        Assert.StartsWith("Could not save redo", session.RedoEdit());
        Assert.True(session.CanRedo);
        Assert.Equal("Original", session.Project.Segments[0].Caption);
        // A rejected new edit must not throw away the existing redo branch.
        session.ApplyEdit(clip.Id, false, (value, _) => { value.Caption = "Rejected"; return "Updated"; });
        Assert.True(session.CanRedo);
        fixture.BlockSaves(false);
        session.RedoFromEditor();
        Assert.Equal("Edited", fixture.Saved().Segments[0].Caption);
        Assert.False(session.CanRedo);
        Assert.True(session.CanUndo);
        session.UndoFromEditor();
        session.ApplyEdit(clip.Id, false, (value, _) => { value.Caption = "New branch"; return "Updated"; });
        Assert.False(session.CanRedo);
        session.UndoFromEditor();
        Assert.True(session.CanRedo);
        fixture.Open();
        Assert.False(session.CanRedo);
    }

    [Fact]
    public void RapidProjectCreationNeverReusesAnExistingProject()
    {
        using var fixture = new Fixture();
        var paths = new HashSet<string>();
        for (var index = 0; index < 5; index++)
        {
            fixture.Session.Create();
            Assert.True(paths.Add(fixture.Session.ProjectPath!));
            fixture.Session.RenameProject(fixture.Session.ProjectPath!, $"Project {index}");
        }
        Assert.Equal(5, paths.Select(path => ProjectStore.ReadProject(path)!.Id).Distinct().Count());
        Assert.Equal(5, paths.Select(path => ProjectStore.ReadProject(path)!.DisplayTitle).Distinct().Count());
        fixture.Open();
        foreach (var path in paths) Directory.Delete(path, recursive: true);
    }

    [Theory]
    [InlineData("Media")]
    [InlineData("Thumbnails")]
    public async Task ImportDirectoryFailuresLeaveTheEditorUsable(string blockedDirectory)
    {
        using var fixture = new Fixture();
        fixture.Open();
        var previousSelection = fixture.Session.Selection;
        var path = System.IO.Path.Combine(fixture.Path, blockedDirectory);
        File.WriteAllText(path, "This is a file, not a directory.");
        await fixture.Session.ImportSource(await Media.Pictures());
        Assert.False(fixture.Session.IsBusy);
        Assert.Single(fixture.Session.Project!.Media);
        Assert.Equal(previousSelection, fixture.Session.Selection);
        Assert.StartsWith("Could not", fixture.Session.Message);
        if (blockedDirectory == "Thumbnails") Assert.Empty(Directory.GetFiles(System.IO.Path.Combine(fixture.Path, "Media")));
    }

    [Fact]
    public async Task WindowsProjectPathsResolveOnOtherPlatformsAndOnHome()
    {
        using var fixture = new Fixture();
        var source = await Media.Pictures();
        fixture.Open(source);
        var managed = System.IO.Path.Combine(fixture.Path, "Media", "clip.mp4");
        Directory.CreateDirectory(System.IO.Path.GetDirectoryName(managed)!);
        File.Copy(source, managed);
        fixture.Session.Project!.Media[0].Path = @"C:\Prism\Library\Example.relio\Media\clip.mp4";
        fixture.Session.Save();
        Assert.Equal("clip.mp4", fixture.Session.Project.Media[0].Name);
        Assert.NotNull((await ProjectInfo.Summary(fixture.Path)).Poster);
        fixture.Session.Open(fixture.Path);
        Assert.Equal(managed, fixture.Session.Project!.Media[0].Path);
    }

    [Fact]
    public void RecyclingTheOpenProjectReleasesItsPlayerBeforeThePlatformMove()
    {
        using var fixture = new Fixture();
        fixture.Open();
        var player = new Player(1) { Playing = true };
        fixture.Session.Player = player;
        fixture.Platform.BeforeTrash = () => Assert.True(player.Cleared);
        fixture.Session.DeleteProject(fixture.Path);
        Assert.True(player.Cleared);
        Assert.False(player.Playing);
        Assert.Null(fixture.Session.Project);
        Assert.Contains(fixture.Path, fixture.Platform.Trashed);
    }

    [Fact]
    public void FailedRenameKeepsTheOpenAndSavedNamesInSync()
    {
        using var fixture = new Fixture();
        fixture.Open();
        fixture.BlockSaves(true);
        var revision = fixture.Session.ProjectListRevision;
        fixture.Session.RenameProject(fixture.Path, "Must not persist later");
        Assert.Equal("Editor test", fixture.Session.Project!.Title);
        Assert.Equal(revision, fixture.Session.ProjectListRevision);
        Assert.StartsWith("Could not rename project:", fixture.Session.Message);
        fixture.BlockSaves(false);
        fixture.Session.Save();
        Assert.Equal("Editor test", fixture.Saved().Title);
    }

    [Fact]
    public void FailedTrashRestoresTheOpenProjectAndItsHistory()
    {
        using var fixture = new Fixture();
        var media = fixture.Open();
        fixture.Session.AppendGeneratedShorts([new EditSegment { MediaId = media.Id, Duration = 1 }]);
        fixture.Platform.BeforeTrash = () => throw new IOException("Trash unavailable");
        fixture.Session.DeleteProject(fixture.Path);
        Assert.NotNull(fixture.Session.Project);
        Assert.Equal(fixture.Path, fixture.Session.ProjectPath);
        Assert.Equal(media.Id, fixture.Session.Selection);
        Assert.True(fixture.Session.CanUndo);
        Assert.StartsWith("Could not delete project:", fixture.Session.Message);
        fixture.Session.RenameProject(fixture.Path, "Still editable");
        Assert.Equal("Still editable", fixture.Saved().Title);
    }

    [Fact]
    public void DuplicateRecentPathsDoNotCrashHomeAndMissingFoldersDoNotMoveProjects()
    {
        using var fixture = new Fixture();
        fixture.Open();
        using var restored = new AppSession(fixture.Platform, new AppSettings { RecentProjects = [fixture.Path, fixture.Path] });
        Assert.Single(restored.RecentProjectPaths);
        Assert.Single(ProjectInfo.ShortCounts([fixture.Path, fixture.Path]));
        var folder = restored.CreateFolder("Keep")!.Value;
        restored.MoveProject(fixture.Path, folder);
        restored.MoveProject(fixture.Path, Guid.NewGuid());
        Assert.Equal([fixture.Path], restored.ProjectFolders.Single().ProjectPaths);
    }

    [Theory]
    [InlineData("{\"media\":null,\"segments\":[]}")]
    [InlineData("{\"media\":[],\"segments\":null}")]
    [InlineData("{\"media\":[null],\"segments\":[]}")]
    public void InvalidProjectCollectionsAreRejectedBeforeHomeUsesThem(string json)
    {
        using var fixture = new Fixture();
        Directory.CreateDirectory(fixture.Path);
        using (var store = new ProjectStore(fixture.Path)) store.Save(JsonDocument.Parse(json).RootElement, "project");
        Assert.Null(ProjectStore.ReadProject(fixture.Path));
        Assert.Empty(ProjectInfo.ShortCounts([fixture.Path]));
    }

    [Fact]
    public void MalformedSettingsCannotSupplyInvalidNativeLayoutOrTimerValues()
    {
        Directory.CreateDirectory(AppPaths.Config);
        var path = System.IO.Path.Combine(AppPaths.Config, "settings.json");
        var previous = File.Exists(path) ? File.ReadAllText(path) : null;
        try
        {
            File.WriteAllText(path, """{"recentProjects":null,"projectFolders":[null,{"projectPaths":null}],"resourceRefreshSeconds":"NaN","leftSidebarWidth":-10,"rightSidebarWidth":"Infinity","timelineHeight":0,"geminiModel":null,"exportQuality":999}""");
            var settings = AppSettings.Load();
            Assert.Empty(settings.RecentProjects);
            Assert.Empty(Assert.Single(settings.ProjectFolders).ProjectPaths);
            Assert.Equal((60d, 248d, 282d, 278d), (settings.ResourceRefreshSeconds, settings.LeftSidebarWidth, settings.RightSidebarWidth, settings.TimelineHeight));
            Assert.Equal(ExportQuality.Full, settings.ExportQuality);
        }
        finally { if (previous is null) File.Delete(path); else File.WriteAllText(path, previous); }
    }

    sealed class Fixture : IDisposable
    {
        public string Root { get; } = System.IO.Path.Combine(TestSetup.Root, $"session-{Guid.NewGuid()}");
        public string Path => System.IO.Path.Combine(Root, "Editor.relio");
        public FakePlatform Platform { get; }
        public AppSession Session { get; }

        public Fixture()
        {
            Directory.CreateDirectory(Root);
            Platform = new FakePlatform(Root);
            Session = new AppSession(Platform, new AppSettings());
        }

        public MediaItem Open(string? source = null, params EditSegment[] segments)
        {
            var media = new MediaItem
            {
                Path = source ?? System.IO.Path.Combine(Root, "source.mp4"),
                Duration = 6, Width = 640, Height = 360, HasAudio = true,
            };
            foreach (var segment in segments) segment.MediaId = media.Id;
            using (var store = new ProjectStore(Path))
                store.Save(new ProjectData { Name = "Editor test", Title = "Editor test", Media = [media], Segments = [.. segments] }, "project");
            Session.Open(Path);
            Assert.NotNull(Session.Project);
            return media;
        }

        public ProjectData Saved() => ProjectStore.ReadProject(Path)!;

        public void BlockSaves(bool block)
        {
            using var connection = new SqliteConnection(new SqliteConnectionStringBuilder
            { DataSource = System.IO.Path.Combine(Path, "project.sqlite"), Pooling = false }.ToString());
            connection.Open();
            using var command = connection.CreateCommand();
            command.CommandText = block
                ? "CREATE TRIGGER test_save_failure BEFORE INSERT ON state BEGIN SELECT RAISE(ABORT, 'injected save failure'); END;"
                : "DROP TRIGGER test_save_failure;";
            command.ExecuteNonQuery();
        }

        public void Dispose()
        {
            Session.Player = null;
            Session.Dispose();
            try { Directory.Delete(Root, recursive: true); } catch (IOException) { }
        }
    }

    static async Task PreviewSettled(AppSession session)
    {
        var deadline = DateTime.UtcNow.AddSeconds(30);
        while (session.IsPreviewLoading && DateTime.UtcNow < deadline) await Task.Delay(20);
        Assert.False(session.IsPreviewLoading, "Preview timed out.");
        Assert.Null(session.PreviewError);
    }

    [Fact]
    public async Task SignedOutRunsAskToSignInWithoutCallingPrismAI()
    {
        using var fixture = new Fixture();
        using var server = new FakeGemini();
        using var session = new AppSession(fixture.Platform, new AppSettings(), server);
        var media = fixture.Open();
        Assert.Null(session.GeminiConfiguration(media));
        session.Open(fixture.Path);
        await session.MakeShorts(session.Project!.Media[0], 1, 30, SourceRegion.EntireVideo);
        Assert.Equal(GenerationFailureKind.Settings, session.GenerationError?.Kind);
        Assert.Empty(server.Bodies);
    }

    /// Answers the account's sign-in refresh and usage calls; any Prism AI request fails the test.
    sealed class FakeAccount(int runs, double charge, double used) : HttpMessageHandler
    {
        public readonly List<string> Paths = [];
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            var path = request.RequestUri!.AbsolutePath;
            Paths.Add(path);
            string? reply = path switch
            {
                "/auth/v1/token" => """{"refresh_token":"new","access_token":"access","expires_in":3600}""",
                "/rest/v1/rpc/my_reanalysis" when runs < 0 => null,
                "/rest/v1/rpc/my_reanalysis" => $$"""[{"runs":{{runs}},"charge":{{charge}}}]""",
                "/rest/v1/rpc/my_usage" => $$"""[{"used":{{used}},"allowance":60}]""",
                "/rest/v1/rpc/usage_allowed" => "true",
                _ => throw new InvalidOperationException("Unexpected request " + path),
            };
            if (reply is null) return Task.FromResult(new HttpResponseMessage(System.Net.HttpStatusCode.NotFound) { Content = new StringContent("""{"code":"PGRST202"}""") });
            return Task.FromResult(new HttpResponseMessage(System.Net.HttpStatusCode.OK) { Content = new StringContent(reply) });
        }
    }

    [Fact]
    public async Task AServerWithoutReanalysisChargingStartsTheRun()
    {
        using var fixture = new Fixture();
        fixture.Platform.AccountStore.Save("""{"Email":"me@example.com","RefreshToken":"old"}""");
        using var server = new FakeAccount(runs: -1, charge: 0, used: 0);
        using var session = new AppSession(fixture.Platform, new AppSettings(), server);
        fixture.Open();
        session.Open(fixture.Path);
        await session.MakeShorts(session.Project!.Media[0], 1, 30, SourceRegion.EntireVideo);
        Assert.Null(session.PendingPaidRun);
        Assert.NotEqual("Prism couldn't check your usage right now. Try again in a moment.", session.GenerationError?.Message);
        Assert.Contains("/rest/v1/rpc/usage_allowed", server.Paths);
    }

    [Theory]
    [InlineData(10, false)]
    [InlineData(59, true)]
    public async Task ReanalysisAsksBeforeChargingAndStopsWhenMinutesRunOut(double used, bool limited)
    {
        using var fixture = new Fixture();
        fixture.Platform.AccountStore.Save("""{"Email":"me@example.com","RefreshToken":"old"}""");
        using var server = new FakeAccount(runs: 1, charge: 3, used: used);
        using var session = new AppSession(fixture.Platform, new AppSettings(), server);
        fixture.Open();
        session.Open(fixture.Path);
        await session.MakeShorts(session.Project!.Media[0], 1, 30, SourceRegion.EntireVideo);
        Assert.False(session.IsBusy);
        if (limited)
        {
            Assert.Null(session.PendingPaidRun);
            Assert.Equal(GenerationFailureKind.Limit, session.GenerationError?.Kind);
            Assert.Contains("needs 3 min, but you have 1 min left", session.GenerationError!.Message);
        }
        else
        {
            Assert.Equal(3, session.PendingPaidRun?.Minutes);
            Assert.Null(session.GenerationError);
            session.PendingPaidRun = null;
        }
        Assert.DoesNotContain(server.Paths, p => p.Contains("functions"));
    }

    [Fact]
    public async Task ExportCardTitlesAndDescriptionsAreSavedOnTheShorts()
    {
        using var fixture = new Fixture();
        var clip = new EditSegment { Duration = 2, SuggestedTitle = "Old" };
        fixture.Open(null, clip);
        var session = fixture.Session;
        session.ChooseExport();
        var choice = session.ExportChoice!;
        Assert.Equal("Old", choice.Titles![clip.Id]);
        Assert.Equal("", choice.Descriptions![clip.Id]);
        await session.Export(choice with
        {
            ShortIds = new HashSet<Guid>(),
            Titles = new Dictionary<Guid, string> { [clip.Id] = "New title" },
            Descriptions = new Dictionary<Guid, string> { [clip.Id] = "Watch this #prism" },
        });
        var saved = Assert.Single(fixture.Saved().Segments);
        Assert.Equal(("New title", "Watch this #prism"), (saved.SuggestedTitle, saved.SuggestedDescription));
    }

    [Fact]
    public void UnreadableProjectsShowTheirFolderNameWithoutItsId()
    {
        Assert.Equal("My trip", ProjectInfo.FolderTitle($"/Library/Projects/My trip {Guid.NewGuid()}.relio"));
        Assert.Equal("Plain name", ProjectInfo.FolderTitle(@"C:\Prism\Plain name.relio\"));
    }

    [Fact]
    public async Task UsageKeysMatchTheMacApp()
    {
        var media = new MediaItem { Path = "/Users/me/Movies/clip.mp4", Duration = 59.5 };
        Assert.Equal("clip.mp4|60", UsageLimit.VideoKey(media));
        Assert.Equal("b22bf831f99fc46fe2584a21fff4c6b55c2ae0e72d2ace8f8788f57855acf841", UsageLimit.ServerKey(media));
        Assert.Equal(59.5 / 60, UsageLimit.Minutes(media));
        var file = System.IO.Path.Combine(TestSetup.Root, $"hash-{Guid.NewGuid()}.bin");
        File.WriteAllText(file, "prism");
        media.ContentHash = await UsageLimit.ContentHash(file);
        Assert.Equal("bb4c8eb92b6ec7b9055c94a397581544693c61da0f8f6cbb808681ccd0d9ce9b", media.ContentHash);
        Assert.Equal(media.ContentHash, UsageLimit.ServerKey(media));
        Assert.Equal("2026-10-30", Account.DayString(new DateTime(2026, 10, 30, 23, 59, 0)));
    }

    public static IEnumerable<object[]> Failures()
    {
        yield return [new GeminiException(GeminiFailure.Request, 503), GenerationFailureKind.Temporary];
        yield return [new StageFailure("Audio transcription at 3m 0s", new GeminiException(GeminiFailure.Request, 503)), GenerationFailureKind.Temporary];
        yield return [new HttpRequestException("offline"), GenerationFailureKind.Temporary];
        yield return [new TaskCanceledException(), GenerationFailureKind.Temporary];
        foreach (var code in new[] { 400, 401, 403, 404 }) yield return [new GeminiException(GeminiFailure.Request, code), GenerationFailureKind.Settings];
        yield return [new GeminiException(GeminiFailure.SignIn), GenerationFailureKind.Settings];
        yield return [new GeminiException(GeminiFailure.UsageLimit, 429), GenerationFailureKind.Limit];
        yield return [new GeminiException(GeminiFailure.Request, 429), GenerationFailureKind.Temporary];
        yield return [new GeminiException(GeminiFailure.InvalidResponse), GenerationFailureKind.Temporary];
        yield return [new GeminiException(GeminiFailure.InvalidTiming), GenerationFailureKind.Temporary];
        foreach (var failure in new[] { GeminiFailure.NoStrongClips, GeminiFailure.NoDistinctClips, GeminiFailure.RequestTooLarge })
            yield return [new GeminiException(failure), GenerationFailureKind.NoMoments];
        yield return [new ShortMakerException(ShortMakerFailure.InvalidRange), GenerationFailureKind.NoMoments];
        yield return [new ShortMakerException(ShortMakerFailure.NoVideo), GenerationFailureKind.Other];
        yield return [new IOException("unavailable"), GenerationFailureKind.Other];
    }

    [Theory]
    [MemberData(nameof(Failures))]
    public void FailedRunsAreExplainedByTheirCause(Exception error, GenerationFailureKind expected)
        => Assert.Equal(expected, AppSession.FailureKind(error));

    [Fact]
    public async Task CustomRangeValidationBlocksGenerationBeforeGemini()
    {
        using var fixture = new Fixture();
        var session = fixture.Session;
        session.StartLongVideoToShort();
        Assert.Equal(Screen.ImportSource, session.Screen);
        Assert.Null(session.ProjectPath);
        Assert.Null(session.ShortsSource);
        var media = fixture.Open();
        session.ResetSourceRange(media);
        session.ShortSourceRegion = SourceRegion.Custom;
        Assert.Null(session.CustomRangeError);
        Assert.InRange(AppSession.MinuteSeconds(session.CustomEndMinutes)!.Value, 5.9999, 6);
        foreach (var (start, end) in new[] { ("0", "1000"), ("0", "NaN"), ("Infinity", "1"), ("-1", "0.1"), ("0.1", "0.1") })
        {
            session.CustomStartMinutes = start;
            session.CustomEndMinutes = end;
            Assert.NotNull(session.CustomRangeError);
            await session.MakeConfiguredShorts();
            Assert.False(session.IsBusy);
            Assert.Empty(session.Project!.Segments);
        }
        Assert.Equal(90, AppSession.MinuteSeconds("1,5"));
        session.ResetSourceRange(media);
        await session.MakeConfiguredShorts();
        Assert.False(session.IsBusy);
        Assert.Equal(GenerationFailureKind.Settings, session.GenerationError?.Kind);
        Assert.StartsWith("Sign in to your Prism account", session.GenerationError!.Message);
    }

    [Fact]
    public void GeneratedBatchesKeepEarlierWorkDeduplicateAndRollBackWhenSavingFails()
    {
        using var fixture = new Fixture();
        var media = fixture.Open();
        var session = fixture.Session;
        var first = new EditSegment
        {
            MediaId = media.Id, Start = 0, Duration = 1, FitToFrame = true, SuggestedTitle = "First story",
            SelectionReason = "A specific hook and payoff.", CaptionNotice = "Sentence timing notice", CaptionStyle = CaptionStyle.Viral,
        };
        Assert.Single(session.AppendGeneratedShorts([first]));
        var second = new EditSegment { MediaId = media.Id, Start = 3, Duration = 1 };
        var overlapping = new EditSegment { MediaId = media.Id, Start = 0.1, Duration = 1 };
        Assert.Single(session.AppendGeneratedShorts([first, overlapping, second, second]));
        Assert.Equal(new[] { first.Id, second.Id }, fixture.Saved().Segments.Select(s => s.Id));
        var stored = fixture.Saved().Segments[0];
        Assert.Equal(("First story", true, "Sentence timing notice", CaptionStyle.Viral),
            (stored.SuggestedTitle, stored.FitToFrame, stored.CaptionNotice, stored.CaptionStyle));
        var before = PrismJson.Serialize(session.Project!.Segments);
        Assert.Throws<ShortMakerException>(() => session.AppendGeneratedShorts([new EditSegment { MediaId = media.Id, Start = double.NaN, Duration = 1 }]));
        Assert.Equal(before, PrismJson.Serialize(session.Project.Segments));
        fixture.BlockSaves(true);
        Assert.Throws<StoreException>(() => session.AppendGeneratedShorts([new EditSegment { MediaId = media.Id, Start = 5, Duration = 0.5 }]));
        Assert.Equal(before, PrismJson.Serialize(session.Project.Segments));
        Assert.Equal(before, PrismJson.Serialize(fixture.Saved().Segments));
        fixture.BlockSaves(false);
        session.UndoEdit();
        Assert.Single(session.Project.Segments);
        Assert.Equal(first.Id, session.Project.Segments[0].Id);
    }

    [Fact]
    public void FailedEditPersistenceRestoresTheShortAndUndoState()
    {
        using var fixture = new Fixture();
        var clip = new EditSegment { Duration = 1, Caption = "Original", Captions = [new("Kept", 0, 0.5)] };
        fixture.Open(null, clip);
        var session = fixture.Session;
        fixture.BlockSaves(true);
        var reply = session.ApplyEdit(clip.Id, false, (segment, _) =>
        {
            segment.Caption = "Changed";
            segment.Captions!.Clear();
            return "Saved.";
        });
        Assert.StartsWith("Could not save the edit:", reply);
        Assert.Equal("Original", session.Project!.Segments[0].Caption);
        Assert.Single(session.Project.Segments[0].Captions!);
        Assert.Equal("Original", fixture.Saved().Segments[0].Caption);
        Assert.False(session.CanUndo);
    }

    [Fact]
    public async Task EditsAndUndoUseDeepCopiesAndDoNotOpenADifferentShort()
    {
        using var fixture = new Fixture();
        var first = new EditSegment { Duration = 0.5, Caption = "Original", Captions = [new("Hello", 0, 0.2)], CropKeyframes = [new(0, 0.5)] };
        var second = new EditSegment { Start = 2, Duration = 0.5 };
        fixture.Open(await Media.Pictures(), first, second);
        var session = fixture.Session;
        await session.SelectPreviewAsync(second.Id);
        var path = session.PreviewPath;
        var original = session.Project!.Segments[0];
        Assert.Null(session.ApplyEdit(first.Id, false, (segment, _) =>
        {
            segment.Caption = "Rejected";
            segment.Captions!.Clear();
            return null;
        }));
        Assert.Equal("Original", original.Caption);
        Assert.Single(original.Captions!);
        Assert.False(session.CanUndo);
        session.ApplyEdit(first.Id, false, (segment, _) =>
        {
            segment.Caption = "Changed";
            segment.Captions![0] = new("Different", 0, 0.2);
            return "Saved.";
        });
        Assert.Equal(second.Id, session.PreviewShortId);
        Assert.Equal(path, session.PreviewPath);
        original.Caption = "A stale reference changed";
        original.Captions!.Clear();
        session.Project.Segments[0].CropKeyframes!.Clear();
        session.UndoFromEditor();
        await PreviewSettled(session);
        var restored = session.Project.Segments[0];
        Assert.Equal("Original", restored.Caption);
        Assert.Equal(new TimedCaption("Hello", 0, 0.2), Assert.Single(restored.Captions!));
        Assert.Single(restored.CropKeyframes!);
        Assert.False(session.CanUndo);
    }

    [Fact]
    public async Task CaptionTextChangesKeepTimingAndStylesSurviveClipEdits()
    {
        using var fixture = new Fixture();
        var clip = new EditSegment { Duration = 1, Captions = [new("hello there", 0, 0.5), new("remove me", 0.5, 0.5)] };
        fixture.Open(await Media.Pictures(), clip);
        var session = fixture.Session;
        await session.SelectPreviewAsync(clip.Id);
        session.SetSelectedCaptionStyle(CaptionStyle.Viral);
        await PreviewSettled(session);
        session.SetSelectedCaptionLayout(CaptionPosition.Middle, CaptionSize.Large, true);
        await PreviewSettled(session);
        session.UpdateSelectedEdit(0, 1, "Inspector test", 0, 0.5, cropPosition: 0.85);
        await PreviewSettled(session);
        Assert.Equal(CaptionStyle.Viral, session.ActiveSegment?.CaptionStyle);
        session.UpdateSelectedCaptionTexts([" Hello there! ", "  "]);
        await PreviewSettled(session);
        var cue = Assert.Single(session.ActiveSegment!.Captions!);
        Assert.Equal(new TimedCaption("Hello there!", 0, 0.5), cue);
        var saved = Assert.Single(fixture.Saved().Segments);
        Assert.Equal((CaptionStyle.Viral, CaptionPosition.Middle, CaptionSize.Large, true, 0.85),
            (saved.CaptionStyle, saved.CaptionPosition, saved.CaptionSize, saved.CaptionAnimated, saved.CropPosition));
        Assert.Equal(cue, Assert.Single(saved.Captions!));
        session.UpdateSelectedEdit(-1, 1, "Invalid", 0, 0.5);
        Assert.Equal("Inspector test", session.ActiveSegment.Caption);
        session.UpdateSelectedCaptionTexts(["Wrong", "count"]);
        Assert.Single(session.ActiveSegment.Captions!);
    }

    [Fact]
    public async Task FocusPointsHonorTheCropOffsetAndKeepSceneAndWholeFrameFlags()
    {
        using var fixture = new Fixture();
        var clip = new EditSegment
        {
            Duration = 2, CropPosition = 0.85,
            CropKeyframes = [new(0, 0.5, PreserveWholeFrame: true), new(1, 0.2, true, true), new(2, 0.2, PreserveWholeFrame: true)],
        };
        fixture.Open(await Media.Pictures(), clip);
        var session = fixture.Session;
        await session.SelectPreviewAsync(clip.Id);
        session.AdjustCropKeyframe(1.5, 1.5, 0.6, true);
        await PreviewSettled(session);
        var focused = session.ActiveSegment!;
        var clicked = Assert.Single(focused.CropKeyframes!, p => Math.Abs(p.Time - 1.5) < 0.01);
        Assert.Equal(0.6, clicked.Position + focused.CropPosition!.Value - 0.5, 6);
        Assert.Contains(focused.CropKeyframes!, p => p.Time == 1 && p.IsSceneCut == true && p.PreserveWholeFrame == true);
        session.AdjustCropKeyframe(1, 0.9, 0.7, false);
        await PreviewSettled(session);
        Assert.Contains(session.ActiveSegment!.CropKeyframes!, p => p.Time == 0.9 && p.IsSceneCut == true && p.PreserveWholeFrame == true);
        var rebased = PrismJson.Clone(session.ActiveSegment);
        Assert.True(AppSession.Rebase(rebased, session.ShortsSource!, 0.3, 1));
        Assert.Equal(0, rebased.CropKeyframes![0].Time);
        Assert.True(rebased.CropKeyframes[0].PreserveWholeFrame);
        Assert.True(rebased.CropKeyframes[^1].PreserveWholeFrame);
        session.AdjustCropKeyframe(1.5, 1.5, 0.05, false);
        await PreviewSettled(session);
        var edge = Assert.Single(session.ActiveSegment!.CropKeyframes!, p => Math.Abs(p.Time - 1.5) < 0.01);
        Assert.Equal(0.05, edge.Position + session.ActiveSegment.CropPosition!.Value - 0.5, 6);
        Assert.Contains(session.ActiveSegment.CropKeyframes!, p => p.Time == 0.9 && p.IsSceneCut == true && p.PreserveWholeFrame == true);
    }

    [Fact]
    public async Task FirstManualFocusPointStartsFromCenteredEndpoints()
    {
        using var fixture = new Fixture();
        var clip = new EditSegment { Duration = 1, CropPosition = 0.85 };
        fixture.Open(await Media.Pictures(), clip);
        var session = fixture.Session;
        await session.SelectPreviewAsync(clip.Id);
        session.AdjustCropKeyframe(0.5, 0.5, 0.6, true);
        await PreviewSettled(session);
        var points = session.ActiveSegment!.CropKeyframes!;
        Assert.Equal(new CropKeyframe(0, 0.5), points[0]);
        Assert.Equal(new CropKeyframe(1, 0.5), points[^1]);
        Assert.Equal(0.25, points[1].Position, 6);
    }

    [Fact]
    public async Task AssistantCommandsKeepOriginalUnicodeTextAndRebaseTimedTracks()
    {
        using var fixture = new Fixture();
        var clip = new EditSegment
        {
            Start = 1, Duration = 3, Captions = [new("Complete phrase", 0.1, 1.5)], SpeechWords = [new("Complete", 0.2, 0.6)],
            CropKeyframes = [new(0, 0.2, PreserveWholeFrame: true), new(3, 0.8, PreserveWholeFrame: true)],
        };
        fixture.Open(await Media.Pictures(), clip);
        var session = fixture.Session;
        await session.SelectPreviewAsync(clip.Id);
        session.HandleFallback("İ PLEASE ADD TEXT saying “Ça va?” for the first 1 seconds");
        await PreviewSettled(session);
        Assert.Equal("Ça va?", session.ActiveSegment!.Caption);
        Assert.Equal(1, session.ActiveSegment.CaptionDuration);
        session.HandleFallback("İ change the CAPTION TO “Été”");
        await PreviewSettled(session);
        Assert.Equal("Été", session.ActiveSegment.Caption);
        session.ExecuteAICommand(new GeminiSelection.EditCommand("START", ["1.4"]), "start at 1.4");
        await PreviewSettled(session);
        Assert.Equal(1.2, session.ActiveSegment.Start, 6); // Snaps to the start of the spoken word.
        Assert.Equal(0, Assert.Single(session.ActiveSegment.SpeechWords!).Start, 6);
        Assert.Equal(0, Assert.Single(session.ActiveSegment.Captions!).Start, 6);
        session.ExecuteAICommand(new GeminiSelection.EditCommand("TRIM", ["0.4"]), "trim to 0.4");
        await PreviewSettled(session);
        Assert.Equal(0.64, session.ActiveSegment.Duration, 6); // Carries the word's end and a 40 ms margin.
        Assert.True(session.ActiveSegment.CropKeyframes![0].PreserveWholeFrame);
        Assert.True(session.ActiveSegment.CropKeyframes[^1].PreserveWholeFrame);
        Assert.Contains(session.ChatMessages, m => !m.IsUser && m.Text.Contains("trimmed the edit"));
    }

    [Fact]
    public async Task ManualClipsReadTheSourcePlayheadAndBusyGuardsBlockEdits()
    {
        using var fixture = new Fixture();
        fixture.Open(await Media.Pictures());
        var session = fixture.Session;
        var player = new Player(1.25);
        session.Player = player;
        session.ShortDuration = 0.5;
        session.AddManualClip();
        await PreviewSettled(session);
        Assert.Equal(1.25, session.ActiveSegment?.Start);
        Assert.Equal(0.5, session.ActiveSegment?.Duration);
        session.ToggleSelectedAudio();
        await PreviewSettled(session);
        Assert.True(session.ActiveSegment?.IsMuted);
        session.SetFraming(true);
        await PreviewSettled(session);
        Assert.True(session.ActiveSegment?.FitToFrame);
        session.UndoFromEditor();
        await PreviewSettled(session);
        Assert.NotEqual(true, session.ActiveSegment?.FitToFrame);
        session.SeekPreview(0.3);
        Assert.Equal(0.3, player.CurrentTime);
        var before = PrismJson.Serialize(session.Project!.Segments);
        session.IsBusy = true;
        session.AddManualClip();
        session.ToggleSelectedAudio();
        session.UndoFromEditor();
        session.RemoveShort(session.ActiveSegment!.Id);
        Assert.Equal(before, PrismJson.Serialize(session.Project.Segments));
        session.IsBusy = false;
        session.RemoveShort(session.ActiveSegment.Id);
        Assert.Empty(session.Project.Segments);
        session.UndoFromEditor();
        await PreviewSettled(session);
        Assert.Single(session.Project.Segments);
    }

    [Fact]
    public void HomeFoldersKeepProjectsWhenRenamedMovedOrDeleted()
    {
        using var fixture = new Fixture();
        fixture.Open();
        var session = fixture.Session;
        var podcasts = session.CreateFolder("  Podcasts  ")!.Value;
        var other = session.CreateFolder("Other")!.Value;
        Assert.Null(session.CreateFolder("  "));
        session.MoveProject(fixture.Path, podcasts);
        session.MoveProject(fixture.Path, other);
        session.MoveProject("not a project", other);
        Assert.Empty(session.ProjectFolders.Single(f => f.Id == podcasts).ProjectPaths);
        Assert.Equal(fixture.Path, Assert.Single(session.ProjectFolders.Single(f => f.Id == other).ProjectPaths));
        session.RenameFolder(other, "Satellite");
        Assert.Equal("Satellite", session.ProjectFolders.Single(f => f.Id == other).Name);
        session.DeleteFolder(other);
        Assert.Equal("Podcasts", Assert.Single(session.ProjectFolders).Name);
        Assert.Contains(fixture.Path, session.RecentProjectPaths);
        var revision = session.ProjectListRevision;
        session.RenameProject(fixture.Path, "  My oil Shorts  ");
        session.Save();
        Assert.Equal("My oil Shorts", fixture.Saved().DisplayTitle);
        Assert.Equal(revision + 1, session.ProjectListRevision);
        session.RenameProject(fixture.Path, "  ");
        Assert.Equal("My oil Shorts", session.Project?.DisplayTitle);
    }

    [Fact]
    public async Task UnusableExportFolderKeepsTheCardOpenWithItsError()
    {
        using var fixture = new Fixture();
        var clip = new EditSegment { Duration = 0.5 };
        fixture.Open(null, clip);
        var session = fixture.Session;
        session.ChooseExport();
        Assert.Equal(clip.Id, Assert.Single(session.ExportChoice!.ShortIds));
        Assert.False(session.ExportChoice.IncludeSource);
        Assert.Equal(Path.Combine(fixture.Platform.DownloadsFolder, "Prism", "Editor test"), session.ExportChoice.Folder);
        var blocker = Path.Combine(fixture.Root, "blocker");
        File.WriteAllText(blocker, "not a folder");
        var choice = session.ExportChoice with { Folder = Path.Combine(blocker, "Exports") };
        await session.Export(choice);
        Assert.False(session.IsBusy);
        Assert.False(session.IsExporting);
        Assert.NotNull(session.ExportChoice);
        Assert.Contains("Could not use this folder", session.ExportChoice.Error);
        Assert.Equal(choice.Folder, session.ExportChoice.Folder);
        Assert.Empty(session.ExportedFiles);
        Assert.Null(session.GenerationProgress);
    }

    [Fact]
    public async Task ExportUsesProjectOrderSafeTitlesOriginalNumbersAndUniqueNamesAndCopiesSources()
    {
        using var fixture = new Fixture();
        var first = new EditSegment { Duration = 0.3, SuggestedTitle = "Oil: \"what's\" next?/now" };
        var skipped = new EditSegment { Start = 1, Duration = 0.3 };
        var third = new EditSegment { Start = 2, Duration = 0.3, IsMuted = true };
        var media = fixture.Open(await Media.Pictures(), first, skipped, third);
        var session = fixture.Session;
        session.Project!.Title = "Export: test?";
        var extra = Path.Combine(fixture.Root, "other.mov");
        File.WriteAllText(extra, "A source is copied byte for byte.");
        session.Project.Media.Add(new MediaItem { Path = extra, Kind = "video" });
        session.Project.Media.Add(new MediaItem { Path = "not-an-export.jpg", Kind = "image" });
        var folder = Path.Combine(fixture.Root, "Exports");
        Directory.CreateDirectory(folder);
        var existing = Path.Combine(folder, "Oil what's next now.mp4");
        File.WriteAllText(existing, "keep me");
        session.ChooseExport(third.Id);
        Assert.Equal(third.Id, Assert.Single(session.ExportChoice!.ShortIds));
        var choice = new ExportChoice(new HashSet<Guid> { third.Id, first.Id }, true, ExportQuality.Small, folder);
        var exporting = session.Export(choice);
        Assert.Null(session.ExportChoice);
        await exporting;
        Assert.False(session.IsBusy);
        Assert.False(session.IsExporting);
        Assert.Equal(new[] { "Oil what's next now 2.mp4", "Export test Short 3.mp4", media.Name, "other.mov" },
            session.ExportedFiles.Select(Path.GetFileName));
        Assert.Equal("keep me", File.ReadAllText(existing));
        Assert.Equal(File.ReadAllBytes(media.Path), File.ReadAllBytes(session.ExportedFiles[2]));
        Assert.Equal(File.ReadAllBytes(extra), File.ReadAllBytes(session.ExportedFiles[3]));
        var firstInfo = await FFmpeg.Probe(session.ExportedFiles[0]);
        var thirdInfo = await FFmpeg.Probe(session.ExportedFiles[1]);
        Assert.Equal((720, 1280, true), (firstInfo!.Width, firstInfo.Height, firstInfo.HasAudio));
        Assert.False(thirdInfo!.HasAudio);
        Assert.Equal(folder, session.LastExportFolder);
        Assert.Equal(ExportQuality.Small, session.LastExportQuality);
        Assert.Equal(2, session.LastExportShortCount);
        Assert.Equal(session.Message, session.ExportSummary);
        Assert.Contains("Exported 2 Shorts and the main video", session.ExportSummary);
        Assert.Null(session.GenerationProgress);
        session.RevealExports();
        Assert.Equal(session.ExportedFiles, fixture.Platform.Revealed);
        session.Open(fixture.Path);
        Assert.Null(session.LastExportFolder);
        Assert.Empty(session.ExportedFiles);
        Assert.Equal(media.Path, session.PreviewPath);
    }

    [Theory]
    [InlineData(ExportQuality.Full, "h264")]
    [InlineData(ExportQuality.Compact, "hevc")]
    public async Task ChatExportAllUsesTheSavedQualityAndDefaultFolder(ExportQuality quality, string codec)
    {
        using var fixture = new Fixture();
        fixture.Open(await Media.Pictures(), new EditSegment { Duration = 0.3, SuggestedTitle = "A story" });
        var session = fixture.Session;
        session.Settings.ExportQuality = quality;
        await session.ExportAll();
        var output = Assert.Single(session.ExportedFiles);
        Assert.StartsWith(session.DefaultExportFolder() + Path.DirectorySeparatorChar, output);
        Assert.Equal(quality, session.LastExportQuality);
        Assert.Equal(1, session.LastExportShortCount);
        Assert.False(session.IsBusy);
        var info = await FFmpeg.Probe(output);
        Assert.Equal((1080, 1920), (info!.Width, info.Height));
        var probe = await FFmpeg.Run(FFmpeg.FFprobePath,
            ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=codec_name", "-of", "csv=p=0", output]);
        Assert.Equal(codec, System.Text.Encoding.UTF8.GetString(probe.Output).Trim());
    }

    [Fact]
    public async Task SourceOnlyAndEmptyExportsAndFileManagerFallbacksWork()
    {
        using var fixture = new Fixture();
        var source = Path.Combine(fixture.Root, "main.mov");
        File.WriteAllText(source, "Original source bytes");
        fixture.Open(source);
        var session = fixture.Session;
        session.RevealExports();
        Assert.Equal(Path.Combine(fixture.Path, "Exports"), fixture.Platform.Opened.Last());
        session.ChooseExport();
        var choice = session.ExportChoice!;
        await session.Export(choice);
        Assert.NotNull(session.ExportChoice);
        Assert.False(session.IsBusy);
        Assert.Null(session.LastExportFolder);
        await session.Export(choice with { IncludeSource = true });
        var output = Assert.Single(session.ExportedFiles);
        Assert.Equal(File.ReadAllBytes(source), File.ReadAllBytes(output));
        Assert.Equal(0, session.LastExportShortCount);
        Assert.Contains("Exported the main video", session.ExportSummary);
        session.Open(fixture.Path);
        session.RevealExports();
        Assert.Equal(session.DefaultExportFolder(), fixture.Platform.Opened.Last());
    }

    [Fact]
    public async Task ExportReportsFailuresAndKeepsFilesAlreadyCompleted()
    {
        using var fixture = new Fixture();
        var media = fixture.Open();
        var session = fixture.Session;
        var missing = new EditSegment { MediaId = Guid.NewGuid(), Duration = 0.3 };
        session.Project!.Segments.Add(missing);
        await session.Export(new ExportChoice(new HashSet<Guid> { missing.Id }, false, ExportQuality.Small, Path.Combine(fixture.Root, "failed")));
        Assert.StartsWith("Export failed:", session.Message);
        Assert.True(session.GenerationError?.IsExport);
        Assert.Empty(session.ExportedFiles);
        Assert.False(session.IsBusy);
        var source = Path.Combine(fixture.Root, "first.mov");
        File.WriteAllText(source, "copied before failure");
        media.Path = source;
        session.Project.Media = [media, new MediaItem { Path = Path.Combine(fixture.Root, "missing.mov"), Kind = "video" }];
        await session.Export(new ExportChoice(new HashSet<Guid>(), true, ExportQuality.Full, Path.Combine(fixture.Root, "partial")));
        Assert.StartsWith("Export stopped after 1 of 2 files.", session.Message);
        Assert.True(session.GenerationError?.IsExport);
        Assert.True(File.Exists(Assert.Single(session.ExportedFiles)));
        Assert.False(session.IsBusy);
        Assert.False(session.IsExporting);
        Assert.Null(session.GenerationProgress);
    }

    [Fact]
    public async Task CancellingExportReturnsToTheEditorAndCleansTemporaryFiles()
    {
        using var fixture = new Fixture();
        var clip = new EditSegment { Duration = 6 };
        fixture.Open(await Media.Pictures(), clip);
        var session = fixture.Session;
        var folder = Path.Combine(fixture.Root, "cancelled");
        var exporting = session.Export(new ExportChoice(new HashSet<Guid> { clip.Id }, false, ExportQuality.Full, folder));
        session.CancelGeneration();
        await exporting;
        Assert.Contains("Export cancelled.", session.Message);
        Assert.Equal(Screen.Editor, session.Screen);
        Assert.False(session.IsBusy);
        Assert.False(session.IsExporting);
        Assert.Null(session.GenerationProgress);
        Assert.Empty(Directory.GetFiles(folder));
    }

    [Fact]
    public void ExportNamesRejectUnsafeAndEmptyTitles()
    {
        Assert.Equal("Oil what's next now", AppSession.ExportFileName("Oil: \"what's\" next?/now"));
        Assert.Null(AppSession.ExportFileName(" .. "));
        Assert.Null(AppSession.ExportFileName(null));
        Assert.Equal(80, AppSession.ExportFileName(new string('a', 200))!.Length);
        Assert.Equal("one two three", AppSession.ExportFileName("one\ntwo\tthree"));
        Assert.Equal("_CON", AppSession.ExportFileName("CON"));
        Assert.Equal("_lpt1.txt", AppSession.ExportFileName("lpt1.txt"));
    }
}
