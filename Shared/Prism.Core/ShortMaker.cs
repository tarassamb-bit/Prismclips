namespace Prism.Core;

/// Turns a long video into Shorts: transcript, selection, exact boundaries and framing, as in the macOS app.
public static class ShortMaker
{
    public static async Task<List<ShortResult>> Analyze(
        string path, double requestedDuration, int count, SourceRegion sourceRegion, GeminiConfiguration gemini,
        double? customStart = null, double? customEnd = null, IReadOnlyList<SourceInterval>? excluding = null,
        VideoType videoType = VideoType.General, SentenceTranscript? cachedTranscript = null,
        Action<SentenceTranscript>? onTranscript = null, Action<double, string>? progress = null, CancellationToken cancellation = default)
    {
        excluding ??= [];
        progress ??= (_, _) => { };
        onTranscript ??= _ => { };
        var info = await FFmpeg.Probe(path, cancellation);
        if (info is not { HasVideo: true } || !double.IsFinite(info.Duration) || info.Duration <= 0) throw new ShortMakerException(ShortMakerFailure.NoVideo);
        var interval = sourceRegion.Interval(info.Duration, customStart, customEnd);
        if (excluding.Any(e => e.Start <= interval.Start && e.End >= interval.End)) throw new GeminiException(GeminiFailure.NoDistinctClips);
        var clipDuration = Math.Min(Math.Max(1, requestedDuration), interval.End - interval.Start);
        var targetCount = Math.Clamp(count, 1, 20);
        progress(0, "Preparing audio for Prism AI");
        List<TimedCaption> transcript;
        if (!info.HasAudio) transcript = [];
        else if (cachedTranscript?.CuesCovering(interval.Start, interval.End) is { } saved)
        {
            // Saved by an earlier run on this video: no audio upload and no transcription cost.
            progress(0.55, "Using the saved transcript");
            transcript = saved;
        }
        else
        {
            // An earlier run that failed partway saved the stretch it finished; only the rest is transcribed again.
            SentenceTranscript? resumed = null;
            if (cachedTranscript is { } partial && partial.Start <= interval.Start + 0.01 && partial.End > interval.Start + 1 && partial.End < interval.End
                && partial.CuesCovering(interval.Start, partial.End) is { } kept)
                resumed = new SentenceTranscript(interval.Start, partial.End, kept);
            var from = resumed?.End ?? interval.Start;
            var keptCues = resumed?.Cues ?? [];
            var fresh = await GeminiSelection.TranscribeSentences(path, (from, interval.End), gemini, fraction =>
            {
                var overall = (from - interval.Start + fraction * (interval.End - from)) / (interval.End - interval.Start);
                progress(0.55 * overall, $"Prism AI · transcribing audio · {(int)(overall * 100)}%");
            }, finished: (cues, end) => onTranscript(new SentenceTranscript(interval.Start, end, [.. keptCues, .. cues])), cancellation: cancellation);
            transcript = [.. keptCues, .. fresh];
            onTranscript(new SentenceTranscript(interval.Start, interval.End, transcript));
        }
        progress(0.55, "Selecting distinct moments");
        if (videoType == VideoType.Auto)
        {
            progress(0.55, "Prism AI · recognizing the kind of video");
            // Detection reads the transcript; a silent source keeps the general behavior.
            videoType = transcript.Count == 0 ? VideoType.General : await GeminiSelection.DetectVideoType(transcript, gemini, cancellation);
            progress(0.55, $"Prism AI · {videoType.Title()}");
        }
        progress(0.55, "Prism AI · choosing complete stories and layouts");
        var clips = await GeminiSelection.Select(path, transcript, interval, clipDuration, targetCount, gemini, excluding, videoType.SelectionGuidance(),
            (fraction, stage) => progress(0.55 + 0.15 * fraction, stage), cancellation: cancellation);
        // Screens and gameplay lose their edges in a vertical crop, whatever the picker suggested.
        var picks = clips.Select(c => (c.Start, Duration: c.End - c.Start, Fit: c.Layout == "fit" || videoType.ForcesFit(), c.Title, c.Reason, c.Score)).ToList();
        var steps = 0;
        void ReportStep(string stage)
        {
            var done = Interlocked.Increment(ref steps);
            progress(0.70 + 0.29 * Math.Min(1, (double)done / (targetCount * 2)), stage);
        }
        // Picks are prepared a wave at a time, side by side: exact boundaries, word timing and the nearest pauses. They are accepted
        // in Gemini's order; a pick that now overlaps an earlier one gives way to the next backup.
        var accepted = new List<(int Candidate, PreparedShort Shot)>();
        var wordAlignmentAvailable = true;
        var next = 0;
        while (accepted.Count < targetCount && next < picks.Count)
        {
            cancellation.ThrowIfCancellationRequested();
            var wave = Enumerable.Range(next, Math.Min(picks.Count - next, targetCount - accepted.Count)).ToList();
            next += wave.Count;
            var aligning = wordAlignmentAvailable;
            var prepared = await Concurrency.Map(wave, async (index, token) =>
            {
                var candidate = picks[index];
                var shot = await PrepareShort(path, candidate.Start, candidate.Duration, transcript, interval, clipDuration, aligning, gemini, token);
                ReportStep($"Aligning speech and pauses · Short {index + 1}");
                return (index, shot);
            }, cancellation);
            foreach (var (index, shot) in prepared)
            {
                if (shot.AlignmentFailed) wordAlignmentAvailable = false;
                if (!excluding.All(e => !TranscriptSelection.Overlaps(shot.Start, shot.Duration, e.Start, e.End - e.Start))
                    || !accepted.All(a => !TranscriptSelection.Overlaps(shot.Start, shot.Duration, a.Shot.Start, a.Shot.Duration))) continue;
                accepted.Add((index, shot));
                if (accepted.Count == targetCount) break;
            }
        }
        var results = await Concurrency.Map(accepted, async (pair, token) =>
        {
            var (candidateIndex, shot) = pair;
            var candidate = picks[candidateIndex];
            double start = shot.Start, duration = shot.Duration;
            var source = shot.Words.Count > 0 ? GeminiSelection.CaptionCues(shot.Words, (start, start + duration)) : TranscriptSelection.SentenceCaptionGroups(shot.ReferenceCues);
            var captions = source.Where(c => c.Start + c.Duration > start && c.Start < start + duration).Select(c =>
            {
                var clippedStart = Math.Max(0, c.Start - start);
                var clippedEnd = Math.Min(duration, c.Start + c.Duration - start);
                return new TimedCaption(c.Text, clippedStart, Math.Max(0.15, clippedEnd - clippedStart));
            }).ToList();
            var words = shot.Words.Where(w => w.Start >= start - 0.01 && w.Start + w.Duration <= start + duration + 0.01)
                                  .Select(w => w with { Start = w.Start - start }).ToList();
            var keyframes = candidate.Fit
                ? [new CropKeyframe(0, 0.5, null, true), new CropKeyframe(duration, 0.5, null, true)]
                : await SubjectFramer.Analyze(path, start, duration, 1.08, gemini, captions, cancellation: token);
            ReportStep("Prism AI · framing the subject");
            var warning = shot.ReferenceCues.Count == 0 || shot.Words.Count > 0 ? null : GeminiSelection.SentenceTimingNotice;
            var title = candidate.Title is { } t ? Truncate(t, 100) : captions.FirstOrDefault() is { } first ? Truncate(first.Text, 100) : null;
            return new ShortResult(start, duration, "", captions, keyframes, words, warning, title,
                                   candidate.Reason is { } reason ? Truncate(reason, 400) : null, candidate.Fit, videoType, (int)Math.Round(candidate.Score * 10));
        }, cancellation);
        // Returning the beginning of the source here made a failed analysis look like a successful Short. Keep existing
        // edits intact and ask for another range instead of silently inventing a selection.
        if (results.Count == 0) throw new GeminiException(excluding.Count > 0 ? GeminiFailure.NoDistinctClips : GeminiFailure.NoStrongClips);
        cancellation.ThrowIfCancellationRequested();
        progress(1, "Shorts ready");
        return results.OrderBy(r => r.Start).ToList();
    }

    static string Truncate(string text, int length) => text.Length > length ? text[..length] : text;

    /// <summary>A pick's final source range with the word timing and sentence captions found for it.</summary>
    public sealed record PreparedShort(double Start, double Duration, List<TimedSpeechWord> Words, List<TimedCaption> ReferenceCues, bool AlignmentFailed);

    /// <summary>Turns Gemini's rough clip into exact boundaries: whole sentences, no filler at the edges, a little breathing room,
    /// no cut word, a strong first word, and both ends moved into the nearest pause in the audio.</summary>
    public static async Task<PreparedShort> PrepareShort(string path, double start, double duration, IReadOnlyList<TimedCaption> transcript,
                                                         (double Start, double End) interval, double clipDuration, bool aligning,
                                                         GeminiConfiguration gemini, CancellationToken cancellation = default)
    {
        var phraseCut = TranscriptSelection.PhraseRange(start, duration, transcript, interval);
        // Cloud cues are whole sentences, so a Short never starts or stops in the middle of one.
        var sentences = TranscriptSelection.CompleteSentences(phraseCut.Start, phraseCut.Duration, transcript, interval,
                                                              Math.Max(1, clipDuration * 0.65), Math.Min(90, clipDuration * 1.5));
        var snapped = TranscriptSelection.TrimmedFiller(sentences.Start, sentences.Duration, transcript, Math.Max(1, clipDuration * 0.65));
        var phrase = TranscriptSelection.PaddedPhraseRange(snapped.Start, snapped.Duration, transcript, interval);
        var referenceCues = transcript.Where(c =>
        {
            var middle = c.Start + c.Duration / 2;
            return middle >= snapped.Start && middle <= snapped.Start + snapped.Duration;
        }).ToList();
        var clipWords = new List<TimedSpeechWord>();
        var alignmentFailed = false;
        if (referenceCues.Count > 0 && aligning)
        {
            try
            {
                var proposed = await GeminiSelection.Transcribe(path, (Math.Max(interval.Start, phrase.Start - 0.5), Math.Min(interval.End, phrase.Start + phrase.Duration + 0.5)),
                                                                gemini, reference: referenceCues, cancellation: cancellation);
                var inside = proposed.Where(w => w.Start >= phrase.Start - 0.01 && w.Start + w.Duration <= phrase.Start + phrase.Duration + 0.01).ToList();
                if (TranscriptSelection.AlignmentIsReliable(inside, referenceCues)) clipWords = inside;
            }
            catch (Exception)
            {
                cancellation.ThrowIfCancellationRequested();
                alignmentFailed = true;
            }
        }
        var whole = SpeechSafeRange(phrase.Start, phrase.Duration, clipWords, interval);
        var safe = StrongOpening(whole.Start, whole.Duration, clipWords, Math.Max(1, clipDuration * 0.65));
        var quiet = await SilenceSnapped(path, safe.Start, safe.Duration, interval, clipWords, cancellation);
        return new PreparedShort(quiet.Start, quiet.Duration, clipWords, referenceCues, alignmentFailed);
    }

    /// <summary>Moves a Short's start and end into the nearest pause in its audio, so it never opens or closes on a clipped sound.
    /// The start may move up to 0.5 s earlier or 0.15 s later, the end 0.15 s earlier or 0.5 s later, never past the interval
    /// or into a timed word. Without audio or a clear pause nearby, the range stays as it is.</summary>
    public static async Task<(double Start, double Duration)> SilenceSnapped(string path, double start, double duration, (double Start, double End) interval,
                                                                             IReadOnlyList<TimedSpeechWord>? words = null, CancellationToken cancellation = default)
    {
        words ??= [];
        var end = start + duration;
        double from = Math.Max(interval.Start, start - 0.6), to = Math.Min(interval.End, end + 0.6);
        if (to <= from || await FFmpeg.AudioLevels(path, from, to, cancellation) is not { Length: > 20 } levels) return (start, duration);
        const double frame = 0.01;
        // 50 ms smoothing ignores the tiny gaps inside a word.
        var smooth = levels.Select((_, index) =>
        {
            int low = Math.Max(0, index - 2), high = Math.Min(levels.Length - 1, index + 2);
            float sum = 0;
            for (var i = low; i <= high; i++) sum += levels[i];
            return sum / (high - low + 1);
        }).ToArray();
        var median = smooth.OrderBy(v => v).ElementAt(smooth.Length / 2);
        var threshold = Math.Max(0.003f, median * 0.2f);
        double Time(int index) => from + (index + 0.5) * frame;
        bool InsideWord(double t) => words.Any(w => w.Start + 0.02 < t && w.Start + w.Duration - 0.02 > t);
        double? NearestQuiet(double target, double low, double high)
        {
            var quiet = Enumerable.Range(0, smooth.Length)
                .Where(i => Time(i) >= low && Time(i) <= high && smooth[i] <= threshold && !InsideWord(Time(i))).ToList();
            return quiet.Count == 0 ? null : Time(quiet.MinBy(i => Math.Abs(Time(i) - target)));
        }
        var newStart = NearestQuiet(start, Math.Max(interval.Start, start - 0.5), start + 0.15) ?? start;
        var newEnd = NearestQuiet(end, end - 0.15, Math.Min(interval.End, end + 0.5)) ?? end;
        return newEnd - newStart > 0.5 ? (newStart, newEnd - newStart) : (start, duration);
    }

    /// <summary>Drops up to three throat-clearing words ("So", "Um", "And", "Okay") from a Short's first line, so it opens on its hook.
    /// Needs real word timing; the cut lands 0.08 s before the next word and the Short keeps <paramref name="minDuration"/>.</summary>
    // shortcut: English filler words only; add per-language lists if non-English sources matter.
    public static (double Start, double Duration) StrongOpening(double start, double duration, IReadOnlyList<TimedSpeechWord> words, double minDuration)
    {
        // Only words that are filler at the start of a line; "like", "now", "then" and "right" often carry meaning there.
        HashSet<string> weak = ["so", "and", "but", "um", "uh", "erm", "okay", "ok", "well", "anyway", "alright", "yeah"];
        var end = start + duration;
        var spoken = words.Where(w => w.Start >= start - 0.05 && w.Start < end).OrderBy(w => w.Start).ToList();
        static string Bare(TimedSpeechWord word) => new(word.Text.ToLowerInvariant().Where(char.IsLetter).ToArray());
        var dropped = 0;
        while (dropped < Math.Min(3, spoken.Count - 1) && weak.Contains(Bare(spoken[dropped]))) dropped += 1;
        if (dropped == 0) return (start, duration);
        var newStart = Math.Max(start, spoken[dropped].Start - 0.08);
        return end - newStart >= minDuration ? (newStart, end - newStart) : (start, duration);
    }

    public static (double Start, double Duration) SpeechSafeRange(double start, double duration, IReadOnlyList<TimedSpeechWord> words, (double Start, double End) interval)
    {
        if (words.Count == 0) return (start, duration);
        var safeStart = start;
        if (words.FirstOrDefault(w => w.Start + 0.02 < safeStart && w.Start + w.Duration - 0.02 > safeStart) is { } cutStart)
            safeStart = cutStart.Start >= interval.Start ? Math.Max(interval.Start, cutStart.Start - 0.025) : Math.Min(interval.End, cutStart.Start + cutStart.Duration + 0.025);
        var safeEnd = Math.Min(interval.End, start + duration);
        if (words.FirstOrDefault(w => w.Start + 0.02 < safeEnd && w.Start + w.Duration - 0.02 > safeEnd) is { } cutEnd)
        {
            var wordEnd = cutEnd.Start + cutEnd.Duration;
            safeEnd = wordEnd <= interval.End ? Math.Min(interval.End, wordEnd + 0.04) : Math.Max(safeStart + 0.1, cutEnd.Start);
        }
        return safeEnd > safeStart ? (safeStart, safeEnd - safeStart) : (start, duration);
    }

    /// <summary>Face centers from sampled frames → the two speakers' horizontal centers, left first; null unless two clear groups exist.</summary>
    public static List<double>? SplitCenters(IEnumerable<double> faceXs)
    {
        var sorted = faceXs.Where(x => double.IsFinite(x) && x is >= 0 and <= 1).OrderBy(x => x).ToList();
        if (sorted.Count < 2) return null;
        var widest = Enumerable.Range(0, sorted.Count - 1).MaxBy(i => sorted[i + 1] - sorted[i]);
        if (sorted[widest + 1] - sorted[widest] < 0.15) return null;
        return [sorted.Take(widest + 1).Average(), sorted.Skip(widest + 1).Average()];
    }

    /// <summary>Asks Gemini where the two people sit across a Short, left first; null unless two clear groups of faces exist.</summary>
    public static async Task<List<double>?> FindSplitCenters(string path, double start, double duration, GeminiConfiguration configuration,
                                                             CancellationToken cancellation = default)
    {
        var images = new List<byte[]>();
        for (var index = 0; index < 8; index++)
            if (await FFmpeg.FrameJpeg(path, start + duration * (index + 0.5) / 8, 512, cancellation) is { } jpeg) images.Add(jpeg);
        if (images.Count == 0 || await SubjectFramer.Locate(images, [], [], configuration, cancellation) is not { } located) return null;
        return SplitCenters(located.Frames.SelectMany(f => f.Faces));
    }
}
