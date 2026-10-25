using System.ComponentModel;
using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using Cairo;
using Prism.Core;
using SkiaSharp;
using Format = Prism.Core.Format;
using Path = System.IO.Path;

namespace Prism.Linux;

/// The editor's time tracks share the same ranges and saved framing points as the renderer.
public sealed class LinuxTimeline : IDisposable
{
    readonly AppSession session;
    readonly SynchronizationContext? context;
    readonly Gtk.DrawingArea area = Gtk.DrawingArea.New();
    readonly Gtk.Box container = Gtk.Box.New(Gtk.Orientation.Vertical, 0);
    readonly Gtk.Button undo = Gtk.Button.NewFromIconName("edit-undo-symbolic");
    readonly Gtk.Button audio = Gtk.Button.NewFromIconName("audio-volume-high-symbolic");
    readonly Gtk.Button add = Gtk.Button.NewWithLabel("Add clip");
    readonly Gtk.Button generate = Gtk.Button.NewWithLabel("✦  Auto Shorts");
    readonly Gtk.Button settings = Gtk.Button.NewFromIconName("emblem-system-symbolic");
    readonly Gtk.Label title = Gtk.Label.New("Source timeline");
    readonly List<ImageSurface> frames = [];
    readonly Dictionary<string, float[]> waveforms = [];
    readonly uint tick;
    CancellationTokenSource? resources;
    string? resourceKey;
    float[]? waveform;
    bool loadingWaveform;
    bool disposed;
    double plotWidth = 1;
    double dragStartX, dragStartY, dragX, dragY;
    bool focusDrag;
    bool dragActive;
    Guid? draggedShortId;
    long lastTick;
    const double Left = 112, Right = 12;
    const double VideoY = 32, VideoHeight = 60, FocusY = 100, FocusHeight = 28;
    const double TextY = 136, TextHeight = 30, AudioY = 174, AudioHeight = 34;

    public Gtk.Widget Widget => container;
    MediaItem? Media => session.Project?.Media.FirstOrDefault(m => m.Id == (session.ActiveSegment?.MediaId ?? session.Selection));
    double Length => Math.Max(0.1, session.ActiveSegment?.Duration ?? Media?.Duration ?? 1);
    bool Blocked => session.IsBusy || session.ExportChoice is not null || session.ExportSummary is not null || session.GenerationError is not null || !session.IsGeminiKeySaved;

    public LinuxTimeline(AppSession session)
    {
        this.session = session;
        context = SynchronizationContext.Current;
        container.AddCssClass("timeline");
        var tools = Gtk.Box.New(Gtk.Orientation.Horizontal, 6);
        tools.AddCssClass("timeline-tools");
        undo.TooltipText = "Undo edit · Ctrl+Z";
        audio.TooltipText = "Toggle clip audio";
        settings.TooltipText = "Auto Shorts settings";
        title.Hexpand = true;
        title.Xalign = 0;
        foreach (var button in new[] { undo, audio, add, generate, settings }) { button.AddCssClass("link"); button.Valign = Gtk.Align.Center; }
        foreach (var button in new[] { undo, audio, settings }) button.AddCssClass("icon");
        title.AddCssClass("t11"); title.AddCssClass("medium");
        var rule = Gtk.Box.New(Gtk.Orientation.Vertical, 0); rule.AddCssClass("divider"); rule.SetSizeRequest(1, 16); rule.Valign = Gtk.Align.Center; rule.MarginStart = 8; rule.MarginEnd = 8;
        tools.Append(undo); tools.Append(audio); tools.Append(rule); tools.Append(title);
        tools.Append(add); tools.Append(generate); tools.Append(settings);
        // A failed action reports on the status line instead of taking the window down.
        void Safely(Action action) { try { action(); } catch (Exception error) { session.Message = error.Message; } }
        undo.OnClicked += (_, _) => Safely(session.UndoFromEditor);
        audio.OnClicked += (_, _) => Safely(session.ToggleSelectedAudio);
        add.OnClicked += (_, _) => Safely(session.AddManualClip);
        generate.OnClicked += async (_, _) => { try { await session.MakeConfiguredShorts(); } catch (Exception error) { session.Message = error.Message; } };
        settings.OnClicked += (_, _) => Safely(() => session.Screen = Screen.ImportSource);
        container.Append(tools);
        area.ContentHeight = 224;
        area.Hexpand = true;
        area.Vexpand = true;
        area.TooltipText = "Click the ruler to seek. Click a Short to open it. Click to add a focus point or drag an existing point.";
        area.SetDrawFunc((_, cr, width, height) => Draw(cr, width, height));
        var drag = Gtk.GestureDrag.New();
        drag.Button = 1;
        drag.OnDragBegin += (_, args) => BeginDrag(args.StartX, args.StartY);
        drag.OnDragUpdate += (_, args) => MoveDrag(args.OffsetX, args.OffsetY);
        drag.OnDragEnd += (_, args) => EndDrag(args.OffsetX, args.OffsetY);
        area.AddController(drag);
        container.Append(area);
        tick = area.AddTickCallback((_, _) =>
        {
            if (disposed) return false;
            var now = Environment.TickCount64;
            if (now - lastTick >= 100) { lastTick = now; area.QueueDraw(); }
            return true;
        });
        session.PropertyChanged += Changed;
        Refresh();
    }

    void Changed(object? sender, PropertyChangedEventArgs args)
    {
        if (args.PropertyName is nameof(AppSession.Project) or nameof(AppSession.Selection) or nameof(AppSession.PreviewShortId)
            or nameof(AppSession.IsBusy) or nameof(AppSession.CanUndo) or nameof(AppSession.IsGeminiKeySaved)
            or nameof(AppSession.ExportChoice) or nameof(AppSession.ExportSummary) or nameof(AppSession.GenerationError)) Refresh();
    }

    public void Refresh()
    {
        if (disposed) return;
        title.Label_ = session.ActiveSegment is null ? "Source timeline" : "Short timeline";
        undo.Sensitive = session.CanUndo && !Blocked;
        audio.Sensitive = session.ActiveSegment is not null && !Blocked;
        audio.IconName = session.ActiveSegment?.IsMuted == true ? "audio-volume-muted-symbolic" : "audio-volume-high-symbolic";
        add.Sensitive = generate.Sensitive = Media is not null && !Blocked;
        settings.Sensitive = !Blocked;
        var media = Media;
        var start = session.ActiveSegment?.Start ?? 0;
        var length = Length;
        var key = media is null ? "" : string.Create(CultureInfo.InvariantCulture, $"{media.Path}|{start:R}|{length:R}|{media.HasAudio}");
        if (resourceKey != key)
        {
            resourceKey = key;
            resources?.Cancel();
            resources?.Dispose();
            resources = new CancellationTokenSource();
            ReleaseFrames();
            waveform = waveforms.GetValueOrDefault(key);
            loadingWaveform = media?.HasAudio == true && waveform is null;
            if (media is not null) _ = LoadResources(media.Path, start, length, loadingWaveform, key, resources);
        }
        area.QueueDraw();
    }

    void OnUI(Action action)
    {
        if (context is null || SynchronizationContext.Current == context) action();
        else context.Post(_ => action(), null);
    }

    async Task LoadResources(string path, double start, double length, bool hasAudio, string key, CancellationTokenSource request)
    {
        var token = request.Token;
        bool Current() => !disposed && ReferenceEquals(resources, request) && !token.IsCancellationRequested;

        async Task LoadFrames()
        {
            try
            {
                // A frame per minute, matching the macOS filmstrip, with a bounded number for long recordings.
                var count = Math.Clamp((int)Math.Ceiling(length / 60), 1, 120);
                var directory = Path.Combine(Renderer.CacheDirectory, "Filmstrip");
                Directory.CreateDirectory(directory);
                var stamp = File.Exists(path) ? new FileInfo(path).LastWriteTimeUtc.Ticks : 0;
                for (var index = 0; index < count; index++)
                {
                    token.ThrowIfCancellationRequested();
                    var time = start + Math.Min(length - 0.05, length * (index + 0.5) / count);
                    var identity = string.Create(CultureInfo.InvariantCulture, $"{path}|{stamp}|{time:R}");
                    var png = Path.Combine(directory, Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(identity)))[..32] + ".png");
                    if (!File.Exists(png))
                    {
                        var jpeg = await FFmpeg.FrameJpeg(path, Math.Max(0, time), 240, token).ConfigureAwait(false);
                        if (jpeg is null) continue;
                        using var bitmap = SKBitmap.Decode(jpeg);
                        if (bitmap is null) continue;
                        using var image = SKImage.FromBitmap(bitmap);
                        using var encoded = image.Encode(SKEncodedImageFormat.Png, 100);
                        var temporary = png + $".{Guid.NewGuid()}.tmp";
                        try
                        {
                            await File.WriteAllBytesAsync(temporary, encoded.ToArray(), token).ConfigureAwait(false);
                            token.ThrowIfCancellationRequested();
                            File.Move(temporary, png, overwrite: true);
                        }
                        finally { try { File.Delete(temporary); } catch (IOException) { } }
                    }
                    OnUI(() =>
                    {
                        if (!Current()) return;
                        var surface = new ImageSurface(png);
                        if (surface.Width > 0 && surface.Height > 0) frames.Add(surface); else surface.Dispose();
                        area.QueueDraw();
                    });
                }
            }
            catch (OperationCanceledException) { }
            catch (Exception) { /* Thumbnail failure never prevents editing. */ }
        }

        async Task LoadWaveform()
        {
            if (!hasAudio) return;
            try
            {
                // Read manageable chunks instead of allocating PCM for an entire multi-hour source.
                const int bars = 1600;
                var levels = new float[bars];
                for (var offset = 0.0; offset < length; offset += 60)
                {
                    token.ThrowIfCancellationRequested();
                    var chunk = await FFmpeg.AudioLevels(path, start + offset, start + Math.Min(length, offset + 60), token).ConfigureAwait(false);
                    if (chunk is null) continue;
                    for (var index = 0; index < chunk.Length; index++)
                    {
                        var bin = Math.Clamp((int)((offset + index * 0.01) / length * bars), 0, bars - 1);
                        levels[bin] = Math.Max(levels[bin], chunk[index]);
                    }
                    var snapshot = (float[])levels.Clone();
                    OnUI(() => { if (Current()) { waveform = snapshot; area.QueueDraw(); } });
                }
                OnUI(() =>
                {
                    if (!Current()) return;
                    if (waveforms.Count >= 8) waveforms.Remove(waveforms.Keys.First());
                    waveforms[key] = levels;
                });
            }
            catch (OperationCanceledException) { }
            catch (Exception) { /* A waveform failure never prevents editing. */ }
            finally { OnUI(() => { if (Current()) { loadingWaveform = false; area.QueueDraw(); } }); }
        }

        await Task.WhenAll(LoadFrames(), LoadWaveform()).ConfigureAwait(false);
    }

    (double R, double G, double B) Color(string dark, string light)
    {
        var hex = session.Settings.Appearance == "light" ? light : dark;
        return (Convert.ToInt32(hex[..2], 16) / 255.0, Convert.ToInt32(hex[2..4], 16) / 255.0, Convert.ToInt32(hex[4..], 16) / 255.0);
    }

    void Ink(Context cr, string dark, string light, double opacity = 1)
    {
        var (r, g, b) = Color(dark, light);
        cr.SetSourceRgba(r, g, b, opacity);
    }

    static void Rounded(Context cr, double x, double y, double width, double height, double radius = 4)
    {
        radius = Math.Min(radius, Math.Min(width, height) / 2);
        cr.NewSubPath();
        cr.Arc(x + width - radius, y + radius, radius, -Math.PI / 2, 0);
        cr.Arc(x + width - radius, y + height - radius, radius, 0, Math.PI / 2);
        cr.Arc(x + radius, y + height - radius, radius, Math.PI / 2, Math.PI);
        cr.Arc(x + radius, y + radius, radius, Math.PI, 3 * Math.PI / 2);
        cr.ClosePath();
    }

    void Text(Context cr, string text, double x, double baseline, double width, bool secondary = false, bool mono = false, double size = 11)
    {
        if (width <= 0) return;
        cr.Save();
        cr.Rectangle(x, baseline - size - 3, width, size + 8); cr.Clip();
        Ink(cr, secondary ? "8A8F98" : "F6F3EC", secondary ? "5C6068" : "0E0F14");
        cr.SelectFontFace(mono ? "JetBrains Mono" : "Sora", FontSlant.Normal, FontWeight.Normal);
        cr.SetFontSize(size); cr.MoveTo(x, baseline); cr.ShowText(text.Replace('\n', ' '));
        cr.Restore();
    }

    /// A Mac-style track label: a muted symbol, then the name.
    void TrackLabel(Context cr, string symbol, string title, double baseline)
    {
        cr.Save();
        Ink(cr, "8A8F98", "5C6068");
        cr.SelectFontFace(symbol == "Aa" ? "Sora" : "DejaVu Sans", FontSlant.Normal, FontWeight.Normal);
        cr.SetFontSize(symbol == "Aa" ? 10 : 12); cr.MoveTo(15, baseline); cr.ShowText(symbol);
        cr.Restore();
        Text(cr, title, 33, baseline, 64, true);
    }

    void Draw(Context cr, int width, int height)
    {
        plotWidth = Math.Max(1, width - Left - Right);
        Ink(cr, "171920", "FFFFFF"); cr.Paint();
        Ink(cr, "20232B", "EDE9E0"); cr.Rectangle(0, 0, 100, height); cr.Fill();
        var length = Length;
        for (var index = 0; index <= 6; index++)
        {
            var x = Left + plotWidth * index / 6;
            Ink(cr, "2C2F37", "E2DED4", 0.7); cr.LineWidth = 1; cr.MoveTo(x, 24); cr.LineTo(x, AudioY + AudioHeight); cr.Stroke();
            Text(cr, Format.Clock(length * index / 6), x - (index == 6 ? 39 : 0), 18, 50, true, true);
        }
        TrackLabel(cr, "▣", "Video", VideoY + 34);
        TrackLabel(cr, "◎", "Focus L↕R", FocusY + 18);
        TrackLabel(cr, "Aa", "Text", TextY + 20);
        TrackLabel(cr, "∿", "Audio", AudioY + 22);
        DrawVideo(cr, length);
        DrawFocus(cr, length);
        DrawText(cr, length);
        DrawAudio(cr);
        var time = session.Player?.CurrentTime ?? 0;
        var playhead = Left + plotWidth * Math.Clamp(double.IsFinite(time) ? time / length : 0, 0, 1);
        Ink(cr, "F6F3EC", "0E0F14"); cr.LineWidth = 1;
        cr.MoveTo(playhead, 27); cr.LineTo(playhead, AudioY + AudioHeight); cr.Stroke();
        cr.MoveTo(playhead - 4, 22); cr.LineTo(playhead + 4, 22); cr.LineTo(playhead, 28); cr.ClosePath(); cr.Fill();
    }

    void DrawVideo(Context cr, double length)
    {
        Ink(cr, "20232B", "EDE9E0"); Rounded(cr, Left, VideoY, plotWidth, VideoHeight, 8); cr.Fill();
        cr.Save(); Rounded(cr, Left, VideoY, plotWidth, VideoHeight, 8); cr.Clip();
        for (var index = 0; index < frames.Count; index++)
        {
            var image = frames[index]; var cell = plotWidth / frames.Count;
            var scale = Math.Max(cell / image.Width, VideoHeight / image.Height);
            cr.Save(); cr.Rectangle(Left + index * cell, VideoY, cell, VideoHeight); cr.Clip();
            cr.Translate(Left + index * cell + (cell - image.Width * scale) / 2, VideoY + (VideoHeight - image.Height * scale) / 2);
            cr.Scale(scale, scale); cr.SetSourceSurface(image, 0, 0); cr.PaintWithAlpha(0.82); cr.Restore();
        }
        if (Media is { } media && session.ActiveSegment is null)
        {
            foreach (var clip in session.Project?.Segments.Where(s => s.MediaId == media.Id) ?? [])
            {
                var x = Left + plotWidth * clip.Start / length;
                var w = Math.Max(6, plotWidth * clip.Duration / length);
                Ink(cr, "3FA9F5", "0B6CB5", 0.3); Rounded(cr, x, VideoY + 1, w, VideoHeight - 2); cr.FillPreserve();
                Ink(cr, "3FA9F5", "0B6CB5"); cr.LineWidth = 2; cr.Stroke();
                if (w > 40) Text(cr, clip.SuggestedTitle ?? "Short", x + 5, VideoY + VideoHeight - 9, w - 10);
            }
        }
        if (Media is { } source)
        {
            // The source badge is as wide as the name, with light text on its dark backing.
            cr.SelectFontFace("Sora", FontSlant.Normal, FontWeight.Bold);
            cr.SetFontSize(11);
            var badge = Math.Max(1, Math.Min(plotWidth - 12, source.Name.Length * 6.6 + 12));
            cr.SetSourceRgba(0, 0, 0, 0.55); Rounded(cr, Left + 6, VideoY + 6, badge, 22, 3); cr.Fill();
            cr.Save(); cr.Rectangle(Left + 6, VideoY + 6, badge, 22); cr.Clip();
            cr.SetSourceRgb(0.965, 0.953, 0.925); cr.MoveTo(Left + 12, VideoY + 21); cr.ShowText(source.Name);
            cr.Restore();
        }
        else Text(cr, "Add a video to start your timeline", Left + 12, VideoY + 34, plotWidth - 24, true);
        cr.Restore();
        if (session.ActiveSegment is not null) { Ink(cr, "3FA9F5", "0B6CB5"); cr.LineWidth = 2; Rounded(cr, Left, VideoY, plotWidth, VideoHeight, 8); cr.Stroke(); }
    }

    void DrawFocus(Context cr, double length)
    {
        Ink(cr, "3FA9F5", "0B6CB5", 0.07); Rounded(cr, Left, FocusY, plotWidth, FocusHeight); cr.Fill();
        var clip = session.ActiveSegment;
        if (clip?.SplitScreen == true) { Text(cr, "Split screen · each half stays on its speaker", Left + 8, FocusY + 18, plotWidth - 16, true); return; }
        var points = clip?.CropKeyframes?.OrderBy(p => p.Time).ToList() ?? [];
        var offset = (clip?.CropPosition ?? 0.5) - 0.5;
        double X(double time) => Left + plotWidth * Math.Clamp(time / length, 0, 1);
        double Y(double value) => FocusY + 3 + (1 - Math.Clamp(value + offset, 0, 1)) * (FocusHeight - 6);
        if (points.Count > 0)
        {
            Ink(cr, "3FA9F5", "0B6CB5"); cr.LineWidth = 2; cr.LineCap = LineCap.Round; cr.LineJoin = LineJoin.Round;
            if (points.Count == 1) { cr.MoveTo(Left, Y(points[0].Position)); cr.LineTo(Left + plotWidth, Y(points[0].Position)); }
            else for (var index = 0; index < points.Count; index++)
            {
                var point = points[index];
                if (index == 0 || point.IsSceneCut == true) cr.MoveTo(X(point.Time), Y(point.Position));
                else cr.LineTo(X(point.Time), Y(point.Position));
            }
            cr.Stroke();
            foreach (var point in points)
            {
                Ink(cr, point.PreserveWholeFrame == true ? "FFC233" : "F6F3EC", point.PreserveWholeFrame == true ? "8F5E00" : "0E0F14");
                if (point.PreserveWholeFrame == true) cr.Rectangle(X(point.Time) - 2.5, Y(point.Position) - 2.5, 5, 5);
                else cr.Arc(X(point.Time), Y(point.Position), point.IsSceneCut == true ? 3 : 2, 0, 2 * Math.PI);
                cr.Fill();
            }
        }
        else Text(cr, clip is null ? "Select a Short to view its focus path" : clip.FitToFrame == true ? "Fit · full source frame" : "Click or drag to set focus", Left + 8, FocusY + 18, plotWidth - 16, true);
        if (focusDrag)
        {
            Ink(cr, "FFC233", "8F5E00"); cr.Arc(Math.Clamp(dragX, Left, Left + plotWidth), Math.Clamp(dragY, FocusY + 2, FocusY + FocusHeight - 2), 4, 0, 2 * Math.PI); cr.Fill();
        }
    }

    void DrawText(Context cr, double length)
    {
        Ink(cr, "171920", "FFFFFF"); Rounded(cr, Left + 0.5, TextY + 0.5, plotWidth - 1, TextHeight - 1); cr.FillPreserve();
        Ink(cr, "2C2F37", "E2DED4"); cr.LineWidth = 1; cr.Stroke();
        if (session.ActiveSegment is not { } clip) { Text(cr, "Select a Short to edit text and subtitles", Left + 10, TextY + 20, plotWidth - 20, true); return; }
        if (!string.IsNullOrWhiteSpace(clip.Caption))
        {
            var start = Math.Clamp(clip.CaptionStart ?? 0, 0, length);
            var duration = Math.Clamp(clip.CaptionDuration ?? clip.Duration, 0, length - start);
            var x = Left + plotWidth * start / length; var width = Math.Max(1, plotWidth * duration / length);
            Ink(cr, "FFC233", "8F5E00", 0.32); Rounded(cr, x, TextY, width, TextHeight); cr.Fill();
            Text(cr, clip.Caption, x + 8, TextY + 16, width - 16);
        }
        foreach (var cue in clip.Captions ?? [])
        {
            var start = Math.Clamp(cue.Start, 0, length); var duration = Math.Clamp(cue.Duration, 0, length - start);
            Ink(cr, "3FA9F5", "0B6CB5", 0.8); Rounded(cr, Left + plotWidth * start / length, TextY + 21, Math.Max(2, plotWidth * duration / length), 7, 2); cr.Fill();
        }
        if (string.IsNullOrWhiteSpace(clip.Caption) && clip.Captions?.Count is not > 0)
            Text(cr, "No text or subtitles", Left + 10, TextY + 20, plotWidth - 20, true);
    }

    void DrawAudio(Context cr)
    {
        var enabled = Media?.HasAudio == true && session.ActiveSegment?.IsMuted != true;
        Ink(cr, enabled ? "3FA9F5" : "0E0F14", enabled ? "0B6CB5" : "EDE9E0", enabled ? 0.16 : 1);
        Rounded(cr, Left, AudioY, plotWidth, AudioHeight); cr.Fill();
        if (enabled && waveform is { Length: > 0 } levels)
        {
            var peak = Math.Max(0.001, levels.Max());
            Ink(cr, "3FA9F5", "0B6CB5", 0.65); cr.LineWidth = 1;
            var count = Math.Max(1, (int)(plotWidth / 3));
            for (var index = 0; index < count; index++)
            {
                var first = index * levels.Length / count;
                var last = Math.Max(first + 1, (index + 1) * levels.Length / count);
                var value = 0f;
                for (var i = first; i < Math.Min(last, levels.Length); i++) value = Math.Max(value, levels[i]);
                var amplitude = Math.Sqrt(value / peak) * (AudioHeight / 2 - 3);
                var x = Left + index * plotWidth / count;
                cr.MoveTo(x, AudioY + AudioHeight / 2 - amplitude); cr.LineTo(x, AudioY + AudioHeight / 2 + amplitude);
            }
            cr.Stroke();
        }
        var label = session.ActiveSegment?.IsMuted == true ? "Muted" : Media?.HasAudio == true ? loadingWaveform ? "Source audio · loading waveform…" : "Source audio" : "No audio";
        Ink(cr, "171920", "FFFFFF", 0.85); Rounded(cr, Left + 6, AudioY + 7, Math.Max(1, Math.Min(plotWidth - 12, loadingWaveform ? 240 : 100)), 20, 3); cr.Fill();
        Text(cr, label, Left + 11, AudioY + 22, plotWidth - 22, true);
    }

    double TimeAt(double x) => Math.Clamp((x - Left) / plotWidth * Length, 0, Length);
    void BeginDrag(double x, double y)
    {
        dragActive = false;
        focusDrag = false;
        if (Blocked || x < Left || x > Left + plotWidth) return;
        dragActive = true;
        draggedShortId = session.PreviewShortId;
        dragStartX = dragX = x; dragStartY = dragY = y;
        focusDrag = y >= FocusY && y <= FocusY + FocusHeight && session.ActiveSegment is { SplitScreen: not true };
        if (!focusDrag && (y < VideoY || session.ActiveSegment is not null)) session.SeekPreview(TimeAt(x));
    }

    void MoveDrag(double offsetX, double offsetY)
    {
        if (Blocked || !dragActive) return;
        dragX = dragStartX + offsetX; dragY = dragStartY + offsetY;
        if (focusDrag) area.QueueDraw();
        else if (dragStartY < VideoY || session.ActiveSegment is not null) session.SeekPreview(TimeAt(dragX));
    }

    void EndDrag(double offsetX, double offsetY)
    {
        if (Blocked || !dragActive) { focusDrag = false; dragActive = false; return; }
        dragActive = false;
        dragX = dragStartX + offsetX; dragY = dragStartY + offsetY;
        if (focusDrag)
        {
            if (draggedShortId == session.PreviewShortId)
                session.AdjustCropKeyframe(TimeAt(dragStartX), TimeAt(dragX), Math.Clamp(1 - (dragY - FocusY) / FocusHeight, 0, 1), offsetX * offsetX + offsetY * offsetY <= 16);
            focusDrag = false;
        }
        else if (session.ActiveSegment is null && dragStartY >= VideoY && dragStartY <= VideoY + VideoHeight)
        {
            var time = TimeAt(dragStartX);
            var selected = session.Project?.Segments.LastOrDefault(s => s.MediaId == Media?.Id && time >= s.Start && time <= s.Start + s.Duration);
            if (selected is not null && offsetX * offsetX + offsetY * offsetY <= 16) session.SelectPreview(selected.Id);
            else session.SeekPreview(TimeAt(dragX));
        }
        else session.SeekPreview(TimeAt(dragX));
        area.QueueDraw();
    }

    void ReleaseFrames() { foreach (var frame in frames) frame.Dispose(); frames.Clear(); }

    public void Dispose()
    {
        if (disposed) return;
        disposed = true;
        session.PropertyChanged -= Changed;
        resources?.Cancel(); resources?.Dispose(); resources = null;
        area.RemoveTickCallback(tick);
        ReleaseFrames();
        waveforms.Clear();
    }
}
