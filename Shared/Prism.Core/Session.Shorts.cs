namespace Prism.Core;

public sealed partial class AppSession
{
    CancellationTokenSource? generationCancellation;

    /// <summary>Await a state change on the toolkit's UI thread.</summary>
    Task UI(Action action)
    {
        if (context is null || SynchronizationContext.Current == context)
        {
            action();
            return Task.CompletedTask;
        }
        var completion = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        Post(() =>
        {
            try { action(); completion.SetResult(); }
            catch (Exception error) { completion.SetException(error); }
        });
        return completion.Task;
    }

    Task<T> UI<T>(Func<T> action)
    {
        if (context is null || SynchronizationContext.Current == context) return Task.FromResult(action());
        var completion = new TaskCompletionSource<T>(TaskCreationOptions.RunContinuationsAsynchronously);
        Post(() =>
        {
            try { completion.SetResult(action()); }
            catch (Exception error) { completion.SetException(error); }
        });
        return completion.Task;
    }

    void ScopeGeminiCallbacks(GeminiConfiguration configuration, Func<bool> current)
    {
        configuration.OnRetry = note => Post(() =>
        {
            if (!current()) return;
            Message = note;
            if (GenerationProgress is not null && GenerationStage != "Cancelling…") GenerationStage = note;
        });
    }

    public void SelectPreview(Guid? shortId) => _ = SelectPreviewAsync(shortId);

    /// <summary>Switches the player, cancelling older renders and ignoring their results.</summary>
    public async Task SelectPreviewAsync(Guid? shortId)
    {
        previewCancellation?.Cancel();
        if (subjectTrackingRevision is not null)
        {
            subjectTrackingRevision = null;
            IsBusy = false;
        }
        var cancellation = new CancellationTokenSource();
        previewCancellation = cancellation;
        var token = cancellation.Token;
        var revision = ++previewRevision;
        var projectId = project?.Id;
        PreviewShortId = shortId;
        PreviewError = null;
        PreviewPath = null;
        PreviewSegment = null;
        IsPreviewLoading = false;
        Changed(nameof(ActiveSegment));
        Changed(nameof(PreviewLength));
        var segment = project?.Segments.FirstOrDefault(s => s.Id == shortId);
        var video = project?.Media.FirstOrDefault(m => m.Kind == "video" && m.Id == segment?.MediaId)
            ?? project?.Media.FirstOrDefault(m => m.Kind == "video" && m.Id == selection);
        if (video is null)
        {
            cancellation.Dispose();
            if (ReferenceEquals(previewCancellation, cancellation)) previewCancellation = null;
            return;
        }
        if (segment is null)
        {
            PreviewShortId = null;
            PreviewPath = video.Path;
            cancellation.Dispose();
            if (ReferenceEquals(previewCancellation, cancellation)) previewCancellation = null;
            return;
        }
        Selection = video.Id;
        segment = PrismJson.Clone(segment);
        IsPreviewLoading = true;
        var configuration = !IsBusy && segment.CropTrackingVersion != SubjectFramer.Version && segment.SplitScreen != true
            ? GeminiConfiguration(video) : null;
        if (configuration is not null)
        {
            IsBusy = true;
            subjectTrackingRevision = revision;
            Message = "Prism AI is framing the main subject…";
        }
        bool Current() => !token.IsCancellationRequested && revision == previewRevision && project?.Id == projectId;
        if (configuration is not null) ScopeGeminiCallbacks(configuration, Current);
        try
        {
            if (configuration is not null)
            {
                var path = await Task.Run(() => SubjectFramer.Analyze(video.Path, segment.Start, segment.Duration,
                    segment.CropZoom ?? 1.08, configuration, segment.Captions, cancellation: token), token).ConfigureAwait(false);
                token.ThrowIfCancellationRequested();
                var updated = await UI(() =>
                {
                    if (!Current() || subjectTrackingRevision != revision || project is null) return null;
                    var index = project.Segments.FindIndex(s => s.Id == shortId);
                    if (index < 0) return null;
                    var previous = project.Segments[index];
                    var tracked = PrismJson.Clone(previous);
                    tracked.CropKeyframes = path;
                    tracked.CropTrackingVersion = SubjectFramer.Version;
                    project.Segments[index] = tracked;
                    try { Save(); }
                    catch { project.Segments[index] = previous; throw; }
                    subjectTrackingRevision = null;
                    IsBusy = false;
                    ProjectChanged();
                    Changed(nameof(ActiveSegment));
                    Message = path.Count == 0
                        ? "Prism AI could not frame this Short, so the crop stays centered. Use Re-track to try again."
                        : "Subject tracking ready.";
                    return PrismJson.Clone(tracked);
                }).ConfigureAwait(false);
                if (updated is null) return;
                segment = updated;
            }
            var rendered = await Task.Run(() => Renderer.Preview(video.Path, segment, token), token).ConfigureAwait(false);
            await UI(() =>
            {
                if (!Current()) return;
                PreviewSegment = segment;
                PreviewPath = rendered;
                IsPreviewLoading = false;
            }).ConfigureAwait(false);
        }
        catch (OperationCanceledException) when (token.IsCancellationRequested) { }
        catch (Exception error)
        {
            await UI(() =>
            {
                if (!Current()) return;
                IsPreviewLoading = false;
                PreviewError = error.Message;
                Message = subjectTrackingRevision == revision
                    ? $"Could not save subject tracking: {error.Message}" : $"Could not preview Short: {error.Message}";
            }).ConfigureAwait(false);
        }
        finally
        {
            await UI(() =>
            {
                if (subjectTrackingRevision == revision)
                {
                    subjectTrackingRevision = null;
                    IsBusy = false;
                }
                if (revision == previewRevision) IsPreviewLoading = false;
                if (ReferenceEquals(previewCancellation, cancellation)) previewCancellation = null;
            }).ConfigureAwait(false);
            cancellation.Dispose();
        }
    }

    public Task MakeShort(double? requestedDuration = null)
    {
        var video = project?.Media.FirstOrDefault(m => m.Id == selection && m.Kind == "video")
            ?? project?.Media.FirstOrDefault(m => m.Kind == "video");
        return video is null ? Task.CompletedTask : MakeShorts(video, 1, requestedDuration ?? shortDuration, SourceRegion.EntireVideo);
    }

    public Task ContinueImport()
    {
        if (IsBusy || selection is null) return Task.CompletedTask;
        Screen = Screen.Editor;
        return MakeConfiguredShorts();
    }

    public Task MakeConfiguredShorts()
    {
        var video = project?.Media.FirstOrDefault(m => m.Id == selection && m.Kind == "video")
            ?? project?.Media.FirstOrDefault(m => m.Kind == "video");
        return video is null ? Task.CompletedTask : MakeShorts(video, isShortCountAuto ? 0 : shortCount, shortDuration, shortSourceRegion);
    }

    /// <summary>A re-analysis, which charges part of the video's minutes, waiting for the person to confirm it.</summary>
    public sealed record PaidRun(Guid VideoId, double Minutes, int Count, double Duration, SourceRegion Region);

    PaidRun? pendingPaidRun;
    /// <summary>Shown as the "Use your minutes?" popup; set to null to cancel.</summary>
    public PaidRun? PendingPaidRun { get => pendingPaidRun; set => Set(ref pendingPaidRun, value); }

    /// <summary>Asks the server whether this is a re-analysis and what it costs, then starts the run or asks to confirm the charge.</summary>
    public async Task MakeShorts(MediaItem video, int count, double duration, SourceRegion sourceRegion)
    {
        if (IsBusy || project is null) return;
        // Problems Prism can see at once are reported at once, without a "Preparing" step first.
        if (sourceRegion == SourceRegion.Custom && CustomRangeError is { } rangeError) { Message = rangeError; return; }
        if (!Account.IsSignedIn) { await RunShorts(video, count, duration, sourceRegion); return; }
        var projectId = project.Id;
        // The progress card shows while the video is checked, so Cancel works from the first moment, as on the Mac.
        var cancellation = new CancellationTokenSource();
        generationCancellation = cancellation;
        IsBusy = true;
        GenerationError = null;
        GenerationProgress = 0;
        GenerationStage = "Preparing video…";
        Message = "Preparing video…";
        (int Runs, double Charge)? reanalysis;
        (double Used, double Allowance)? usage = null;
        try
        {
            // A video imported before hashing existed, never analyzed, is hashed now; one already analyzed keeps its old key.
            if (video.ContentHash is null && project.Transcripts?.ContainsKey(PrismJson.Key(video.Id)) != true && project.Segments.All(s => s.MediaId != video.Id)
                && await HashOrNull(video.Path) is { } hash && project?.Id == projectId)
            {
                video.ContentHash = hash;
                try { Save(); } catch (Exception) { video.ContentHash = null; }
            }
            // Without the count Prism can't warn before a re-analysis, so it doesn't start one blind.
            reanalysis = await Account.Reanalysis(UsageLimit.ServerKey(video));
            if (reanalysis is { Runs: > 0 }) usage = await Account.UsageStatus();
        }
        finally
        {
            IsBusy = false;
            GenerationProgress = null;
            if (ReferenceEquals(generationCancellation, cancellation)) generationCancellation = null;
            cancellation.Dispose();
        }
        // Cancelled while checking: nothing started, so nothing is charged and no popup follows.
        if (cancellation.IsCancellationRequested) { Message = ""; return; }
        if (project?.Id != projectId || project.Media.All(m => m.Id != video.Id)) return;
        var unavailable = new GenerationFailure("Prism couldn't check your usage right now. Try again in a moment.", GenerationFailureKind.Temporary);
        if (reanalysis is not { } check) { Message = unavailable.Message; GenerationError = unavailable; return; }
        if (check.Runs == 0) { await RunShorts(video, count, duration, sourceRegion); return; }
        if (usage is not { } account) { Message = unavailable.Message; GenerationError = unavailable; return; }
        var left = Math.Max(0, account.Allowance - account.Used);
        // The server refuses it too; saying so here spares a confirmation that can't succeed.
        if (check.Charge > left)
        {
            Message = $"This re-analysis needs {(int)check.Charge} min, but you have {(int)Math.Floor(left)} min left. Ask for a promo code to get more, then enter it in Settings › Usage.";
            GenerationError = new GenerationFailure(Message, GenerationFailureKind.Limit);
            return;
        }
        Message = "";
        PendingPaidRun = new PaidRun(video.Id, check.Charge, count, duration, sourceRegion);
    }

    /// <summary>Starts the re-analysis the person confirmed.</summary>
    public Task ConfirmPaidRun()
    {
        if (PendingPaidRun is not { } run) return Task.CompletedTask;
        PendingPaidRun = null;
        return project?.Media.FirstOrDefault(m => m.Id == run.VideoId) is { } video ? RunShorts(video, run.Count, run.Duration, run.Region) : Task.CompletedTask;
    }

    async Task RunShorts(MediaItem video, int count, double duration, SourceRegion sourceRegion)
    {
        if (IsBusy || project is null) return;
        if (sourceRegion == SourceRegion.Custom && CustomRangeError is { } rangeError) { Message = rangeError; return; }
        var customStart = sourceRegion == SourceRegion.Custom ? MinuteSeconds(customStartMinutes) : null;
        var customEnd = sourceRegion == SourceRegion.Custom ? MinuteSeconds(customEndMinutes) : null;
        if (GeminiConfiguration(video) is not { } configuration)
        {
            Message = "Sign in to your Prism account to make Shorts.";
            GenerationError = new GenerationFailure(Message, GenerationFailureKind.Settings);
            return;
        }
        // Every request of this run carries the same id, so the server counts it as one analysis.
        configuration.Usage = configuration.Usage with { Run = Guid.NewGuid().ToString() };
        IsBusy = true;
        GenerationProgress = 0;
        GenerationError = null;
        GenerationStage = "Preparing video";
        Message = "Preparing video analysis…";
        var cancellation = new CancellationTokenSource();
        generationCancellation = cancellation;
        var token = cancellation.Token;
        var projectId = project.Id;
        var usedRanges = project.Segments.Where(s => s.MediaId == video.Id).Select(s => new SourceInterval(s.Start, s.Start + s.Duration)).ToList();
        var savedTranscript = project.Transcripts?.GetValueOrDefault(PrismJson.Key(video.Id));
        if (savedTranscript is null && TranscriptFromOtherProjects(video) is { } earlier)
        {
            savedTranscript = earlier;
            StoreTranscript(earlier, video.Id);
        }
        var videoType = shortVideoType;
        var captionStyle = shortCaptionStyle;
        bool Current() => ReferenceEquals(generationCancellation, cancellation) && project?.Id == projectId;
        ScopeGeminiCallbacks(configuration, () => Current() && !token.IsCancellationRequested);
        try
        {
            // The account's server allowance includes promo minutes; the gateway checks it again on every request.
            if (await Account.UsageAllowed(configuration.Usage.Video, configuration.Usage.Minutes, DateTime.Now) == false)
                throw new GeminiException(GeminiFailure.UsageLimit, 429, "You've used your beta allowance. Ask for a promo code to get more, then enter it in Settings › Usage.");
            token.ThrowIfCancellationRequested();
            var results = await Task.Run(() => ShortMaker.Analyze(video.Path, duration, count, sourceRegion, configuration,
                customStart, customEnd, usedRanges, videoType, savedTranscript,
                onTranscript: transcript => Post(() =>
                {
                    if (Current()) StoreTranscript(transcript, video.Id);
                }),
                progress: (fraction, stage) => Post(() =>
                {
                    if (!Current() || token.IsCancellationRequested || GenerationProgress is null || GenerationStage == "Cancelling…") return;
                    GenerationProgress = Math.Max(GenerationProgress ?? 0, fraction);
                    GenerationStage = stage;
                }), cancellation: token), token).ConfigureAwait(false);
            token.ThrowIfCancellationRequested();
            var candidates = results.Select(result => new EditSegment
            {
                MediaId = video.Id, Start = result.Start, Duration = result.Duration, Caption = result.Caption,
                FitToFrame = result.FitToFrame, Captions = result.Captions, CropKeyframes = result.CropKeyframes,
                CropTrackingVersion = SubjectFramer.Version, SpeechWords = result.SpeechWords,
                SuggestedTitle = result.SuggestedTitle, Score = result.Score, SelectionReason = result.SelectionReason, SuggestedDescription = result.SuggestedDescription,
                CaptionNotice = result.AnalysisWarning, CaptionStyle = captionStyle, VideoType = result.VideoType,
                SplitScreen = result.VideoType == VideoType.Podcast ? true : null,
                CaptionPosition = result.VideoType == VideoType.Podcast ? Prism.Core.CaptionPosition.Middle : null,
            }).ToList();
            for (var index = 0; index < candidates.Count; index++)
            {
                if (candidates[index].SplitScreen != true) continue;
                token.ThrowIfCancellationRequested();
                var number = index + 1;
                await UI(() =>
                {
                    if (Current() && !token.IsCancellationRequested) GenerationStage = $"Prism AI · finding both speakers · Short {number} of {candidates.Count}";
                }).ConfigureAwait(false);
                var candidate = candidates[index];
                candidate.SplitCenters = await ShortMaker.FindSplitCenters(video.Path, candidate.Start, candidate.Duration, configuration, token).ConfigureAwait(false);
            }
            token.ThrowIfCancellationRequested();
            await UI(() =>
            {
                if (!Current()) return;
                token.ThrowIfCancellationRequested();
                var fresh = AppendGeneratedShorts(candidates);
                if (fresh.Count == 0)
                {
                    Message = "No new distinct moments were found in this range. Your existing clips were kept. Try another region or length.";
                    GenerationError = new GenerationFailure(Message, GenerationFailureKind.NoMoments);
                    Notified?.Invoke("No new Shorts found", Message);
                    return;
                }
                var resultMessage = $"Prism AI selected {fresh.Count} complete clip ranges and layouts. Review framing and captions before export.";
                if (results.FirstOrDefault(r => r.AnalysisWarning is not null)?.AnalysisWarning is { } warning) resultMessage += " " + warning;
                Message = resultMessage;
                Notified?.Invoke(fresh.Count == 1 ? "1 Short ready" : $"{fresh.Count} Shorts ready", project?.DisplayTitle ?? "Prism");
                Say(false, Message);
                SelectPreview(fresh[0].Id);
                Tutorial.DidCreateVideo();
                // A word-by-word caption style needs exact word timing; it is worked out in the background.
                if (captionStyle.UsesWordTiming()) TimeWordsForAllShorts();
            }).ConfigureAwait(false);
        }
        catch (Exception error)
        {
            await UI(() =>
            {
                if (!Current()) return;
                Message = token.IsCancellationRequested ? "Generation cancelled. Your existing clips were kept." : $"Analysis failed: {error.Message}";
                if (!token.IsCancellationRequested)
                {
                    GenerationError = new GenerationFailure(error.Message, FailureKind(error));
                    Notified?.Invoke("Couldn’t make Shorts", error.Message);
                }
            }).ConfigureAwait(false);
        }
        finally
        {
            await UI(() =>
            {
                if (!ReferenceEquals(generationCancellation, cancellation)) return;
                GenerationProgress = null;
                generationCancellation = null;
                IsBusy = false;
            }).ConfigureAwait(false);
            cancellation.Dispose();
        }
    }

    /// <summary>A long task finished: a run made Shorts or failed, an export finished or failed. The app tells a person who
    /// switched away, as the Mac does with a notification.</summary>
    public event Action<string, string>? Notified;

    public void CancelGeneration()
    {
        if (generationCancellation is null) return;
        GenerationStage = "Cancelling…";
        generationCancellation.Cancel();
    }

    /// <summary>Commits only new, distinct ranges; saving failure restores the entire previous batch.</summary>
    public List<EditSegment> AppendGeneratedShorts(IEnumerable<EditSegment> candidates)
    {
        if (project is null) return [];
        var previous = project.Segments;
        var fresh = new List<EditSegment>();
        foreach (var candidate in candidates)
        {
            if (!double.IsFinite(candidate.Start) || !double.IsFinite(candidate.Duration) || candidate.Start < 0 || candidate.Duration <= 0)
                throw new ShortMakerException(ShortMakerFailure.InvalidRange);
            var video = project.Media.FirstOrDefault(m => m.Id == candidate.MediaId && m.Kind == "video")
                ?? throw new ShortMakerException(ShortMakerFailure.NoVideo);
            if (candidate.Start + candidate.Duration > video.Duration + 0.05)
                throw new ShortMakerException(ShortMakerFailure.InvalidRange);
            if (previous.Concat(fresh).Any(existing => existing.Id == candidate.Id || existing.MediaId == candidate.MediaId
                && TranscriptSelection.Overlaps(candidate.Start, candidate.Duration, existing.Start, existing.Duration))) continue;
            fresh.Add(PrismJson.Clone(candidate));
        }
        if (fresh.Count == 0) return [];
        var snapshot = PrismJson.Clone(previous);
        project.Segments = [.. previous, .. fresh];
        try { Save(); }
        catch { project.Segments = previous; throw; }
        ClearRedo();
        editHistory.Add(snapshot);
        Changed(nameof(CanUndo));
        ProjectChanged();
        return fresh;
    }

    public void ChooseExport(Guid? only = null)
    {
        if (IsBusy || project is null || project.Media.Count == 0) return;
        ExportChoice = new ExportChoice(project.Segments.Where(s => only is null || s.Id == only).Select(s => s.Id).ToHashSet(),
            false, Settings.ExportQuality, DefaultExportFolder(),
            Titles: project.Segments.ToDictionary(s => s.Id, s => s.SuggestedTitle ?? ""),
            Descriptions: project.Segments.ToDictionary(s => s.Id, s => s.SuggestedDescription ?? ""));
    }

    bool isWritingDescriptions;
    /// <summary>True while the export card asks Prism AI for missing descriptions.</summary>
    public bool IsWritingDescriptions { get => isWritingDescriptions; private set => Set(ref isWritingDescriptions, value); }

    /// <summary>Fills the export card's empty descriptions with one Prism AI request; titles and typed text are kept.</summary>
    public async Task WriteMissingDescriptions()
    {
        if (ExportChoice is not { } choice || project is null || IsWritingDescriptions) return;
        string Description(EditSegment s) => choice.Descriptions?.GetValueOrDefault(s.Id) ?? s.SuggestedDescription ?? "";
        var missing = project.Segments.Where(s => Description(s).Trim().Length == 0).ToList();
        if (missing.Count == 0) return;
        if (project.Media.FirstOrDefault(m => m.Id == missing[0].MediaId) is not { } video || GeminiConfiguration(video) is not { } configuration)
        { ExportChoice = choice with { Error = "Sign in to your Prism account to write descriptions." }; return; }
        IsWritingDescriptions = true;
        try
        {
            var written = await GeminiSelection.Describe(missing.Select(s => (choice.Titles?.GetValueOrDefault(s.Id) ?? s.SuggestedTitle ?? "",
                string.Join(" ", (s.Captions ?? []).Select(c => c.Text)))).ToList(), configuration);
            // The card may have changed while the request ran; only still-empty fields are filled.
            if (ExportChoice is not { } current) return;
            var descriptions = new Dictionary<Guid, string>(current.Descriptions ?? new Dictionary<Guid, string>());
            foreach (var (index, text) in written)
                if ((descriptions.GetValueOrDefault(missing[index].Id) ?? "").Length == 0) descriptions[missing[index].Id] = text;
            ExportChoice = current with
            {
                Descriptions = descriptions,
                Error = written.Count < missing.Count ? $"Prism AI wrote {written.Count} of {missing.Count} descriptions. Write the rest yourself or try again." : null,
            };
        }
        catch (Exception error) { if (ExportChoice is { } current) ExportChoice = current with { Error = "Couldn't write descriptions: " + error.Message }; }
        finally { IsWritingDescriptions = false; }
    }

    /// <summary>A free name for a Short's MP4 whose notes file is free too.</summary>
    static string ExportDestination(string name, string folder)
    {
        var destination = Path.Combine(folder, name + ".mp4");
        for (var copy = 2; File.Exists(destination) || Directory.Exists(destination) || File.Exists(Renderer.NotesPath(destination)); copy++)
            destination = Path.Combine(folder, $"{name} {copy}.mp4");
        return destination;
    }

    public string DefaultExportFolder() => Path.Combine(platform.DownloadsFolder, "Prism", ExportFileName(project?.DisplayTitle) ?? "Prism export");

    public Task ExportAll()
    {
        ChooseExport();
        return ExportChoice is { } choice ? Export(choice) : Task.CompletedTask;
    }

    /// <summary>Renders the checked Shorts in project order, then copies the untouched main videos.</summary>
    public async Task Export(ExportChoice choice)
    {
        if (IsBusy || project is null) return;
        // Titles and descriptions edited on the card stay on the Shorts, and go into the files below.
        var previous = PrismJson.Clone(project.Segments);
        var edited = false;
        foreach (var segment in project.Segments)
        {
            if (choice.Titles?.GetValueOrDefault(segment.Id) is { } title && title != (segment.SuggestedTitle ?? "")) { segment.SuggestedTitle = title; edited = true; }
            if (choice.Descriptions?.GetValueOrDefault(segment.Id) is { } description && description != (segment.SuggestedDescription ?? "")) { segment.SuggestedDescription = description; edited = true; }
        }
        if (edited)
        {
            try { Save(); ProjectChanged(); }
            catch (Exception error)
            {
                project.Segments = previous;
                ExportChoice = choice with { Error = $"Could not save the titles: {error.Message}" };
                return;
            }
        }
        var segments = project.Segments.Select((segment, index) => (Segment: PrismJson.Clone(segment), Number: index + 1))
            .Where(pair => choice.ShortIds.Contains(pair.Segment.Id)).ToList();
        var media = PrismJson.Clone(project.Media);
        var sources = choice.IncludeSource ? media.Where(m => m.Kind == "video").ToList() : [];
        if (segments.Count == 0 && sources.Count == 0) return;
        try { Directory.CreateDirectory(choice.Folder); }
        catch (Exception error)
        {
            ExportChoice = choice with { Error = $"Could not use this folder: {error.Message} Choose another folder." };
            return;
        }
        try { Settings.ExportQuality = choice.Quality; Settings.Save(); }
        catch (Exception error)
        {
            ExportChoice = choice with { Error = $"Could not save export settings: {error.Message}" };
            return;
        }
        ExportChoice = null;
        ExportSummary = null;
        var projectId = project.Id;
        var projectName = project.DisplayTitle;
        var folder = choice.Folder;
        var total = segments.Count + sources.Count;
        ExportedFiles = [];
        Changed(nameof(ExportedFiles));
        LastExportFolder = folder;
        LastExportQuality = choice.Quality;
        LastExportShortCount = segments.Count;
        Changed(nameof(LastExportQuality));
        Changed(nameof(LastExportShortCount));
        IsBusy = true;
        IsExporting = true;
        GenerationProgress = 0;
        GenerationStage = "Preparing export";
        GenerationError = null;
        Message = total == 1 ? "Exporting 1 file…" : $"Exporting {total} files…";
        var cancellation = new CancellationTokenSource();
        generationCancellation = cancellation;
        var token = cancellation.Token;
        bool Current() => ReferenceEquals(generationCancellation, cancellation) && project?.Id == projectId;
        try
        {
            for (var step = 0; step < segments.Count; step++)
            {
                token.ThrowIfCancellationRequested();
                var (segment, number) = segments[step];
                var currentStep = step;
                await UI(() =>
                {
                    if (!Current() || token.IsCancellationRequested) return;
                    GenerationProgress = (double)currentStep / total;
                    GenerationStage = $"Exporting Short {number} · {currentStep + 1} of {total}";
                }).ConfigureAwait(false);
                var video = media.FirstOrDefault(m => m.Id == segment.MediaId) ?? throw new ShortMakerException(ShortMakerFailure.NoVideo);
                // Framing at export counts against the Short's own video, like every other request.
                var configuration = await UI(() => GeminiConfiguration(video)).ConfigureAwait(false);
                if (configuration is not null) ScopeGeminiCallbacks(configuration, () => Current() && !token.IsCancellationRequested);
                if (segment.CropTrackingVersion != SubjectFramer.Version && segment.SplitScreen != true && configuration is not null)
                {
                    await UI(() => { if (Current() && !token.IsCancellationRequested) Message = $"Prism AI is framing Short {number}…"; }).ConfigureAwait(false);
                    segment.CropKeyframes = await SubjectFramer.Analyze(video.Path, segment.Start, segment.Duration,
                        segment.CropZoom ?? 1.08, configuration, segment.Captions, cancellation: token).ConfigureAwait(false);
                    token.ThrowIfCancellationRequested();
                    segment.CropTrackingVersion = SubjectFramer.Version;
                    await UI(() =>
                    {
                        if (!Current() || project is null || token.IsCancellationRequested) return;
                        var index = project.Segments.FindIndex(s => s.Id == segment.Id);
                        if (index < 0) return;
                        var previous = project.Segments[index];
                        var tracked = PrismJson.Clone(previous);
                        tracked.CropKeyframes = segment.CropKeyframes;
                        tracked.CropTrackingVersion = SubjectFramer.Version;
                        project.Segments[index] = tracked;
                        try { Save(); }
                        catch { project.Segments[index] = previous; throw; }
                        ProjectChanged();
                        Changed(nameof(ActiveSegment));
                    }).ConfigureAwait(false);
                }
                await UI(() => { if (Current() && !token.IsCancellationRequested) Message = $"Rendering Short {number}…"; }).ConfigureAwait(false);
                token.ThrowIfCancellationRequested();
                var name = ExportFileName(segment.SuggestedTitle) ?? $"{ExportFileName(projectName) ?? "Prism"} Short {number}";
                var destination = ExportDestination(name, folder);
                await Task.Run(() => Renderer.Export(video.Path, segment, destination, choice.Quality,
                    fraction => Post(() =>
                    {
                        if (Current() && !token.IsCancellationRequested && GenerationProgress is not null)
                            GenerationProgress = Math.Max(GenerationProgress ?? 0, (currentStep + fraction) / total);
                    }), token), token).ConfigureAwait(false);
                await UI(() =>
                {
                    if (!Current()) return;
                    ExportedFiles.Add(destination);
                    Changed(nameof(ExportedFiles));
                }).ConfigureAwait(false);
            }
            foreach (var video in sources)
            {
                token.ThrowIfCancellationRequested();
                await UI(() =>
                {
                    if (!Current() || token.IsCancellationRequested) return;
                    GenerationProgress = (double)ExportedFiles.Count / total;
                    GenerationStage = "Copying the main video";
                }).ConfigureAwait(false);
                var destination = UniqueDestination(video.Path, folder);
                var created = false;
                try
                {
                    await using var input = new FileStream(video.Path, FileMode.Open, FileAccess.Read, FileShare.Read, 81920, true);
                    await using var output = new FileStream(destination, FileMode.CreateNew, FileAccess.Write, FileShare.None, 81920, true);
                    created = true;
                    await input.CopyToAsync(output, token).ConfigureAwait(false);
                }
                catch
                {
                    if (created) try { File.Delete(destination); } catch { }
                    throw;
                }
                await UI(() =>
                {
                    if (!Current()) return;
                    ExportedFiles.Add(destination);
                    Changed(nameof(ExportedFiles));
                }).ConfigureAwait(false);
            }
            token.ThrowIfCancellationRequested();
            await UI(() =>
            {
                if (!Current()) return;
                token.ThrowIfCancellationRequested();
                var parts = new List<string>();
                if (segments.Count > 0) parts.Add(segments.Count == 1 ? "1 Short" : $"{segments.Count} Shorts");
                if (sources.Count > 0) parts.Add("the main video");
                Message = $"Exported {string.Join(" and ", parts)} to {DisplayPath(folder)}.";
                ExportSummary = Message;
                Notified?.Invoke("Export finished", Message);
                // The website keeps the Mac app's quality names: full, compact, small.
                _ = Account.RecordExport(segments.Count, segments.Sum(item => item.Segment.Duration), choice.Quality.ToString().ToLowerInvariant());
            }).ConfigureAwait(false);
        }
        catch (Exception error)
        {
            await UI(() =>
            {
                if (!Current()) return;
                var completed = ExportedFiles.Count;
                Message = token.IsCancellationRequested
                    ? $"Export cancelled. {completed} of {total} files finished in {DisplayPath(folder)}."
                    : completed == 0 ? $"Export failed: {error.Message}"
                    : $"Export stopped after {completed} of {total} files. Completed files are in {DisplayPath(folder)}. {error.Message}";
                if (token.IsCancellationRequested) ExportSummary = Message;
                else
                {
                    GenerationError = new GenerationFailure(Message, FailureKind(error), IsExport: true);
                    Notified?.Invoke("Export failed", Message);
                }
            }).ConfigureAwait(false);
        }
        finally
        {
            await UI(() =>
            {
                if (!ReferenceEquals(generationCancellation, cancellation)) return;
                generationCancellation = null;
                IsBusy = false;
                IsExporting = false;
                GenerationProgress = null;
            }).ConfigureAwait(false);
            cancellation.Dispose();
        }
    }

    public void RevealExports()
    {
        if (ExportedFiles.Count > 0) { platform.Reveal(ExportedFiles); return; }
        var folder = new[] { LastExportFolder, project is null ? null : DefaultExportFolder() }
            .OfType<string>().FirstOrDefault(Directory.Exists) ?? (projectPath is null ? null : Path.Combine(projectPath, "Exports"));
        if (folder is not null) platform.OpenFolder(folder);
    }
}
