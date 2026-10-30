using System.Globalization;
using System.Text.RegularExpressions;

namespace Prism.Core;

public sealed partial class AppSession
{
    void RememberEdit()
    {
        editHistory.Add(PrismJson.Clone(project?.Segments ?? []));
        Changed(nameof(CanUndo));
    }

    void ForgetLastEdit()
    {
        if (editHistory.Count > 0) editHistory.RemoveAt(editHistory.Count - 1);
        Changed(nameof(CanUndo));
    }

    void ClearRedo()
    {
        redoHistory.Clear();
        Changed(nameof(CanRedo));
    }

    static string FormatSeconds(double value) => Math.Round(value) == value
        ? value.ToString("0", CultureInfo.InvariantCulture) + " seconds"
        : value.ToString("0.0", CultureInfo.InvariantCulture) + " seconds";

    /// <summary>Edits a copy, commits it only after validation, and keeps an independent undo snapshot.
    /// An explicit target never changes which Short is open.</summary>
    public string? ApplyEdit(Guid? to, bool captionsOnly, Func<EditSegment, MediaItem, string?> change)
    {
        if (project is null) return null;
        var index = project.Segments.FindIndex(s => s.Id == (to ?? PreviewShortId));
        if (index < 0 && to is not null) return null;
        if (index < 0 && project.Segments.Count > 0) index = 0;
        var original = index >= 0 ? project.Segments[index] : null;
        var video = original is null ? project.Media.FirstOrDefault(m => m.Kind == "video")
            : project.Media.FirstOrDefault(m => m.Id == original.MediaId);
        if (video is null) return null;
        var candidate = original is null ? new EditSegment { MediaId = video.Id, Duration = Math.Min(video.Duration, 30) }
            : PrismJson.Clone(original);
        var reply = change(candidate, video);
        if (reply is null) return null;
        var previous = PrismJson.Clone(project.Segments);
        RememberEdit();
        if (index < 0) project.Segments.Add(candidate);
        else project.Segments[index] = candidate;
        try
        {
            Save();
            ClearRedo();
            ProjectChanged();
            // Native players show the rendered caption track, so wording and layout changes need a fresh preview too.
            if (to is null || to == PreviewShortId) SelectPreview(candidate.Id);
            Message = reply;
            return reply;
        }
        catch (Exception error)
        {
            project.Segments = previous;
            ForgetLastEdit();
            ProjectChanged();
            return "Could not save the edit: " + error.Message;
        }
    }

    public string? ApplyEdit(Func<EditSegment, MediaItem, string?> change, Guid? to = null, bool captionsOnly = false) => ApplyEdit(to, captionsOnly, change);

    public void SetFraming(bool fit)
    {
        if (IsBusy) return;
        if (ApplyEdit((segment, _) =>
        {
            segment.FitToFrame = fit;
            segment.SplitScreen = null;
            if (fit) segment.CropZoom = 1;
            return fit ? "The full source frame will be visible in the vertical video." : "The vertical crop follows the saved focus path.";
        }) is { } reply) Message = reply;
    }

    public async Task SetSplitScreen()
    {
        if (IsBusy || ActiveSegment is not { } active || project?.Media.FirstOrDefault(m => m.Id == active.MediaId) is not { } video) return;
        if (active.SplitCenters is not null)
        {
            ApplyEdit((segment, _) =>
            {
                segment.SplitScreen = true;
                segment.CaptionPosition = CaptionPosition.Middle;
                return "Split screen: left person on top, right person on the bottom, captions in the middle.";
            });
            return;
        }
        if (GeminiConfiguration(video) is not { } configuration) { Message = "Sign in to your Prism account in Settings first."; return; }
        var target = PrismJson.Clone(active);
        var projectId = project!.Id;
        IsBusy = true;
        Message = "Prism AI is finding both speakers…";
        try
        {
            var centers = await ShortMaker.FindSplitCenters(video.Path, target.Start, target.Duration, configuration);
            await UI(() =>
            {
                IsBusy = false;
                if (project?.Id != projectId) return;
                var reply = ApplyEdit(target.Id, false, (segment, _) =>
                {
                    segment.SplitScreen = true;
                    segment.CaptionPosition = CaptionPosition.Middle;
                    segment.SplitCenters = centers;
                    return centers is null
                        ? "Split screen on. Couldn't find two faces, so the left half is on top and the right half on the bottom."
                        : "Split screen: each speaker is centered in their half, captions in the middle.";
                });
                if (reply is null) Message = "The Short was removed before split screen was ready.";
                else Message = reply;
            });
        }
        catch (Exception error)
        {
            await UI(() => { IsBusy = false; Message = "Could not find both speakers: " + error.Message; });
        }
    }

    public void HoldFramingAtCenter()
    {
        if (IsBusy) return;
        ApplyEdit((segment, _) =>
        {
            segment.CropPosition = 0.5;
            segment.CropKeyframes = [];
            segment.CropTrackingVersion = SubjectFramer.Version;
            return "Framing centered and held steady. Re-track subject to follow movement.";
        });
    }

    public async Task RegenerateSelectedSubtitles()
    {
        if (IsBusy || ActiveSegment is not { } active || project?.Media.FirstOrDefault(m => m.Id == active.MediaId) is not { } video)
        { Message = "Select a Short before generating subtitles."; return; }
        if (GeminiConfiguration(video) is not { } configuration) { Message = "Sign in to your Prism account in Settings first."; return; }
        var target = PrismJson.Clone(active);
        var projectId = project!.Id;
        IsBusy = true;
        Message = "Prism AI is transcribing this Short…";
        try
        {
            var cloud = await GeminiSelection.RegenerateCaptions(video.Path, (target.Start, target.Start + target.Duration), configuration);
            await UI(() =>
            {
                IsBusy = false;
                if (project?.Id != projectId || project.Segments.All(s => s.Id != target.Id))
                { Message = "The Short was removed before its subtitles were ready."; return; }
                if (cloud.Cues.Count == 0)
                { Message = "No speech was detected in this Short. Check the audio and spoken language."; return; }
                var cues = cloud.Cues.Select(c => new TimedCaption(c.Text, c.Start - target.Start, c.Duration)).ToList();
                var words = cloud.Words.Select(w => new TimedSpeechWord(w.Text, w.Start - target.Start, w.Duration)).ToList();
                var reply = ApplyEdit(target.Id, false, (segment, _) =>
                {
                    segment.Captions = cues;
                    segment.SpeechWords = words;
                    segment.CaptionNotice = cloud.Notice;
                    return $"Added {cues.Count} timed subtitle phrases." + (cloud.Notice is null ? "" : " " + cloud.Notice);
                });
                Message = reply is null ? "The Short was removed before its subtitles were ready."
                    : reply.StartsWith("Could not save the edit:", StringComparison.Ordinal)
                        ? "Could not save subtitles:" + reply["Could not save the edit:".Length..] : reply;
            });
        }
        catch (Exception error)
        {
            await UI(() => { IsBusy = false; Message = "Could not transcribe Short: " + error.Message; });
        }
    }

    public void UndoFromEditor()
    {
        if (!IsBusy) Message = UndoEdit();
    }

    public string UndoEdit()
    {
        if (project is null || editHistory.Count == 0) return "There isn’t an edit to undo yet.";
        var previous = PrismJson.Clone(editHistory[^1]);
        var current = project.Segments;
        project.Segments = previous;
        try
        {
            Save();
            redoHistory.Add(PrismJson.Clone(current));
            Changed(nameof(CanRedo));
            ForgetLastEdit();
            ProjectChanged();
            var restored = previous.Any(s => s.Id == PreviewShortId) ? PreviewShortId : previous.FirstOrDefault()?.Id;
            SelectPreview(restored);
            return "Undone. I restored the previous timeline edit.";
        }
        catch (Exception error)
        {
            project.Segments = current;
            ProjectChanged();
            return "Could not save undo: " + error.Message;
        }
    }

    public void RedoFromEditor()
    {
        if (!IsBusy) Message = RedoEdit();
    }

    public string RedoEdit()
    {
        if (project is null || redoHistory.Count == 0) return "There isn’t an edit to redo yet.";
        var current = project.Segments;
        var next = PrismJson.Clone(redoHistory[^1]);
        project.Segments = next;
        try
        {
            Save();
            editHistory.Add(PrismJson.Clone(current));
            redoHistory.RemoveAt(redoHistory.Count - 1);
            Changed(nameof(CanUndo)); Changed(nameof(CanRedo));
            ProjectChanged();
            SelectPreview(next.Any(s => s.Id == PreviewShortId) ? PreviewShortId : next.FirstOrDefault()?.Id);
            return "Redone. I restored the next timeline edit.";
        }
        catch (Exception error)
        {
            project.Segments = current;
            ProjectChanged();
            return "Could not save redo: " + error.Message;
        }
    }

    public void RemoveShort(Guid id)
    {
        if (IsBusy || project is null) return;
        var index = project.Segments.FindIndex(s => s.Id == id);
        if (index < 0) return;
        var wasPreviewed = PreviewShortId == id;
        var next = project.Segments.FirstOrDefault(s => s.Id != id)?.Id;
        var previous = PrismJson.Clone(project.Segments);
        RememberEdit();
        project.Segments.RemoveAt(index);
        try
        {
            Save();
            ClearRedo();
            ProjectChanged();
            if (wasPreviewed) SelectPreview(next);
            Message = "Removed Short. Use Undo to restore it.";
        }
        catch (Exception error)
        {
            project.Segments = previous;
            ForgetLastEdit();
            ProjectChanged();
            Message = "Could not remove Short: " + error.Message;
        }
    }

    public void ToggleSelectedAudio()
    {
        if (IsBusy || ActiveSegment is null) return;
        if (ApplyEdit((segment, _) =>
        {
            segment.IsMuted = segment.IsMuted != true;
            return segment.IsMuted == true ? "Clip audio muted." : "Source audio restored.";
        }) is { } reply) Message = reply;
    }

    public void SetSelectedCaptionStyle(CaptionStyle style)
    {
        if (IsBusy || ActiveSegment is null) return;
        if (ApplyEdit((segment, _) => { segment.CaptionStyle = style; return style.Title() + " subtitles applied."; }, captionsOnly: true) is { } reply) Message = reply;
    }

    public void SetSelectedCaptionLayout(CaptionPosition? position = null, CaptionSize? size = null, bool? animated = null)
    {
        if (IsBusy || ActiveSegment is null) return;
        if (ApplyEdit((segment, _) =>
        {
            if (position is not null) segment.CaptionPosition = position;
            if (size is not null) segment.CaptionSize = size;
            if (animated is not null) segment.CaptionAnimated = animated;
            return "Subtitle layout saved.";
        }, captionsOnly: true) is { } reply) Message = reply;
    }

    public void UpdateSelectedCaptionTexts(IReadOnlyList<string> texts)
    {
        if (IsBusy || ActiveSegment?.Captions is not { } cues || texts.Count != cues.Count) return;
        if (ApplyEdit((segment, _) =>
        {
            segment.Captions = cues.Zip(texts).Where(pair => pair.Second.Trim().Length > 0)
                .Select(pair => new TimedCaption(pair.Second.Trim(), pair.First.Start, pair.First.Duration)).ToList();
            return "Caption text saved.";
        }, captionsOnly: true) is { } reply) Message = reply;
    }

    public void UpdateSelectedEdit(double start, double duration, string caption, double captionStart, double captionDuration,
        double cropZoom = 1.08, double cropPosition = 0.5)
    {
        if (IsBusy || ActiveSegment is null) return;
        var reply = ApplyEdit((segment, media) =>
        {
            if (!double.IsFinite(captionStart) || !double.IsFinite(captionDuration) || !double.IsFinite(cropZoom) || !double.IsFinite(cropPosition)
                || captionDuration <= 0 || cropZoom < 1 || cropZoom > 1.5 || cropPosition < 0 || cropPosition > 1
                || !Rebase(segment, media, start, duration)) return null;
            var finalCaptionStart = Math.Min(Math.Max(0, captionStart), Math.Max(0, segment.Duration - 0.05));
            var finalCaptionDuration = Math.Min(captionDuration, segment.Duration - finalCaptionStart);
            if (finalCaptionDuration <= 0) return null;
            segment.Caption = caption;
            segment.CropZoom = cropZoom;
            segment.CropPosition = cropPosition;
            segment.CaptionStart = finalCaptionStart;
            segment.CaptionDuration = finalCaptionDuration;
            return Math.Abs(segment.Start - start) > 0.005 || Math.Abs(segment.Duration - duration) > 0.005
                ? $"Clip changes saved on complete speech boundaries ({FormatSeconds(segment.Duration)})." : "Clip changes saved.";
        });
        Message = reply ?? "Choose valid clip and text ranges within the source and clip duration.";
    }

    /// <summary>Moves captions, speech and focus points with a source range while preserving complete words and scene cuts.</summary>
    public static bool Rebase(EditSegment segment, MediaItem media, double start, double duration)
    {
        if (!double.IsFinite(start) || !double.IsFinite(duration) || start < 0 || duration <= 0 || start + duration > media.Duration + 0.001) return false;
        var oldStart = segment.Start;
        var absoluteWords = (segment.SpeechWords ?? []).Select(w => new TimedSpeechWord(w.Text, oldStart + w.Start, w.Duration)).ToList();
        var finalStart = start;
        if (absoluteWords.FirstOrDefault(w => w.Start + 0.02 < finalStart && w.Start + w.Duration - 0.02 > finalStart) is { } startWord)
            finalStart = Math.Max(0, startWord.Start);
        var finalEnd = Math.Min(media.Duration, finalStart + duration);
        if (absoluteWords.FirstOrDefault(w => w.Start + 0.02 < finalEnd && w.Start + w.Duration - 0.02 > finalEnd) is { } endWord)
        {
            var wordEnd = endWord.Start + endWord.Duration;
            finalEnd = wordEnd <= media.Duration ? wordEnd + 0.04 : Math.Max(finalStart + 0.1, endWord.Start);
            finalEnd = Math.Min(media.Duration, finalEnd);
        }
        var finalDuration = finalEnd - finalStart;
        if (finalDuration <= 0) return false;
        if (segment.Captions is { } captions)
            segment.Captions = captions.Select(c => (Cue: c, Start: Math.Max(finalStart, oldStart + c.Start), End: Math.Min(finalEnd, oldStart + c.Start + c.Duration)))
                .Where(c => c.End > c.Start).Select(c => new TimedCaption(c.Cue.Text, c.Start - finalStart, c.End - c.Start)).ToList();
        segment.SpeechWords = absoluteWords.Where(w => w.Start >= finalStart - 0.01 && w.Start + w.Duration <= finalEnd + 0.01)
            .Select(w => new TimedSpeechWord(w.Text, w.Start - finalStart, w.Duration)).ToList();
        if (segment.CropKeyframes is { Count: > 0 } path)
        {
            var points = path.Select(p => p with { Time = oldStart + p.Time }).OrderBy(p => p.Time).ToList();
            double PositionAt(double time)
            {
                if (time <= points[0].Time) return points[0].Position;
                if (time >= points[^1].Time) return points[^1].Position;
                var rightIndex = points.FindIndex(p => p.Time >= time);
                var left = points[rightIndex - 1]; var right = points[rightIndex];
                if (right.IsSceneCut == true && time < right.Time) return left.Position;
                var fraction = (time - left.Time) / Math.Max(0.001, right.Time - left.Time);
                return left.Position + (right.Position - left.Position) * fraction;
            }
            bool? WholeFrameAt(double time) => (points.LastOrDefault(p => p.Time <= time) ?? points[0]).PreserveWholeFrame;
            var rebased = points.Where(p => p.Time > finalStart && p.Time < finalEnd).Select(p => p with { Time = p.Time - finalStart }).ToList();
            rebased.Insert(0, new CropKeyframe(0, PositionAt(finalStart), null, WholeFrameAt(finalStart)));
            rebased.Add(new CropKeyframe(finalDuration, PositionAt(finalEnd), null, WholeFrameAt(finalEnd)));
            segment.CropKeyframes = rebased;
        }
        segment.Start = finalStart;
        segment.Duration = finalDuration;
        return true;
    }

    public void AdjustCropKeyframe(double from, double to, double position, bool insert)
    {
        if (IsBusy || ActiveSegment is not { } active || !double.IsFinite(from) || !double.IsFinite(to) || !double.IsFinite(position)
            || to < 0 || to > active.Duration || position < 0 || position > 1) return;
        ApplyEdit((segment, _) =>
        {
            var bias = (segment.CropPosition ?? 0.5) - 0.5;
            var stored = position - bias;
            var points = segment.CropKeyframes is null
                ? new List<CropKeyframe> { new(0, 0.5), new(segment.Duration, 0.5) } : new List<CropKeyframe>(segment.CropKeyframes);
            if (stored is < 0 or > 1)
            {
                // Keep the current visible path while making the full 0–1 focus range reachable.
                points = points.Select(p => p with { Position = Math.Clamp(p.Position + bias, 0, 1) }).ToList();
                segment.CropPosition = 0.5;
                stored = position;
            }
            var nearest = points.Count == 0 ? -1 : Enumerable.Range(0, points.Count).MinBy(i => Math.Abs(points[i].Time - (insert ? to : from)));
            if (insert)
            {
                if (nearest >= 0 && Math.Abs(points[nearest].Time - to) < 0.18) points[nearest] = points[nearest] with { Position = stored };
                else points.Add(new CropKeyframe(to, stored));
            }
            else if (nearest >= 0) points[nearest] = points[nearest] with { Time = to, Position = stored };
            var unique = new List<CropKeyframe>();
            foreach (var point in points.Where(p => double.IsFinite(p.Time) && double.IsFinite(p.Position))
                         .Select(p => p with { Time = Math.Clamp(p.Time, 0, segment.Duration), Position = Math.Clamp(p.Position, 0, 1) }).OrderBy(p => p.Time))
            {
                if (unique.Count > 0 && Math.Abs(unique[^1].Time - point.Time) < 0.02)
                {
                    // Coincident points still carry the shot boundary and whole-frame metadata.
                    unique[^1] = point with { IsSceneCut = point.IsSceneCut == true || unique[^1].IsSceneCut == true ? true : point.IsSceneCut,
                        PreserveWholeFrame = point.PreserveWholeFrame ?? unique[^1].PreserveWholeFrame };
                }
                else unique.Add(point);
            }
            segment.CropKeyframes = unique;
            return insert ? "Subject focus point added." : "Subject focus point moved.";
        });
    }

    public void RetrackSelectedSubject()
    {
        if (IsBusy || ActiveSegment is not { } clip) return;
        var reply = ApplyEdit(clip.Id, false, (segment, _) => { segment.CropTrackingVersion = 0; return "Prism AI is tracking the subject…"; });
        if (reply is not null) Message = reply.StartsWith("Could not save the edit:", StringComparison.Ordinal)
            ? "Could not refresh subject tracking:" + reply["Could not save the edit:".Length..] : reply;
    }

    public void AddManualClip()
    {
        if (IsBusy || project?.Media.FirstOrDefault(m => m.Id == Selection) is not { Duration: > 0 } video) return;
        var time = PreviewShortId is null ? Player?.CurrentTime ?? 0 : 0;
        var start = Math.Min(Math.Max(0, double.IsFinite(time) ? time : 0), Math.Max(0, video.Duration - 1));
        var duration = Math.Min(ShortDuration, video.Duration - start);
        if (!double.IsFinite(duration) || duration <= 0) return;
        var previous = PrismJson.Clone(project.Segments);
        var clip = new EditSegment { MediaId = video.Id, Start = start, Duration = duration };
        RememberEdit();
        project.Segments.Add(clip);
        try
        {
            Save();
            ClearRedo();
            ProjectChanged();
            SelectPreview(clip.Id);
            Message = "Clip added. Adjust its timing in the inspector.";
        }
        catch (Exception error)
        {
            project.Segments = previous;
            ForgetLastEdit();
            ProjectChanged();
            Message = "Could not save clip: " + error.Message;
        }
    }

    public void TogglePlayback()
    {
        if (Player is not { } player) return;
        if (player.CurrentTime >= PreviewLength - 0.1) SeekPreview(0);
        player.TogglePlayback();
    }

    public void SeekPreviewBy(double seconds)
    {
        if (Player is { } player) SeekPreview(player.CurrentTime + seconds);
    }

    public void SeekPreview(double seconds)
    {
        if (double.IsFinite(seconds)) Player?.Seek(Math.Clamp(seconds, 0, Math.Max(0, PreviewLength)));
    }

    public async Task SendChat(string? suggestedText = null)
    {
        if (IsBusy) return;
        var text = (suggestedText ?? ChatInput).Trim();
        if (text.Length == 0) return;
        ChatInput = "";
        Say(true, text);
        if (project?.Media.Count is not > 0) { Say(false, "Import a video first, then I can edit it."); return; }
        var segment = ActiveSegment ?? project.Segments.FirstOrDefault();
        var media = project.Media.FirstOrDefault(m => m.Id == segment?.MediaId) ?? project.Media.FirstOrDefault(m => m.Id == selection) ?? project.Media[0];
        if (GeminiConfiguration(media) is not { } configuration)
        { Message = "Sign in to your Prism account in Settings first."; Say(false, Message); return; }
        var summary = $"video {FormatSeconds(media?.Duration ?? 0)}; current edit {FormatSeconds(segment?.Duration ?? 0)}; caption {segment?.Caption ?? "none"}";
        var conversation = string.Join(" / ", chatMessages.SkipLast(1).TakeLast(6).Select(m => (m.IsUser ? "User: " : "Assistant: ") + m.Text));
        IsBusy = true;
        Message = "Prism AI is planning your edit…";
        try
        {
            var command = await GeminiSelection.Interpret(text, summary, conversation, configuration);
            await UI(() =>
            {
                IsBusy = false;
                ExecuteAICommand(command, text);
            });
        }
        catch (Exception error)
        {
            await UI(() => { IsBusy = false; Message = "Prism AI could not plan this edit: " + error.Message; Say(false, Message); });
        }
    }

    public void ExecuteAICommand(GeminiSelection.EditCommand command, string originalRequest)
    {
        double? Value(int index) => index >= 0 && index < command.Arguments.Count
            && double.TryParse(command.Arguments[index].Trim(), NumberStyles.Float, CultureInfo.InvariantCulture, out var number) && double.IsFinite(number) ? number : null;
        string? reply;
        switch (command.Action)
        {
            case "OVERLAY":
                var caption = command.Arguments.FirstOrDefault();
                if (string.IsNullOrEmpty(caption)) { HandleFallback(originalRequest); return; }
                var start = Value(1) ?? 0; var duration = Value(2);
                reply = ApplyEdit((segment, _) =>
                {
                    segment.Caption = caption;
                    segment.CaptionStart = Math.Clamp(start, 0, segment.Duration);
                    segment.CaptionDuration = Math.Clamp(duration ?? segment.Duration - segment.CaptionStart.Value, 0, segment.Duration - segment.CaptionStart.Value);
                    return $"{EditingAIName} added “{caption}” from {FormatSeconds(segment.CaptionStart.Value)} to {FormatSeconds(segment.CaptionStart.Value + segment.CaptionDuration.Value)}.";
                });
                Say(false, reply ?? "I couldn't apply that overlay.");
                break;
            case "TRIM":
                if (Value(0) is not { } newDuration) { HandleFallback(originalRequest); return; }
                reply = ApplyEdit((segment, video) => Rebase(segment, video, segment.Start, Math.Max(0.25, Math.Min(newDuration, video.Duration - segment.Start)))
                    ? $"{EditingAIName} trimmed the edit to {FormatSeconds(segment.Duration)}." : null);
                Say(false, reply ?? "I couldn't trim the edit.");
                break;
            case "START":
                if (Value(0) is not { } newStart) { HandleFallback(originalRequest); return; }
                reply = ApplyEdit((segment, video) =>
                {
                    var finalStart = Math.Max(0, Math.Min(newStart, video.Duration - 0.25));
                    return Rebase(segment, video, finalStart, Math.Min(segment.Duration, video.Duration - finalStart))
                        ? $"{EditingAIName} moved the edit to {FormatSeconds(segment.Start)}." : null;
                });
                Say(false, reply ?? "I couldn't move the edit.");
                break;
            case "SHORT": _ = MakeShort(requestedDuration: Value(0)); break;
            case "SUBTITLES":
                Say(false, "I’m transcribing the selected Short using your Auto Shorts settings and adding timed subtitles.");
                _ = RegenerateSelectedSubtitles();
                break;
            case "MUTE":
                reply = ApplyEdit((segment, _) => { segment.IsMuted = true; return EditingAIName + " muted the audio."; });
                Say(false, reply ?? "I couldn't mute the edit.");
                break;
            case "UNMUTE":
                reply = ApplyEdit((segment, _) => { segment.IsMuted = false; return EditingAIName + " restored the source audio."; });
                Say(false, reply ?? "I couldn't restore the audio.");
                break;
            case "REMOVE_OVERLAY":
                reply = ApplyEdit((segment, _) => { segment.Caption = ""; segment.CaptionStart = 0; segment.CaptionDuration = null; return EditingAIName + " removed the text overlay. Speech subtitles are unchanged."; });
                Say(false, reply ?? "I couldn't remove the text overlay.");
                break;
            case "REMOVE_SUBTITLES":
                reply = ApplyEdit((segment, _) => { segment.Captions = []; return EditingAIName + " removed the speech subtitles. The text overlay is unchanged."; });
                Say(false, reply ?? "I couldn't remove the speech subtitles.");
                break;
            case "REMOVE_TEXT":
                reply = ApplyEdit((segment, _) => { segment.Caption = ""; segment.Captions = []; segment.CaptionStart = 0; segment.CaptionDuration = null; return EditingAIName + " removed the text overlay and speech subtitles."; });
                Say(false, reply ?? "I couldn't remove the text.");
                break;
            case "EXPORT": Say(false, EditingAIName + " is exporting every Short to Downloads."); _ = ExportAll(); break;
            case "UNDO": Say(false, UndoEdit()); break;
            case "CHAT": Say(false, string.Join("|", command.Arguments)); Message = EditingAIName + " answered."; break;
            default: HandleFallback(originalRequest); break;
        }
    }

    static double? Number(string text, params string[] after)
    {
        foreach (var marker in after)
        {
            var index = text.IndexOf(marker, StringComparison.OrdinalIgnoreCase);
            if (index < 0) continue;
            var match = Regex.Match(text[(index + marker.Length)..], @"\d+(?:\.\d+)?", RegexOptions.CultureInvariant);
            if (match.Success && double.TryParse(match.Value, NumberStyles.Float, CultureInfo.InvariantCulture, out var value) && double.IsFinite(value)) return value;
        }
        var timed = Regex.Match(text, @"\d+(?:\.\d+)?\s*(?:seconds?|secs?|s)\b", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);
        return timed.Success && double.TryParse(Regex.Replace(timed.Value, "[^0-9.]", ""), NumberStyles.Float, CultureInfo.InvariantCulture, out var seconds)
            && double.IsFinite(seconds) ? seconds : null;
    }

    static (string Caption, double Start, double? Duration)? OverlayInstruction(string text)
    {
        // Every index is obtained from the original text; Unicode case conversion can change its length.
        var marker = new[] { "text overlay", "add text", "put text", "show text", "write text" }
            .Select(m => (Marker: m, Index: text.IndexOf(m, StringComparison.OrdinalIgnoreCase))).FirstOrDefault(m => m.Index >= 0);
        if (marker.Marker is null) return null;
        var tail = text[(marker.Index + marker.Marker.Length)..];
        var cut = tail.Length;
        var timingTail = "";
        foreach (var timing in new[] { " in the first ", " in first ", " for the first ", " for first ", " during the first ", " during first ", " from ", " at " })
        {
            var index = tail.IndexOf(timing, StringComparison.OrdinalIgnoreCase);
            if (index >= 0 && index < cut) { cut = index; timingTail = tail[index..]; }
        }
        var caption = tail[..cut].Trim();
        foreach (var prefix in new[] { "saying ", "that says ", "with ", ": " })
            if (caption.StartsWith(prefix, StringComparison.OrdinalIgnoreCase)) caption = caption[prefix.Length..].Trim();
        caption = caption.Trim(' ', '"', '“', '”', '\'');
        if (caption.Length == 0) return null;
        var value = Number(timingTail, "first", "from", "at");
        return timingTail.Contains(" at ", StringComparison.OrdinalIgnoreCase) || timingTail.StartsWith("at ", StringComparison.OrdinalIgnoreCase)
            ? (caption, value ?? 0, null) : (caption, 0, value);
    }

    public void HandleFallback(string text)
    {
        bool Has(string value) => text.Contains(value, StringComparison.OrdinalIgnoreCase);
        bool Any(params string[] values) => values.Any(Has);
        string? reply;
        if (text.Equals("undo", StringComparison.OrdinalIgnoreCase) || Has("undo last")) Say(false, UndoEdit());
        else if (OverlayInstruction(text) is { } overlay)
        {
            reply = ApplyEdit((segment, _) =>
            {
                segment.Caption = overlay.Caption;
                segment.CaptionStart = Math.Clamp(overlay.Start, 0, segment.Duration);
                segment.CaptionDuration = Math.Clamp(overlay.Duration ?? segment.Duration - segment.CaptionStart.Value, 0, segment.Duration - segment.CaptionStart.Value);
                return $"Done — I added “{overlay.Caption}” from {FormatSeconds(segment.CaptionStart.Value)} to {FormatSeconds(segment.CaptionStart.Value + segment.CaptionDuration.Value)}.";
            });
            Say(false, reply ?? "I couldn't add that text overlay.");
        }
        else if (Any("remove subtitles", "delete subtitles", "remove speech captions", "hide subtitles", "don't show subtitles", "do not show subtitles"))
        {
            reply = ApplyEdit((segment, _) => { segment.Captions = []; return "Done — I removed the speech subtitles. The text overlay is unchanged."; });
            Say(false, reply ?? "I couldn't remove the speech subtitles.");
        }
        else if (Any("remove title", "delete title", "remove overlay", "delete overlay", "hide title", "hide overlay"))
        {
            reply = ApplyEdit((segment, _) => { segment.Caption = ""; segment.CaptionStart = 0; segment.CaptionDuration = null; return "Done — I removed the text overlay. Speech subtitles are unchanged."; });
            Say(false, reply ?? "I couldn't remove the text overlay.");
        }
        else if (Any("remove caption", "delete caption", "no caption", "remove text"))
        {
            reply = ApplyEdit((segment, _) => { segment.Caption = ""; segment.Captions = []; segment.CaptionStart = 0; segment.CaptionDuration = null; return "Done — I removed the text overlay and speech subtitles."; });
            Say(false, reply ?? "I couldn't change the captions.");
        }
        else if (Any("caption to ", "text to "))
        {
            var marker = Has("caption to ") ? "caption to " : "text to ";
            var caption = text[(text.IndexOf(marker, StringComparison.OrdinalIgnoreCase) + marker.Length)..].Trim(' ', '"', '“', '”', '\'');
            reply = caption.Length == 0 ? null : ApplyEdit((segment, _) =>
            { segment.Caption = caption; segment.CaptionStart = 0; segment.CaptionDuration = segment.Duration; return $"Done — I changed the on-screen caption to “{caption}”."; });
            Say(false, reply ?? "Tell me the caption text after “caption to”.");
        }
        else if (Any("unmute", "restore audio"))
        {
            reply = ApplyEdit((segment, _) => { segment.IsMuted = false; return "Done — I restored the source audio."; });
            Say(false, reply ?? "I couldn't restore the audio.");
        }
        else if (Any("mute", "remove audio", "no audio"))
        {
            reply = ApplyEdit((segment, _) => { segment.IsMuted = true; return "Done — I muted the audio. The next export will be silent."; });
            Say(false, reply ?? "I couldn't mute this edit.");
        }
        else if (Any("start at", "begin at"))
        {
            var value = Number(text, "start at", "begin at");
            reply = value is not { } newStart ? null : ApplyEdit((segment, video) =>
            {
                var start = Math.Max(0, Math.Min(newStart, Math.Max(0, video.Duration - 0.25)));
                return Rebase(segment, video, start, Math.Min(segment.Duration, video.Duration - start)) ? $"Done — the edit now starts at {FormatSeconds(segment.Start)}." : null;
            });
            Say(false, reply ?? "Tell me a start time, for example “start at 12 seconds”.");
        }
        else if (Any("make it", "trim to", "duration"))
        {
            var value = Number(text, "make it", "trim to", "duration");
            reply = value is not { } duration ? null : ApplyEdit((segment, video) =>
                Rebase(segment, video, segment.Start, Math.Max(0.25, Math.Min(duration, video.Duration - segment.Start))) ? $"Done — I trimmed the edit to {FormatSeconds(segment.Duration)}." : null);
            Say(false, reply ?? "Tell me a duration, for example “make it 20 seconds”.");
        }
        else if (Any("short", "analy", "best moment"))
        {
            Say(false, "Prism AI is analyzing the video for a complete moment.");
            _ = MakeShort(requestedDuration: Number(text, "short", "make", "create"));
        }
        else if (Has("export"))
        {
            var hasSegments = project?.Segments.Count is > 0;
            Say(false, hasSegments ? "I’m exporting every Short as an MP4 to Downloads › Prism." : "Create a Short first, then I can prepare it for export.");
            if (hasSegments) _ = ExportAll();
        }
        else if (Has("caption"))
        {
            var segment = project?.Segments.FirstOrDefault();
            Say(false, segment is null ? "Create a Short and I’ll add detected speech to the Captions track."
                : segment.Captions?.Count is > 0 ? "This Short already has generated speech subtitles on the Text track."
                : "This Short has no generated speech subtitles yet. Select it and choose Transcribe in the Clip inspector.");
        }
        else Say(false, "I can create or trim a Short, move its start time, change or remove captions, mute audio, undo an edit, and export. Try “make it 12 seconds”.");
    }
}
