using System.Globalization;
using System.Text;
using SkiaSharp;

namespace Prism.Core;

/// Subtitles and the text overlay, drawn the way the macOS app draws them, in 1080×1920 video pixels.
/// Each caption is a layer 940 px wide; its bottom edge sits at <see cref="Element.Y"/> measured from the bottom of the frame.
public static class CaptionRenderer
{
    public sealed record Element(string Text, double Start, double Duration, double Y, CaptionStyle Style, double Scale, int? HighlightedWord, bool Pops);

    static SKTypeface? text;

    /// <summary>Sora for captions, from the app's Fonts folder; the system default if it is missing.</summary>
    static SKTypeface TextFace => text ??= Load("Sora-Medium.ttf");

    static SKTypeface Load(string file)
    {
        var path = Path.Combine(AppContext.BaseDirectory, "Fonts", file);
        return File.Exists(path) ? SKTypeface.FromFile(path) ?? SKTypeface.Default : SKTypeface.Default;
    }

    static List<string> Normalized(IEnumerable<string> words) =>
        words.SelectMany(w => System.Text.RegularExpressions.Regex.Split(w.ToLowerInvariant(), @"[^\p{L}\p{N}]+")).Where(t => t.Length > 0).ToList();

    /// <summary>Every caption layer of a Short with its timing: subtitles per the Short's style, then the text overlay.</summary>
    public static List<Element> Elements(EditSegment segment)
    {
        var result = new List<Element>();
        var captions = segment.Captions ?? [];
        if (captions.Count == 0 && string.IsNullOrEmpty(segment.Caption)) return result;
        var total = segment.Duration;
        var position = segment.CaptionPosition ?? CaptionPosition.Bottom;
        var y = position.Y();
        var scale = (segment.CaptionSize ?? CaptionSize.Medium).Scale();
        var pops = segment.CaptionAnimated == true;
        // The on-screen text overlay moves out of the subtitles' way.
        var overlayY = captions.Count == 0 ? 220 : position == CaptionPosition.Top ? 330 : 1450;
        var style = (segment.CaptionStyle ?? CaptionStyle.Classic).Resolved(segment.VideoType, segment.SplitScreen == true);
        // Word-following styles need real word timings; estimated timings would mark the wrong word.
        var timedWords = style.UsesWordTiming() || style == CaptionStyle.BoldCaps ? segment.SpeechWords ?? [] : [];
        void Add(string text, double start, double duration, double layerY, CaptionStyle layerStyle, double layerScale, int? highlighted, bool pop)
        {
            if (!double.IsFinite(start) || !double.IsFinite(duration) || !double.IsFinite(total) || total <= 0 || start >= total || duration <= 0) return;
            var overlayStart = Math.Clamp(start, 0, total);
            var overlayEnd = Math.Min(total, start + duration);
            if (overlayEnd <= overlayStart) return;
            result.Add(new Element(text, overlayStart, overlayEnd - overlayStart, layerY, layerStyle, layerScale, highlighted, pop));
        }
        foreach (var cue in captions)
        {
            var cueWords = timedWords.Where(w => w.Start >= cue.Start - 0.02 && w.Start + w.Duration <= cue.Start + cue.Duration + 0.02).OrderBy(w => w.Start).ToList();
            if (cueWords.Count == 0 || !Normalized(cueWords.Select(w => w.Text)).SequenceEqual(Normalized([cue.Text])))
            {
                Add(cue.Text, cue.Start, cue.Duration, y, style, scale, null, pops);
                continue;
            }
            double End(int index) => index + 1 < cueWords.Count ? cueWords[index + 1].Start : cue.Start + cue.Duration;
            switch (style)
            {
                case CaptionStyle.BoldCaps:
                    for (var first = 0; first < cueWords.Count; first += 3)
                    {
                        var group = cueWords.Skip(first).Take(3).ToList();
                        Add(string.Join(" ", group.Select(w => w.Text)), group[0].Start, Math.Max(0.01, End(first + group.Count - 1) - group[0].Start), y, style, scale, null, pops);
                    }
                    break;
                case CaptionStyle.OneWord:
                    for (var index = 0; index < cueWords.Count; index++)
                        Add(cueWords[index].Text, cueWords[index].Start, Math.Max(0.01, End(index) - cueWords[index].Start), y, style, scale, null, pops);
                    break;
                case CaptionStyle.Viral or CaptionStyle.HighlightBox or CaptionStyle.Podcast:
                    // Only a new line pops; a moving highlight inside the same line must not bounce on every word.
                    for (var index = 0; index < cueWords.Count; index++)
                        Add(cue.Text, cueWords[index].Start, Math.Max(0.01, End(index) - cueWords[index].Start), y, style, scale, index, pops && index == 0);
                    break;
                default:
                    Add(cue.Text, cue.Start, cue.Duration, y, style, scale, null, pops);
                    break;
            }
        }
        if (!string.IsNullOrEmpty(segment.Caption))
            Add(segment.Caption, segment.CaptionStart ?? 0, segment.CaptionDuration ?? segment.Duration, overlayY, CaptionStyle.Classic, 1, null, false);
        return result;
    }

    static double LayerHeight(Element element) => Math.Round((element.Style == CaptionStyle.BoldCaps ? 300 : 210) * element.Scale);

    /// <summary>A caption layer, 940 px wide, drawn into <paramref name="canvas"/> with its top-left at the canvas origin.</summary>
    static void DrawLayer(SKCanvas canvas, string text, CaptionStyle style, double k, int? highlightedWord)
    {
        style = style.Resolved();
        var height = (float)Math.Round((style == CaptionStyle.BoldCaps ? 300 : 210) * k);
        var shown = style == CaptionStyle.BoldCaps ? text.ToUpper(CultureInfo.CurrentCulture) : text;
        // macOS lays text into a rect inset 24 px at the sides, 15·k from the top and 30·k from the bottom.
        var top = (float)(15 * k);
        const float left = 24, width = 892;
        switch (style)
        {
            case CaptionStyle.Minimal:
            {
                // Calm text on a soft dark band sized to the words.
                using var font = Font(TextFace, 46 * k, embolden: false);
                var lines = Wrap(shown, font, (float)(width - 48 * k));
                var lineHeight = LineHeight(font);
                var textWidth = lines.Max(l => font.MeasureText(l.Text)) + 2;
                var textHeight = lineHeight * lines.Count;
                var band = SKRect.Create(left + width / 2 - textWidth / 2 - (float)(24 * k), top, textWidth + (float)(48 * k), textHeight + (float)(20 * k));
                using (var fill = new SKPaint { Color = new SKColor(0, 0, 0, 158), IsAntialias = true })
                    canvas.DrawRoundRect(band, (float)(18 * k), (float)(18 * k), fill);
                using var white = new SKPaint { Color = SKColors.White, IsAntialias = true };
                DrawLines(canvas, lines, font, left + width / 2, band.Top + (float)(10 * k), lineHeight, (_, _) => white, null, null);
                break;
            }
            case CaptionStyle.Podcast:
            {
                // White text with a soft shadow; the spoken word in green.
                using var font = Font(TextFace, 56 * k, embolden: true);
                var lines = Wrap(shown, font, width);
                using var white = new SKPaint { Color = SKColors.White, IsAntialias = true,
                    ImageFilter = SKImageFilter.CreateDropShadow(0, (float)(2 * k), (float)(5 * k), (float)(5 * k), new SKColor(0, 0, 0, 217)) };
                using var green = new SKPaint { Color = new SKColor(56, 227, 125), IsAntialias = true, ImageFilter = white.ImageFilter };
                DrawLines(canvas, lines, font, left + width / 2, top, LineHeight(font), (index, _) => index == highlightedWord ? green : white, null, null);
                break;
            }
            default:
            {
                // Simple, Viral, Highlight box, Bold caps and One word: heavy white text with a black outline. The outline is the
                // text repeated in black around the edge; a stroke instead would cut into the counters of letters such as e and a.
                var size = (style == CaptionStyle.OneWord ? 104 : style == CaptionStyle.BoldCaps ? 76 : 66) * k;
                var radius = (float)((style == CaptionStyle.OneWord ? 5 : style == CaptionStyle.BoldCaps ? 4 : 3) * k);
                using var font = Font(TextFace, size, embolden: true);
                var lines = Wrap(shown, font, width);
                var lineHeight = LineHeight(font);
                using var black = new SKPaint { Color = SKColors.Black, IsAntialias = true };
                using var white = new SKPaint { Color = SKColors.White, IsAntialias = true };
                using var yellow = new SKPaint { Color = new SKColor(255, 255, 0), IsAntialias = true };
                for (var step = 0; step < 16; step++)
                {
                    var angle = step * Math.PI / 8;
                    DrawLines(canvas, lines, font, left + width / 2 + radius * (float)Math.Cos(angle), top + radius * (float)Math.Sin(angle), lineHeight, (_, _) => black, null, null);
                }
                var boxed = style == CaptionStyle.HighlightBox ? highlightedWord : null;
                DrawLines(canvas, lines, font, left + width / 2, top, lineHeight,
                    (index, _) => index == highlightedWord ? (style == CaptionStyle.HighlightBox ? black : yellow) : white, boxed, yellow);
                break;
            }
        }
    }

    static SKFont Font(SKTypeface face, double size, bool embolden) =>
        new(face, (float)size) { Embolden = embolden, Subpixel = true, Edging = SKFontEdging.Antialias };

    static float LineHeight(SKFont font) => font.Metrics.Descent - font.Metrics.Ascent + font.Metrics.Leading;

    sealed record Line(string Text, List<(string Word, int Index)> Words);

    /// Greedy word wrap, keeping each word's index in the whole caption for highlighting.
    static List<Line> Wrap(string text, SKFont font, float width)
    {
        var words = text.Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries);
        var lines = new List<Line>();
        var current = new List<(string, int)>();
        for (var index = 0; index < words.Length; index++)
        {
            var candidate = string.Join(" ", current.Select(w => w.Item1).Append(words[index]));
            if (current.Count > 0 && font.MeasureText(candidate) > width)
            {
                lines.Add(new Line(string.Join(" ", current.Select(w => w.Item1)), current));
                current = [];
            }
            current.Add((words[index], index));
        }
        if (current.Count > 0) lines.Add(new Line(string.Join(" ", current.Select(w => w.Item1)), current));
        if (lines.Count == 0) lines.Add(new Line("", []));
        return lines;
    }

    /// Centered lines, word by word, so one word can have its own color or a box behind it.
    static void DrawLines(SKCanvas canvas, List<Line> lines, SKFont font, float centerX, float top, float lineHeight,
                          Func<int, string, SKPaint> paintFor, int? boxedWord, SKPaint? boxPaint)
    {
        var space = font.MeasureText(" ");
        var y = top;
        foreach (var line in lines)
        {
            var x = centerX - font.MeasureText(line.Text) / 2;
            var baseline = y - font.Metrics.Ascent;
            foreach (var (word, index) in line.Words)
            {
                var advance = font.MeasureText(word);
                if (boxedWord == index && boxPaint is not null) canvas.DrawRect(SKRect.Create(x, y, advance, lineHeight), boxPaint);
                canvas.DrawText(word, x, baseline, SKTextAlign.Left, font, paintFor(index, word));
                x += advance + space;
            }
            y += lineHeight;
        }
    }

    /// <summary>One full 1080×1920 frame with the given layers, each scaled around its center (the pop-in animation).</summary>
    public static SKImage DrawFrame(IEnumerable<(Element Element, double Scale)> layers, int width = 1080, int height = 1920)
    {
        using var surface = SKSurface.Create(new SKImageInfo(width, height, SKColorType.Rgba8888, SKAlphaType.Premul));
        var canvas = surface.Canvas;
        canvas.Clear(SKColors.Transparent);
        canvas.Scale(width / 1080f, height / 1920f);
        foreach (var (element, scale) in layers)
        {
            var layerHeight = (float)LayerHeight(element);
            var layerTop = (float)(1920 - (element.Y + layerHeight));
            canvas.Save();
            canvas.Translate(70, layerTop);
            if (Math.Abs(scale - 1) > 0.001) canvas.Scale((float)scale, (float)scale, 470, layerHeight / 2);
            DrawLayer(canvas, element.Text, element.Style, element.Scale, element.HighlightedWord);
            canvas.Restore();
        }
        return surface.Snapshot();
    }

    /// <summary>The pop-in scale at a moment: 0.8 → 1.08 → 1 over the first 0.2 s (or the whole caption if shorter).</summary>
    public static double PopScale(Element element, double time)
    {
        if (!element.Pops) return 1;
        var length = Math.Min(0.2, element.Duration);
        var t = (time - element.Start) / length;
        if (t < 0 || t >= 1) return 1;
        return t < 0.6 ? 0.8 + (1.08 - 0.8) * t / 0.6 : 1.08 + (1 - 1.08) * (t - 0.6) / 0.4;
    }

    /// <summary>Writes the Short's captions as transparent PNG frames plus an ffconcat list with their durations, ready to lay over the
    /// video. Null when the Short has no captions or text.</summary>
    public static string? WriteTrack(EditSegment segment, string directory, int width = 1080, int height = 1920)
    {
        var elements = Elements(segment);
        if (elements.Count == 0) return null;
        Directory.CreateDirectory(directory);
        var total = segment.Duration;
        var times = new SortedSet<double> { 0, total };
        foreach (var element in elements)
        {
            times.Add(element.Start);
            times.Add(Math.Min(total, element.Start + element.Duration));
            if (element.Pops)
                for (var step = 1; step <= Math.Ceiling(Math.Min(0.2, element.Duration) * 30); step++)
                    times.Add(Math.Min(total, element.Start + step / 30.0));
        }
        var boundaries = times.Where(t => t >= 0 && t <= total).ToList();
        var entries = new List<(string File, double Duration)>();
        var drawn = new Dictionary<string, string>();
        for (var index = 0; index + 1 < boundaries.Count; index++)
        {
            double from = boundaries[index], to = boundaries[index + 1];
            if (to <= from) continue;
            var middle = (from + to) / 2;
            var active = elements.Select((element, n) => (element, n)).Where(e => e.element.Start <= middle && middle < e.element.Start + e.element.Duration)
                                 .Select(e => (e.element, e.n, Scale: PopScale(e.element, from))).ToList();
            var signature = string.Join(";", active.Select(a => $"{a.n}:{a.Scale:0.000}"));
            if (!drawn.TryGetValue(signature, out var file))
            {
                file = $"caption{drawn.Count:0000}.png";
                using var image = DrawFrame(active.Select(a => (a.element, a.Scale)), width, height);
                using var data = image.Encode(SKEncodedImageFormat.Png, 100);
                using var stream = File.Create(Path.Combine(directory, file));
                data.SaveTo(stream);
                drawn[signature] = file;
            }
            if (entries.Count > 0 && entries[^1].File == file) entries[^1] = (file, entries[^1].Duration + (to - from));
            else entries.Add((file, to - from));
        }
        var list = new StringBuilder("ffconcat version 1.0\n");
        foreach (var (file, duration) in entries)
            list.Append(CultureInfo.InvariantCulture, $"file '{file}'\nduration {duration:0.######}\n");
        // The concat demuxer ignores the last entry's duration, so the final frame is listed once more.
        list.Append(CultureInfo.InvariantCulture, $"file '{entries[^1].File}'\n");
        var listPath = Path.Combine(directory, "captions.ffconcat");
        File.WriteAllText(listPath, list.ToString());
        return listPath;
    }

    /// <summary>A sample of a subtitle style as PNG, drawn by the same code as exported captions so the picker matches the video.</summary>
    public static byte[] StylePreview(CaptionStyle style)
    {
        var (text, highlighted) = style.Resolved() switch
        {
            CaptionStyle.OneWord => ("Hello", (int?)null),
            CaptionStyle.Viral or CaptionStyle.HighlightBox or CaptionStyle.Podcast => ("Hello everyone", 0),
            _ => ("Hello everyone", null),
        };
        var height = (int)Math.Round(style == CaptionStyle.BoldCaps ? 300.0 : 210.0);
        using var surface = SKSurface.Create(new SKImageInfo(940, height, SKColorType.Rgba8888, SKAlphaType.Premul));
        surface.Canvas.Clear(SKColors.Transparent);
        DrawLayer(surface.Canvas, text, style, 1, highlighted);
        using var image = surface.Snapshot();
        using var trimmed = TrimmedToContent(image, 14);
        using var data = trimmed.Encode(SKEncodedImageFormat.Png, 100);
        return data.ToArray();
    }

    /// Crops away the transparent margin so a small preview shows the text large.
    static SKImage TrimmedToContent(SKImage image, int padding)
    {
        using var bitmap = SKBitmap.FromImage(image);
        int minX = bitmap.Width, minY = bitmap.Height, maxX = -1, maxY = -1;
        for (var y = 0; y < bitmap.Height; y++)
            for (var x = 0; x < bitmap.Width; x++)
                if (bitmap.GetPixel(x, y).Alpha > 8)
                {
                    minX = Math.Min(minX, x); maxX = Math.Max(maxX, x); minY = Math.Min(minY, y); maxY = Math.Max(maxY, y);
                }
        if (maxX < minX) return SKImage.FromBitmap(bitmap);
        var box = SKRectI.Create(Math.Max(0, minX - padding), Math.Max(0, minY - padding),
            Math.Min(bitmap.Width, maxX + padding + 1) - Math.Max(0, minX - padding), Math.Min(bitmap.Height, maxY + padding + 1) - Math.Max(0, minY - padding));
        return image.Subset(box) ?? SKImage.FromBitmap(bitmap);
    }
}
