namespace Prism.Core;

/// Adapted from OpenShorts clip_selection.py (MIT). See THIRD-PARTY-NOTICES.md.
public static class TranscriptSelection
{
    public sealed record Window(double Start, double End, string Text);

    /// <summary>Overlapping windows aligned to caption segments; every segment is visited, including the tail.</summary>
    public static List<Window> Windows(IReadOnlyList<TimedCaption> cues, (double Start, double End) interval, double seconds = 90, double overlap = 30)
    {
        var segments = cues.Where(c => double.IsFinite(c.Start) && double.IsFinite(c.Duration) && c.Duration > 0 &&
                                       c.Start >= interval.Start && c.Start + c.Duration <= interval.End && c.Text.Trim().Length > 0)
                           .OrderBy(c => c.Start).ToList();
        var result = new List<Window>();
        var i = 0;
        var size = Math.Max(1, seconds);
        while (i < segments.Count)
        {
            var start = segments[i].Start;
            var j = i;
            while (j + 1 < segments.Count && segments[j + 1].Start + segments[j + 1].Duration - start <= size * 1.25)
            {
                j += 1;
                if (segments[j].Start + segments[j].Duration - start >= size) break;
            }
            var end = segments[j].Start + segments[j].Duration;
            result.Add(new Window(start, end, string.Join(" ", segments.Skip(i).Take(j - i + 1).Select(s => s.Text))));
            if (j == segments.Count - 1) break;
            var target = end - Math.Max(0, overlap);
            var k = i + 1;
            while (k <= j && segments[k].Start < target) k += 1;
            i = Math.Max(k, i + 1);
        }
        return result;
    }

    /// <summary>Near-equal batches avoid judging a trailing singleton on its own.</summary>
    public static List<List<T>> Batches<T>(IReadOnlyList<T> values, int size = 4)
    {
        if (values.Count == 0) return [];
        var count = (values.Count + Math.Max(1, size) - 1) / Math.Max(1, size);
        int baseSize = values.Count / count, extra = values.Count % count;
        var result = new List<List<T>>();
        var start = 0;
        for (var index = 0; index < count; index++)
        {
            var end = start + baseSize + (index < extra ? 1 : 0);
            result.Add(values.Skip(start).Take(end - start).ToList());
            start = end;
        }
        return result;
    }

    static List<string> Tokens(string text) =>
        System.Text.RegularExpressions.Regex.Split(text.ToLowerInvariant(), @"[^\p{L}\p{N}]+").Where(t => t.Length > 0).ToList();

    /// <summary>A second transcription must retain the source's opening, payoff and most words. Coarse sentence anchors
    /// also catch plausible text with a drifting timestamp clock.</summary>
    public static bool AlignmentIsReliable(IReadOnlyList<TimedSpeechWord> words, IReadOnlyList<TimedCaption> reference)
    {
        var expected = reference.SelectMany(r => Tokens(r.Text)).ToList();
        var actual = words.SelectMany(w => Tokens(w.Text)).ToList();
        // The edges may differ by a word or two (a dropped "so", an added "uh"); the overlap check below still
        // demands 95% of the words, so a lost payoff is still caught.
        if (expected.Count == 0 || actual.Count == 0
            || !words.All(w => double.IsFinite(w.Start) && double.IsFinite(w.Duration) && w.Duration > 0)
            || words.Zip(words.Skip(1)).Any(pair => pair.First.Start > pair.Second.Start)
            || !(expected.Take(3).Contains(actual[0]) || actual.Take(3).Contains(expected[0]))
            || !(expected.TakeLast(3).Contains(actual[^1]) || actual.TakeLast(3).Contains(expected[^1]))
            || actual.Count > expected.Count * 3 / 2 + 3) return false;
        var previous = new int[actual.Count + 1];
        foreach (var token in expected)
        {
            var current = new int[actual.Count + 1];
            for (var index = 0; index < actual.Count; index++)
                current[index + 1] = token == actual[index] ? previous[index] + 1 : Math.Max(previous[index + 1], current[index]);
            previous = current;
        }
        if ((double)previous[^1] / expected.Count < 0.95) return false;
        foreach (var cue in reference)
        {
            var cueTokens = Tokens(cue.Text);
            if (cueTokens.Count == 0) continue;
            // Each nearby word matches one cue word at most, so a repeated word can't cover a line on its own.
            var remaining = words.Where(w => w.Start + w.Duration > cue.Start - 0.7 && w.Start < cue.Start + cue.Duration + 0.7)
                                 .SelectMany(w => Tokens(w.Text)).GroupBy(t => t).ToDictionary(g => g.Key, g => g.Count());
            var matched = 0;
            foreach (var token in cueTokens)
                if (remaining.GetValueOrDefault(token) > 0) { remaining[token]--; matched++; }
            var coverage = (double)matched / cueTokens.Count;
            if (coverage < 0.65) return false;
        }
        return true;
    }

    /// <summary>Sentence timing is an explicit fallback, not invented word-level precision.</summary>
    public static List<TimedCaption> SentenceCaptionGroups(IEnumerable<TimedCaption> cues) =>
        cues.SelectMany(cue =>
        {
            var words = cue.Text.Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries);
            if (words.Length == 0) return Enumerable.Empty<TimedCaption>();
            return Enumerable.Range(0, (words.Length + 5) / 6).Select(group =>
            {
                var index = group * 6;
                var end = Math.Min(words.Length, index + 6);
                return new TimedCaption(string.Join(" ", words[index..end]),
                    cue.Start + cue.Duration * index / words.Length,
                    cue.Duration * (end - index) / words.Length);
            });
        }).ToList();

    public static (double Start, double Duration) PaddedPhraseRange(double start, double duration, IReadOnlyList<TimedCaption> cues, (double Start, double End) interval)
    {
        var end = start + duration;
        var previous = cues.Select(c => c.Start + c.Duration).Where(t => t <= start + 0.001).DefaultIfEmpty(double.NaN).Max();
        var next = cues.Select(c => c.Start).Where(t => t >= end - 0.001).DefaultIfEmpty(double.NaN).Min();
        var lead = double.IsNaN(previous) ? 0.35 : Math.Min(0.35, Math.Max(0, (start - previous) / 2));
        var tail = double.IsNaN(next) ? 0.45 : Math.Min(0.45, Math.Max(0, (next - end) / 2));
        var beginning = Math.Max(interval.Start, start - lead);
        return (beginning, Math.Min(interval.End, end + tail) - beginning);
    }

    public static bool Overlaps(double start, double duration, double otherStart, double otherDuration)
    {
        var intersection = Math.Min(start + duration, otherStart + otherDuration) - Math.Max(start, otherStart);
        return intersection > 0 && intersection / Math.Max(0.000001, Math.Min(duration, otherDuration)) >= 0.25;
    }

    /// <summary>Moves a range's edges out of the middle of a sentence; <paramref name="cues"/> must be whole sentences. The end prefers
    /// finishing its sentence, else stops after the previous one; the start prefers its sentence's beginning, else the next sentence,
    /// else its sentence's beginning even when far. An edge stays put only when every fix would break the length limits.</summary>
    public static (double Start, double Duration) CompleteSentences(double start, double duration, IReadOnlyList<TimedCaption> cues,
                                                                    (double Start, double End) interval, double minDuration, double maxDuration)
    {
        var sentences = cues.Where(c => double.IsFinite(c.Start) && double.IsFinite(c.Duration) && c.Duration > 0 &&
                                        c.Start >= interval.Start - 0.001 && c.Start + c.Duration <= interval.End + 0.001)
                            .OrderBy(c => c.Start).ToList();
        TimedCaption? SentenceContaining(double time) => sentences.FirstOrDefault(s => s.Start + 0.3 < time && s.Start + s.Duration - 0.3 > time);
        var begin = start;
        var end = start + duration;
        if (SentenceContaining(begin) is { } cutStart)
        {
            if (begin - cutStart.Start <= 4 && end - cutStart.Start <= maxDuration) begin = cutStart.Start;
            else if (sentences.FirstOrDefault(s => s.Start >= cutStart.Start + cutStart.Duration - 0.05) is { } next && end - next.Start >= minDuration) begin = next.Start;
            else if (end - cutStart.Start <= maxDuration) begin = cutStart.Start;
        }
        if (SentenceContaining(end) is { } cutEnd)
        {
            var finish = cutEnd.Start + cutEnd.Duration;
            if (finish - end <= 8 && finish - begin <= maxDuration) end = finish;
            else if (sentences.LastOrDefault(s => s.Start + s.Duration <= cutEnd.Start + 0.05) is { } previous
                     && previous.Start + previous.Duration - begin >= minDuration) end = previous.Start + previous.Duration;
            else if (finish - begin <= maxDuration) end = finish;
        }
        return (begin, Math.Max(0.01, end - begin));
    }

    /// <summary>Drops filler-only cues ("Okay, so.", "Thanks for watching.") from a range's edges while it keeps
    /// <paramref name="minDuration"/>, so a Short opens on its hook and ends on its payoff.</summary>
    // shortcut: English filler words only; add per-language lists if non-English sources matter.
    public static (double Start, double Duration) TrimmedFiller(double start, double duration, IReadOnlyList<TimedCaption> cues, double minDuration)
    {
        // Short replies such as "Yes", "Right", or "Thank you" can be the payoff.
        // Trim only unambiguous hesitation at the start and explicit sign-offs at the end.
        HashSet<string> openingFiller = ["um", "uh", "erm", "hmm", "so", "okay so", "ok so"];
        HashSet<string> closingFiller = ["thanks for watching", "thank you for watching"];
        string Normalized(TimedCaption cue) => string.Join(" ", Tokens(cue.Text));
        var inside = cues.Where(c => c.Start >= start - 0.05 && c.Start + c.Duration <= start + duration + 0.05).OrderBy(c => c.Start).ToList();
        var begin = start;
        var end = start + duration;
        while (inside.Count > 1 && openingFiller.Contains(Normalized(inside[0])) && end - inside[1].Start >= minDuration)
        {
            inside.RemoveAt(0);
            begin = inside[0].Start;
        }
        while (inside.Count > 1 && closingFiller.Contains(Normalized(inside[^1])) && inside[^2].Start + inside[^2].Duration - begin >= minDuration)
        {
            inside.RemoveAt(inside.Count - 1);
            end = inside[^1].Start + inside[^1].Duration;
        }
        return (begin, end - begin);
    }

    /// <summary>Prefers nearby phrase endings, especially punctuation or a pause. Requested lengths remain approximate.</summary>
    public static (double Start, double Duration) PhraseRange(double start, double duration, IReadOnlyList<TimedCaption> cues, (double Start, double End) interval)
    {
        var valid = cues.Where(c => c.Start >= interval.Start && c.Start + c.Duration <= interval.End).OrderBy(c => c.Start).ToList();
        var nearStart = valid.Where(c => Math.Abs(c.Start - start) <= 2).OrderBy(c => Math.Abs(c.Start - start)).FirstOrDefault();
        var beginning = nearStart?.Start ?? start;
        var target = Math.Min(interval.End, beginning + duration);
        var tolerance = Math.Min(5, duration * 0.2);
        double Quality(int index, TimedCaption cue)
        {
            var punctuation = cue.Text.Length > 0 && ".!?…".Contains(cue.Text[^1]);
            var pause = index + 1 < valid.Count && valid[index + 1].Start - (cue.Start + cue.Duration) >= 0.4;
            return Math.Abs(cue.Start + cue.Duration - target) - (punctuation || pause ? tolerance : 0);
        }
        var endings = valid.Select((cue, index) => (cue, index))
            .Where(e => Math.Abs(e.cue.Start + e.cue.Duration - target) <= tolerance && e.cue.Start + e.cue.Duration > beginning).ToList();
        var ending = endings.Count == 0 ? target : endings.MinBy(e => Quality(e.index, e.cue)).cue is var best ? best.Start + best.Duration : target;
        return (beginning, Math.Max(0.01, ending - beginning));
    }
}
