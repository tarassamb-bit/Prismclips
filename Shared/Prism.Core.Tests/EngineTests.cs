using System.Text.Json;
using Prism.Core;

namespace Prism.Core.Tests;

public class SelectionTests
{
    [Theory]
    [InlineData(VideoType.Podcast, false, CaptionStyle.Podcast)]
    [InlineData(VideoType.General, true, CaptionStyle.Podcast)]
    [InlineData(VideoType.Gaming, false, CaptionStyle.BoldCaps)]
    [InlineData(VideoType.Tutorial, false, CaptionStyle.Minimal)]
    [InlineData(VideoType.General, false, CaptionStyle.Viral)]
    public void AutomaticCaptionsMatchTheMacVideoStyle(VideoType type, bool split, CaptionStyle expected)
    {
        Assert.Equal(expected, CaptionStyle.Auto.Resolved(type, split));
        Assert.Equal(CaptionStyle.Classic, CaptionStyle.Classic.Resolved(type, split));
        var original = new EditSegment { CaptionStyle = CaptionStyle.Auto, VideoType = type, Score = 84 };
        var restored = PrismJson.Clone(original);
        Assert.Equal((CaptionStyle.Auto, type, 84), (restored.CaptionStyle, restored.VideoType, restored.Score));
    }

    [Fact]
    public async Task CancelledToolRequestsNeverStartAProcess()
    {
        using var stop = new CancellationTokenSource();
        stop.Cancel();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => FFmpeg.Run("a-program-that-must-not-start", [], stop.Token));
    }

    [Fact]
    public async Task FailedOutputCallbacksStopTheirEncoderPromptly()
    {
        using var stop = new CancellationTokenSource();
        try
        {
            var operation = FFmpeg.Run(FFmpeg.FFmpegPath,
                ["-nostdin", "-hide_banner", "-loglevel", "error", "-re", "-f", "lavfi", "-i", "testsrc2=size=16x16:rate=2:duration=30",
                 "-progress", "pipe:1", "-f", "null", "-"], stop.Token, _ => throw new InvalidOperationException("Progress callback failed"));
            var error = await Assert.ThrowsAsync<InvalidOperationException>(() => operation.WaitAsync(TimeSpan.FromSeconds(5)));
            Assert.Equal("Progress callback failed", error.Message);
        }
        finally { stop.Cancel(); }
    }
    [Fact]
    public void CaptionsAreIntersectedWithTheClipInsteadOfShiftedLater()
    {
        var segment = new EditSegment
        {
            Duration = 4,
            Captions = [new("Already over", -3, 1), new("Clipped", -1, 2)],
        };
        var caption = Assert.Single(CaptionRenderer.Elements(segment));
        // The page stays up 0.35 s after its last word, as on the Mac.
        Assert.Equal((0d, 1.35d), (caption.Start, Math.Round(caption.Duration, 6)));
        segment.Captions = null;
        segment.Caption = "Overlay"; segment.CaptionStart = -1; segment.CaptionDuration = 2;
        Assert.Equal(1, Assert.Single(CaptionRenderer.Elements(segment)).Duration);
    }

    [Fact]
    public void EveryStyleShowsShortPagesLikeTheMac()
    {
        var cue = new TimedCaption("This is the viral caption", 0.5, 1.5);
        List<TimedSpeechWord> words = [new("This", 0.5, 0.2), new("is", 0.7, 0.2), new("the", 0.9, 0.2), new("viral", 1.1, 0.4), new("caption", 1.5, 0.5)];
        // Three-word pages for Viral, two words for Bold caps, one for One word, one short line for Simple and Minimal;
        // highlighting styles add a layer per word. The same with exact or estimated word timing.
        var counts = new Dictionary<CaptionStyle, int> { [CaptionStyle.Auto] = 5, [CaptionStyle.Viral] = 5, [CaptionStyle.HighlightBox] = 5, [CaptionStyle.Podcast] = 5,
                                                         [CaptionStyle.BoldCaps] = 3, [CaptionStyle.OneWord] = 5, [CaptionStyle.Classic] = 1, [CaptionStyle.Minimal] = 1 };
        foreach (var (style, expected) in counts)
        {
            Assert.Equal(expected, CaptionRenderer.Elements(new EditSegment { Duration = 3, Captions = [cue], SpeechWords = words, CaptionStyle = style }).Count);
            Assert.Equal(expected, CaptionRenderer.Elements(new EditSegment { Duration = 3, Captions = [cue], CaptionStyle = style }).Count);
        }
        var pages = CaptionRenderer.Pages([cue], words, CaptionStyle.Viral);
        Assert.Equal(["This is the", "viral caption"], pages.Select(p => p.Text));
        Assert.Equal(pages[0].End, pages[1].Start);
        // Bottom captions are centred 620 px above the bottom edge, like the Mac's.
        var bottom = CaptionRenderer.Elements(new EditSegment { Duration = 3, Captions = [cue], CaptionStyle = CaptionStyle.Classic })[0];
        Assert.Equal(620 - 105, bottom.Y);
    }

    [Fact]
    public void VeryShortCaptionIntervalsKeepTheirTimeAndDoNotCrash()
    {
        var root = Path.Combine(TestSetup.Root, $"tiny-captions-{Guid.NewGuid()}");
        var file = CaptionRenderer.WriteTrack(new EditSegment { Duration = 0.0001, Caption = "Hi" }, root, 32, 64);
        Assert.NotNull(file);
        Assert.Contains("duration 0.0001", File.ReadAllText(file));
    }
    static TimedCaption Cue(string text, double start, double duration) => new(text, start, duration);

    [Fact]
    public void WindowsCoverEverySegmentIncludingTheTail()
    {
        var cues = Enumerable.Range(0, 120).Select(i => Cue($"Complete story {i}.", i * 10, 8)).ToList();
        var windows = TranscriptSelection.Windows(cues, (0, 1200));
        Assert.Equal(0, windows[0].Start);
        Assert.Equal(1198, windows[^1].End);
        Assert.All(windows.Zip(windows.Skip(1)), pair => Assert.True(pair.Second.Start < pair.First.End, "Windows must overlap"));
    }

    [Fact]
    public async Task ARequestTimeoutFailsTheMapInsteadOfLeavingGaps()
    {
        // HttpClient reports a timeout as TaskCanceledException even though nobody cancelled.
        await Assert.ThrowsAsync<TaskCanceledException>(() => Concurrency.Map([1, 2, 3, 4], async (item, token) =>
        {
            await Task.Yield();
            return item == 2 ? throw new TaskCanceledException() : item.ToString();
        }, CancellationToken.None, limit: 2));
    }

    [Fact]
    public void OddSourceSizesNeverCropPastTheFrame()
    {
        var layout = Renderer.Layout(new EditSegment { Duration = 10, SplitScreen = true }, 1919, 1083);
        Assert.Contains("crop=958:1082:", layout);
        Assert.DoesNotContain(":1084:", layout);
    }

    [Fact]
    public void BatchesAreBalanced()
    {
        var batches = TranscriptSelection.Batches(Enumerable.Range(0, 13).ToList(), 6);
        Assert.Equal([5, 4, 4], batches.Select(b => b.Count));
    }

    [Fact]
    public void CutsFinishTheirSentenceAndStartOnOne()
    {
        var cues = new[] { Cue("One.", 0, 5), Cue("Two.", 5, 5), Cue("Three.", 10, 5), Cue("Four.", 15, 5) };
        var range = TranscriptSelection.CompleteSentences(6, 7, cues, (0, 20), 5, 15);
        Assert.Equal(5, range.Start);
        Assert.Equal(10, range.Duration);
    }

    [Fact]
    public void FillerEdgesAreTrimmed()
    {
        var cues = new[] { Cue("Okay so.", 0, 2), Cue("Nobody expected the crash.", 2, 6), Cue("It changed everything.", 8, 6), Cue("Thanks for watching.", 14, 2) };
        var range = TranscriptSelection.TrimmedFiller(0, 16, cues, 8);
        Assert.Equal(2, range.Start);
        Assert.Equal(12, range.Duration);
    }

    [Fact]
    public void AlignmentNeedsTheOpeningPayoffAndMostWords()
    {
        var reference = new[] { Cue("Here is a complete story with a useful ending.", 0, 5) };
        var good = "Here is a complete story with a useful ending.".Split(' ').Select((w, i) => new TimedSpeechWord(w, i * 0.5, 0.4)).ToList();
        Assert.True(TranscriptSelection.AlignmentIsReliable(good, reference));
        Assert.False(TranscriptSelection.AlignmentIsReliable(good.Take(5).ToList(), reference));
    }

    [Fact]
    public void ValidationKeepsStrongDistinctClipsInRange()
    {
        var valid = GeminiSelection.Validate([
            new Clip(300, 330, 8, "track"), new Clip(305, 335, 9, "fit"), new Clip(550, 580, 7, "fit"),
            new Clip(590, 620, 10, "track"), new Clip(double.NaN, 30, 10, "fit"),
        ], (300, 600), 30, 3);
        Assert.Equal([305.0, 550.0], valid.Select(c => c.Start));
        Assert.Throws<GeminiException>(() => GeminiSelection.Validate([new Clip(5, 35, 6.9, "fit")], (0, 60), 30, 1));
        var fallback = GeminiSelection.StrongestOrBest([new Clip(5, 35, 6, "fit", Reason: "Good hook.")], (0, 100), 30, 1, []);
        Assert.StartsWith("Weaker pick", fallback[0].Reason);
    }

    [Fact]
    public void CriteriaCombineIntoOneScore()
    {
        var rated = JsonDocument.Parse("""
            [{"id":0,"hook":9,"payoff":8,"standalone":9,"emotion":5,"novelty":6},
             {"id":1,"hook":10,"payoff":9,"standalone":3,"emotion":9,"novelty":9},
             {"id":2,"score":55}]
            """).RootElement.EnumerateArray().Select(GeminiSelection.ParseWindowScore).ToList();
        Assert.Equal(80.5, rated[0].Score, 2);
        Assert.True(rated[1].Score < 70, "A window that doesn't stand alone must fall below the clip line");
        Assert.Equal(55, rated[2].Score);
        Assert.Throws<GeminiException>(() => GeminiSelection.ParseWindowScore(JsonDocument.Parse("""{"id":0,"hook":11,"payoff":8,"standalone":9,"emotion":5,"novelty":6}""").RootElement));
        Assert.Equal([2, 0, 1], GeminiSelection.RankedWindowIds([new(0, 20), new(1, 10), new(2, 95)], [0, 1, 2]));
        Assert.Throws<GeminiException>(() => GeminiSelection.RankedWindowIds([new(0, 50), new(0, 90)], [0, 1]));
    }

    [Fact]
    public void WordTimingsAreValidatedAndGroupedIntoCaptions()
    {
        var words = GeminiSelection.ValidatedWords([("Hello", 0.1, 0.5), ("world.", 0.6, 1)], 300, 60);
        var cues = GeminiSelection.CaptionCues(words);
        Assert.Single(cues);
        Assert.Equal("Hello world.", cues[0].Text);
        Assert.Equal(300.1, cues[0].Start, 3);
        Assert.Throws<GeminiException>(() => GeminiSelection.ValidatedWords([("bad", 2, 1)], 0, 60));
        var overlapping = GeminiSelection.ValidatedWords([("First", 0.1, 0.6), ("word.", 0.5, 1)], 120, 60);
        Assert.Equal(overlapping[0].Start + overlapping[0].Duration, overlapping[1].Start, 3);
    }

    [Fact]
    public void OpeningFillerIsDroppedButMeaningfulWordsStay()
    {
        static List<TimedSpeechWord> Words(params string[] texts) => texts.Select((t, i) => new TimedSpeechWord(t, 10 + i * 0.4, 0.3)).ToList();
        var opened = ShortMaker.StrongOpening(9.9, 20, Words("So,", "um,", "nobody", "expected", "this."), 5);
        Assert.Equal(10.72, opened.Start, 3);
        Assert.Equal(29.9, opened.Start + opened.Duration, 3);
        Assert.Equal(9.9, ShortMaker.StrongOpening(9.9, 20, Words("Like", "most", "people,", "I", "panicked."), 5).Start);
        Assert.Equal(9.9, ShortMaker.StrongOpening(9.9, 1, Words("So", "go."), 1).Start);
    }

    [Fact]
    public void SpeakerCentersNeedTwoClearGroups()
    {
        Assert.Equal([0.3, 0.71], ShortMaker.SplitCenters([0.31, 0.7, 0.29, 0.72, 0.3])!.Select(x => Math.Round(x, 2)));
        Assert.Null(ShortMaker.SplitCenters([0.48, 0.5, 0.52]));
        Assert.Null(ShortMaker.SplitCenters([0.4]));
    }
}

public class GeminiTests
{
    [Theory]
    [InlineData("-1")]
    [InlineData("-Infinity")]
    [InlineData("Infinity")]
    [InlineData("NaN")]
    public void MalformedRetryDelaysAreIgnored(string delay)
    {
        using var response = new HttpResponseMessage(System.Net.HttpStatusCode.TooManyRequests);
        response.Headers.TryAddWithoutValidation("Retry-After", delay);
        Assert.Null(Gemini.RetryDelay(response, JsonSerializer.Serialize(new { error = new { details = new[] { new { retryDelay = delay + "s" } } } })));
    }
    [Fact]
    public async Task BusyServersAreRetried()
    {
        var gemini = new FakeGemini();
        var notes = new List<string>();
        var configuration = gemini.Configuration();
        configuration.OnRetry = notes.Add;
        foreach (var status in new[] { 503, 503, 503, 500, 200 }) gemini.Statuses.Enqueue(status);
        var recovered = await Gemini.Generate<JsonElement>([Gemini.Text("check")], new System.Text.Json.Nodes.JsonObject(), configuration);
        Assert.True(recovered.GetProperty("ok").GetBoolean());
        Assert.Equal(4, notes.Count);
        Assert.All(notes, n => Assert.StartsWith("Prism AI is busy", n));
    }

    [Fact]
    public void OnlyHesitationAndSignOffsAreTrimmedFromShortEdges()
    {
        TimedCaption Cue(string text, double start) => new(text, start, 1);
        var cues = new[] { Cue("Um.", 0), Cue("Yes.", 1), Cue("That is the answer.", 2), Cue("Thank you.", 3), Cue("Thanks for watching!", 4) };
        Assert.Equal((1.0, 3.0), TranscriptSelection.TrimmedFiller(0, 5, cues, 1));
        var words = new[] { new TimedSpeechWord("So", 0, 0.2), new TimedSpeechWord("um", 0.3, 0.2), new TimedSpeechWord("this", 1, 0.3), new TimedSpeechWord("works", 1.4, 0.3) };
        Assert.Equal(0.92, ShortMaker.StrongOpening(0, 5, words, 1).Start, 3);
        var and = new[] { new TimedSpeechWord("And", 0, 0.2), new TimedSpeechWord("then", 0.3, 0.2) };
        Assert.Equal(0, ShortMaker.StrongOpening(0, 5, and, 1).Start);
        Assert.Equal([new TimedCaption("in", 0.5, 0.5)], ShortMaker.ClipCaptions([new("before", 0, 1), new("in", 1.5, 1), new("after", 3, 1)], 1, 1));
    }

    [Fact]
    public void LongPiecesAreSplitAtSentencesAndTimedByLength()
    {
        var split = GeminiSelection.SplitSentences([("One two three. Four five six seven eight nine? Ten.", 0, 10), ("Short. Piece.", 10, 14)]);
        Assert.Equal(["One two three.", "Four five six seven eight nine?", "Ten.", "Short. Piece."], split.Select(p => p.Text));
        Assert.Equal(0, split[0].Start); Assert.Equal(10, split[2].End);
        Assert.True(split[1].End - split[1].Start > split[0].End - split[0].Start);
        Assert.Equal((10.0, 14.0), (split[3].Start, split[3].End));
    }

    [Fact]
    public void TranscriptsAreReadFromJsonOrSubtitleStyleLines()
    {
        Assert.Equal([("Hi there.", 0.5, 1.25)], GeminiSelection.TranscriptAnswer("""{"segments":[{"text":"Hi there.","start":0.5,"end":1.25}]}"""));
        Assert.Equal([("I'm a classifier.", 0.03, 4.9), ("That's Jev.", 4.9, 7)],
            GeminiSelection.TranscriptAnswer("0.03-4.90 | SPEAKER_00: I'm a classifier.\n4.90-7 | SPEAKER_01: That's Jev.\n"));
        Assert.Null(GeminiSelection.TranscriptAnswer("Sorry, I can't help with that."));
        // Only speaker labels are dropped; a line that starts with "Note:" keeps its words.
        Assert.Equal([("Note: this matters.", 1, 2)], GeminiSelection.TranscriptAnswer("1-2 | Note: this matters."));
    }

    [Fact]
    public async Task DescriptionsAreMatchedToTheirShortsAndBadIdsIgnored()
    {
        var gemini = new FakeGemini();
        gemini.Payloads.Enqueue("""{"items":[{"id":1,"description":"Second #b"},{"id":7,"description":"Nobody"},{"id":0,"description":"  "}]}""");
        var written = await GeminiSelection.Describe([("One", "first words"), ("Two", "second words")], gemini.Configuration());
        Assert.Equal(new Dictionary<int, string> { [1] = "Second #b" }, written);
        Assert.Contains("SHORTS_JSON", Assert.Single(gemini.Bodies));
    }

    [Fact]
    public async Task UsageLimitsAndSignInAreReportedAsSuch()
    {
        var limited = new FakeGemini { DefaultStatus = 429, ErrorBody = """{"error":{"code":"usage_limit","message":"You've reached your beta usage limit."}}""" };
        limited.Usage = limited.Usage with { Run = Guid.NewGuid().ToString() };
        var limit = await Assert.ThrowsAsync<GeminiException>(() => Gemini.Generate<JsonElement>([Gemini.Text("x")], new System.Text.Json.Nodes.JsonObject(), limited.Configuration()));
        Assert.Equal(GeminiFailure.UsageLimit, limit.Failure);
        Assert.Equal("You've reached your beta usage limit.", limit.Message);
        Assert.Single(limited.Bodies);

        var server = new FakeGemini();
        var signedOut = new GeminiConfiguration(() => Task.FromResult<string?>(null), server.Usage) { Handler = server };
        var signIn = await Assert.ThrowsAsync<GeminiException>(() => Gemini.Generate<JsonElement>([Gemini.Text("x")], new System.Text.Json.Nodes.JsonObject(), signedOut));
        Assert.Equal(GeminiFailure.SignIn, signIn.Failure);
        Assert.Empty(server.Bodies);
    }

    [Fact]
    public async Task QuotaAndTruncationFailClearly()
    {
        var gemini = new FakeGemini { DefaultStatus = 429 };
        var quota = await Assert.ThrowsAsync<GeminiException>(() => Gemini.Generate<JsonElement>([Gemini.Text("x")], new System.Text.Json.Nodes.JsonObject(), gemini.Configuration()));
        Assert.Equal(429, quota.Status);
        var truncated = new FakeGemini { Finish = "MAX_TOKENS" };
        var invalid = await Assert.ThrowsAsync<GeminiException>(() => Gemini.Generate<JsonElement>([Gemini.Text("x")], new System.Text.Json.Nodes.JsonObject(), truncated.Configuration()));
        Assert.Equal(GeminiFailure.InvalidResponse, invalid.Failure);
        var waited = new FakeGemini { ErrorBody = """{"error":{"code":429,"details":[{"retryDelay":"0s"}]}}""" };
        waited.Statuses.Enqueue(429);
        waited.Statuses.Enqueue(200);
        await Gemini.Generate<JsonElement>([Gemini.Text("x")], new System.Text.Json.Nodes.JsonObject(), waited.Configuration());
        Assert.Empty(waited.Statuses);
    }

    [Fact]
    public async Task SelectionScoresEveryWindowAndKeepsTheStrongestLateMoment()
    {
        var gemini = new FakeGemini();
        var cues = Enumerable.Range(0, 120).Select(i => new TimedCaption($"Complete story {i}.", i * 10, 8)).ToList();
        var windows = TranscriptSelection.Windows(cues, (0, 1200));
        foreach (var ids in TranscriptSelection.Batches(Enumerable.Range(0, windows.Count).ToList(), 6))
            gemini.Payloads.Enqueue(JsonSerializer.Serialize(new { windows = ids.Select(id => new { id, score = (double)id }) }));
        var shortlist = Math.Min(16, (int)(1200.0 / 90) + 2);
        var best = Enumerable.Range(0, windows.Count).Reverse().Take(shortlist).ToList();
        foreach (var ids in TranscriptSelection.Batches(best, 3))
        {
            var id = ids[0];
            gemini.Payloads.Enqueue(JsonSerializer.Serialize(new { clips = new[] { new {
                start = windows[id].Start - (id == windows.Count - 1 ? 1 : 0), end = windows[id].Start + 30,
                score = id == windows.Count - 1 ? 10 : 7, layout = "fit", title = "t", reason = "r" } } }));
        }
        var video = await Media.Pictures();
        var planned = await GeminiSelection.Select(video, cues, (0, 1200), 30, 1, gemini.Configuration(), concurrency: 1);
        Assert.Equal(windows[^1].Start, planned[0].Start);
        Assert.Equal(4, planned.Count);
    }

    [Fact]
    public async Task TranscriptionRunsChunksSideBySideInOrderAndHandsBackFinishedStretches()
    {
        var audio = await Media.Silence();
        var gemini = new FakeGemini();
        gemini.Payloads.Enqueue("""{"words":[{"text":"bad","start":0,"end":16}]}""");
        gemini.Payloads.Enqueue("""{"words":[{"text":"First.","start":0.1,"end":1}]}""");
        gemini.Payloads.Enqueue("""{"words":[{"text":"Second.","start":0.1,"end":1}]}""");
        gemini.Payloads.Enqueue("""{"words":[{"text":"Third.","start":0.1,"end":1}]}""");
        var stretches = new List<string>();
        var words = await GeminiSelection.Transcribe(audio, (0, 30), gemini.Configuration(), concurrency: 1,
            finished: (w, end) => stretches.Add($"{w.Count}@{end}"));
        Assert.Equal([0.1, 7.6, 15.1], words.Select(w => Math.Round(w.Start, 3)));
        Assert.Equal(["2@15", "3@30"], stretches);
        for (var i = 0; i < 4; i++) gemini.Payloads.Enqueue("""{"words":[{"text":"Word.","start":1,"end":2}]}""");
        var parallel = await GeminiSelection.Transcribe(audio, (0, 60), gemini.Configuration());
        Assert.Equal([1.0, 16, 31, 46], parallel.Select(w => w.Start));
    }
}

public class MediaTests
{
    [Fact]
    public async Task ProbeReportsDisplayedSizeAudioAndDuration()
    {
        var info = await FFmpeg.Probe(await Media.Pictures());
        Assert.NotNull(info);
        Assert.Equal((640, 360, true, true), (info.Width, info.Height, info.HasVideo, info.HasAudio));
        Assert.InRange(info.Duration, 5.9, 6.1);
        var rotated = await FFmpeg.Probe(await Media.Rotated());
        Assert.Equal((640, 360), (rotated!.Width, rotated.Height));
        Assert.Null(await FFmpeg.Probe(Path.Combine(TestSetup.Root, "missing.mp4")));
    }

    [Fact]
    public async Task FramesGridsAndAudioComeOutOfOnePass()
    {
        var video = await Media.Pictures();
        var frames = await FFmpeg.FramesJpeg(video, 1, 4, 1);
        Assert.InRange(frames.Count, 4, 5);
        Assert.Equal(0, frames[0].Time);
        Assert.InRange((await FFmpeg.GrayGrids(video, 0, 2)).Count, 19, 21);
        Assert.NotNull(await FFmpeg.AudioChunk(video, 1, 2));
        var levels = await FFmpeg.AudioLevels(video, 0, 2);
        Assert.InRange(levels!.Length, 198, 202);
    }

    [Fact]
    public async Task CutsSnapIntoTheNearestPauseNeverIntoAWord()
    {
        var audio = await Media.Pauses();
        var snapped = await ShortMaker.SilenceSnapped(audio, 2.55, 2.3, (0, 8));
        Assert.InRange(snapped.Start, 2.0, 2.42);
        Assert.InRange(snapped.Start + snapped.Duration, 5.0, 5.52);
        Assert.Equal((0.8, 0.7), await ShortMaker.SilenceSnapped(audio, 0.8, 0.7, (0, 8)));
        var protectedRange = await ShortMaker.SilenceSnapped(audio, 2.55, 2.3, (0, 8), [new TimedSpeechWord("pause", 1.9, 0.6)]);
        Assert.Equal(2.55, protectedRange.Start);
    }
}

public class FramingTests
{
    static FramingSample Sample(double time, double x, double? cut = null) => new(time, (x - 0.035, 0.07), cut);

    [Fact]
    public void StillSubjectsDontWobbleFastOnesStayInFrameAndCutsStayHard()
    {
        var still = Enumerable.Range(0, 30).Select(i => Sample(i * 0.12, 0.5 + (i % 2 == 0 ? 0.003 : -0.003))).ToList();
        var steady = SubjectFramer.Plan(still, 3.6, 640, 360, 1.08);
        Assert.True(steady.Max(p => p.Position) - steady.Min(p => p.Position) < 0.01);
        var fast = Enumerable.Range(0, 12).Select(i => Sample(i * 0.12, 0.2 + Math.Min(1, i / 5.0) * 0.6)).ToList();
        var follow = SubjectFramer.Plan(fast, 1.44, 640, 360, 1.08);
        var visible = 1080.0 / (640 * (1920.0 / 360) * 1.08);
        foreach (var point in follow.Where(p => p.Time < 1.32))
        {
            var x = 0.2 + Math.Min(1, point.Time / 0.12 / 5) * 0.6;
            Assert.True(Math.Abs(x - (visible / 2 + point.Position * (1 - visible))) < visible / 2, "Camera lost a fast moving subject");
        }
        var cuts = SubjectFramer.Plan([Sample(0, 0.2), Sample(0.5, 0.2), Sample(1, 0.8, 0.95), Sample(1.5, 0.8)], 2, 640, 360, 1.08);
        var cut = cuts.First(p => p.IsSceneCut == true);
        Assert.Equal(0.95, cut.Time);
        Assert.True(cut.Position > 0.85);
    }

    [Fact]
    public void MovesEaseGlideAndNeverOvershoot()
    {
        var move = SubjectFramer.Eased([new(0, 0.2), new(1, 0.2), new(2, 0.8), new(3, 0.8)]);
        var third = move.First(p => Math.Abs(p.Time - 4.0 / 3) < 0.001).Position;
        Assert.InRange(third, 0.2001, 0.3999);
        Assert.All(move, p => Assert.InRange(p.Position, 0.2, 0.8));
        var glide = SubjectFramer.Eased([new(0, 0.1), new(1, 0.4), new(2, 0.7)]);
        Assert.True(0.4 - glide.First(p => Math.Abs(p.Time - 2.0 / 3) < 0.001).Position > 0.05);
        Assert.Equal(3, SubjectFramer.Eased([new(0, 0.1), new(1, 0.9, true), new(2, 0.9)]).Count);
    }

    [Fact]
    public void CutsAreFoundBetweenSamples()
    {
        var dark = new byte[576];
        var bright = Enumerable.Repeat((byte)230, 576).ToArray();
        var grids = Enumerable.Range(0, 30).Select(i => i < 13 ? dark : bright).ToList();
        var cuts = SubjectFramer.DetectCuts([0, 1, 2], grids);
        // The cut falls between the 1 s and 2 s samples, so the 2 s sample reports it, pinned to 1.3 s.
        Assert.Null(cuts[0]);
        Assert.Null(cuts[1]);
        Assert.Equal(1.3, cuts[2]);
    }
}

public class RenderTests
{
    static async Task<(SKBitmapHolder Frame, MediaInfo Info)> Render(string source, EditSegment segment, ExportQuality quality = ExportQuality.Full, double at = 1)
    {
        var output = Path.Combine(TestSetup.Root, $"render-{Guid.NewGuid()}.mp4");
        await Renderer.Export(source, segment, output, quality);
        var info = await FFmpeg.Probe(output);
        return (new SKBitmapHolder(await Media.Frame(output, at)), info!);
    }

    sealed record SKBitmapHolder(SkiaSharp.SKBitmap Bitmap);

    [Fact]
    public async Task EveryLayoutRendersVerticalShortsOfTheRightLength()
    {
        var video = await Media.Pictures();
        foreach (var segment in new[]
        {
            new EditSegment { Start = 1, Duration = 3 },
            new EditSegment { Start = 1, Duration = 3, FitToFrame = true },
            new EditSegment { Start = 1, Duration = 3, SplitScreen = true, SplitCenters = [0.3, 0.7] },
            new EditSegment { Start = 1, Duration = 3, CropKeyframes = [new(0, 0), new(1.5, 1, true), new(3, 0.5)] },
        })
        {
            var (_, info) = await Render(video, segment);
            Assert.Equal((1080, 1920), (info.Width, info.Height));
            Assert.InRange(info.Duration, 2.9, 3.2);
            Assert.True(info.HasAudio);
        }
    }

    [Fact]
    public async Task PhoneVideoKeepsItsOrientation()
    {
        var rotated = await Media.Rotated();
        var truthFrame = await Media.Frame(rotated, 1);
        var truth = string.Join(",", new[] { (0.25, 0.25), (0.75, 0.25), (0.25, 0.75), (0.75, 0.75) }.Select(p => Media.Color(truthFrame, p.Item1, p.Item2)));
        var (fit, _) = await Render(rotated, new EditSegment { Duration = 2, FitToFrame = true });
        // Fit shows the whole 640×360 frame across 1080×607 in the middle of the 1920 height.
        var top = (1920 - 607.5) / 2 / 1920;
        var band = 607.5 / 1920;
        var got = string.Join(",", new[] { (0.25, 0.25), (0.75, 0.25), (0.25, 0.75), (0.75, 0.75) }.Select(p => Media.Color(fit.Bitmap, p.Item1, top + band * p.Item2)));
        Assert.Equal(truth, got);
    }

    [Fact]
    public async Task CaptionsShowOnlyDuringTheirTimeAndViralHighlightsTheSpokenWord()
    {
        var video = await Media.Gray();
        var segment = new EditSegment
        {
            Duration = 3, Captions = [new TimedCaption("Hello there everyone", 1, 1.5)], CaptionStyle = CaptionStyle.Viral,
            SpeechWords = [new("Hello", 1, 0.5), new("there", 1.5, 0.5), new("everyone", 2, 0.5)],
        };
        var output = Path.Combine(TestSetup.Root, $"captions-{Guid.NewGuid()}.mp4");
        await Renderer.Export(video, segment, output);
        static int Count(SkiaSharp.SKBitmap bitmap, Func<SkiaSharp.SKColor, bool> match)
        {
            var count = 0;
            // Bottom captions are centred 620 px above the bottom of 1920, as on the Mac.
            for (var y = (int)(bitmap.Height * 0.60); y < bitmap.Height * 0.76; y += 2)
                for (var x = 0; x < bitmap.Width; x += 2)
                    if (match(bitmap.GetPixel(x, y))) count++;
            return count;
        }
        static bool Yellow(SkiaSharp.SKColor c) => c.Red > 200 && c.Green > 200 && c.Blue < 80;
        var before = await Media.Frame(output, 0.5);
        var during = await Media.Frame(output, 1.2);
        Assert.True(Count(during, Yellow) > 50, "The spoken word must turn yellow");
        Assert.True(Count(before, Yellow) < Count(during, Yellow) / 10, "Captions must not show before their time");
    }

    [Fact]
    public async Task QualitySetsSizeAndCodecAndMuteDropsAudio()
    {
        var video = await Media.Pictures();
        var (_, small) = await Render(video, new EditSegment { Duration = 2, IsMuted = true }, ExportQuality.Small);
        Assert.Equal((720, 1280, false), (small.Width, small.Height, small.HasAudio));
        if (!FFmpeg.HasEncoder("libx265")) return;
        var output = Path.Combine(TestSetup.Root, $"hevc-{Guid.NewGuid()}.mp4");
        await Renderer.Export(video, new EditSegment { Duration = 2 }, output, ExportQuality.Compact);
        var probe = await FFmpeg.Run(FFmpeg.FFprobePath, ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=codec_name", "-of", "csv=p=0", output]);
        Assert.Equal("hevc", System.Text.Encoding.UTF8.GetString(probe.Output).Trim());
        await Assert.ThrowsAsync<ShortMakerException>(() => Renderer.Export(video, new EditSegment { Duration = 2 }, output));
    }

    [Fact]
    public async Task PreviewsAreCachedUntilTheShortChanges()
    {
        var video = await Media.Pictures();
        var segment = new EditSegment { Duration = 2 };
        var first = await Renderer.Preview(video, segment);
        Assert.Equal(first, await Renderer.Preview(video, segment));
        segment.CropPosition = 0.2;
        Assert.NotEqual(first, await Renderer.Preview(video, segment));
        Assert.Equal((540, 960), await FFmpeg.Probe(first) is { } p ? (p.Width, p.Height) : default);
    }

    [Fact]
    public void EveryStyleHasAPreview()
    {
        foreach (var style in CaptionStyles.Choices) Assert.True(CaptionRenderer.StylePreview(style).Length > 500, style.Title());
    }
}

public class StorageTests
{
    [Fact]
    public void ProjectsReadAndWriteTheMacOSFormat()
    {
        const string mac = """
            {"id":"E621E1F8-C36C-495A-93FC-0C247A3E6E5F","name":"Video","media":[{"id":"11111111-2222-3333-4444-555555555555","path":"/Users/x/a.mov",
             "kind":"video","duration":30.5,"width":1920,"height":1080,"note":"","priority":50,"created":782000000}],
             "segments":[{"mediaID":"11111111-2222-3333-4444-555555555555","duration":12,"captionStyle":"highlightBox","captionPosition":"middle",
             "cropKeyframes":[{"time":0,"position":0.5,"isSceneCut":true}]}],"memory":"","created":782000000.5,
             "transcripts":{"11111111-2222-3333-4444-555555555555":{"start":0,"end":30,"cues":[{"text":"Hi.","start":1,"duration":2}]}}}
            """;
        var project = PrismJson.Deserialize<ProjectData>(mac)!;
        var segment = project.Segments[0];
        Assert.Equal(CaptionStyle.HighlightBox, segment.CaptionStyle);
        Assert.Equal(1.08, segment.CropZoom);
        Assert.Equal(0.5, segment.CropPosition);
        Assert.Equal(project.Media[0].Id, segment.MediaId);
        Assert.Equal(2025, project.Created.Year);
        var written = PrismJson.Serialize(project);
        Assert.Contains("\"mediaID\":\"11111111-2222-3333-4444-555555555555\"", written);
        Assert.Contains("\"captionStyle\":\"highlightBox\"", written);
        Assert.Contains("\"created\":782000000.5", written);
        Assert.DoesNotContain("\"title\"", written);
    }

    [Fact]
    public void OpeningAFolderThatIsNotAProjectLeavesNothingBehind()
    {
        var folder = Path.Combine(TestSetup.Root, $"not-a-project-{Guid.NewGuid()}");
        Directory.CreateDirectory(folder);
        Assert.Throws<StoreException>(() => new ProjectStore(folder, create: false));
        Assert.Empty(Directory.GetFiles(folder));
        var project = Path.Combine(TestSetup.Root, $"project-{Guid.NewGuid()}.relio");
        using (var store = new ProjectStore(project)) store.Save(new ProjectData { Name = "Saved" }, "project");
        Assert.Equal("Saved", ProjectStore.ReadProject(project)?.Name);
    }
}
