using System.ComponentModel;
using System.Globalization;
using System.IO;
using System.Security.Cryptography;
using System.Text;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Media;
using System.Windows.Media.Imaging;
using System.Windows.Threading;
using Prism.Core;

namespace Prism.Windows;

/// Time tracks use source seconds when the source is open, and Short-relative seconds when a Short is open.
public sealed class WindowsTimeline : IDisposable
{
    sealed class TrackSurface(WindowsTimeline owner) : FrameworkElement
    {
        protected override void OnRender(DrawingContext drawingContext) => owner.Draw(drawingContext, ActualWidth, ActualHeight);
        protected override void OnMouseLeftButtonDown(MouseButtonEventArgs args)
        {
            base.OnMouseLeftButtonDown(args);
            if (owner.BeginDrag(args.GetPosition(this))) { CaptureMouse(); args.Handled = true; }
        }
        protected override void OnMouseMove(MouseEventArgs args)
        {
            base.OnMouseMove(args);
            if (owner.dragActive) { owner.MoveDrag(args.GetPosition(this)); args.Handled = true; }
        }
        protected override void OnMouseLeftButtonUp(MouseButtonEventArgs args)
        {
            base.OnMouseLeftButtonUp(args);
            if (!owner.dragActive) return;
            owner.EndDrag(args.GetPosition(this)); ReleaseMouseCapture(); args.Handled = true;
        }
        protected override void OnLostMouseCapture(MouseEventArgs args)
        {
            base.OnLostMouseCapture(args);
            owner.dragActive = owner.focusDrag = false;
            InvalidateVisual();
        }
    }

    readonly AppSession session;
    readonly Grid root = new();
    readonly TrackSurface surface;
    readonly Button undo = new() { Content = "\uE7A7", FontFamily = new FontFamily("Segoe Fluent Icons, Segoe MDL2 Assets"), ToolTip = "Undo edit · Ctrl+Z" };
    readonly Button redo = new() { Content = "\uE7A6", FontFamily = new FontFamily("Segoe Fluent Icons, Segoe MDL2 Assets"), ToolTip = "Redo edit · Ctrl+Shift+Z or Ctrl+Y" };
    readonly Button audio = new() { Content = "\uE767", FontFamily = new FontFamily("Segoe Fluent Icons, Segoe MDL2 Assets"), ToolTip = "Toggle clip audio" };
    readonly Button add = new() { Content = "Add clip" };
    readonly Button generate = new() { Content = "✦  Auto Shorts" };
    readonly Button settings = new() { Content = "\uE713", FontFamily = new FontFamily("Segoe Fluent Icons, Segoe MDL2 Assets"), ToolTip = "Auto Shorts settings" };
    readonly TextBlock title = new() { Text = "Source timeline", VerticalAlignment = VerticalAlignment.Center };
    readonly List<BitmapSource> frames = [];
    readonly Dictionary<string, float[]> waveforms = [];
    readonly DispatcherTimer timer;
    readonly FontFamily bodyFont = Font("Sora");
    readonly FontFamily monoFont = Font("JetBrains Mono");
    readonly FontFamily iconFont = new("Segoe Fluent Icons, Segoe MDL2 Assets");
    CancellationTokenSource? resources;
    string? resourceKey;
    float[]? waveform;
    bool loadingWaveform, disposed, dragActive, focusDrag;
    Point dragStart, dragPoint;
    Guid? draggedShortId;
    double plotWidth = 1;
    const double Left = 112, Right = 12;
    const double VideoY = 32, VideoHeight = 60, FocusY = 100, FocusHeight = 28;
    const double TextY = 136, TextHeight = 30, AudioY = 174, AudioHeight = 34;

    public FrameworkElement Widget => root;
    MediaItem? Media => session.Project?.Media.FirstOrDefault(m => m.Id == (session.ActiveSegment?.MediaId ?? session.Selection));
    double Length => Math.Max(0.1, session.ActiveSegment?.Duration ?? Media?.Duration ?? 1);
    bool Blocked => session.IsBusy || !session.Account.IsSignedIn || session.ExportChoice is not null
        || session.ExportSummary is not null || session.GenerationError is not null || session.PendingPaidRun is not null;
    bool Light => session.Settings.Appearance == "light";

    public WindowsTimeline(AppSession session)
    {
        this.session = session;
        surface = new TrackSurface(this)
        {
            MinHeight = 224, ClipToBounds = true, Focusable = false,
            ToolTip = "Click the ruler to seek. Click a Short to open it. Click to add a focus point or drag an existing point.",
        };
        root.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
        root.RowDefinitions.Add(new RowDefinition { Height = new GridLength(1, GridUnitType.Star) });
        var toolbar = new DockPanel { Margin = new Thickness(16, 0, 16, 0), Height = 42, LastChildFill = true };
        var leading = new StackPanel { Orientation = Orientation.Horizontal };
        var trailing = new StackPanel { Orientation = Orientation.Horizontal };
        foreach (var button in new[] { undo, redo, audio, add, generate, settings })
        { button.Margin = new Thickness(0, 0, 4, 0); button.BorderBrush = Brushes.Transparent; button.Padding = new Thickness(9, 5, 9, 5); button.FontSize = 12; button.VerticalAlignment = VerticalAlignment.Center; }
        var rule = new Border { Width = 1, Height = 16, Margin = new Thickness(10, 0, 14, 0), VerticalAlignment = VerticalAlignment.Center }; rule.SetResourceReference(Border.BackgroundProperty, "Line");
        title.FontSize = 11; title.FontWeight = FontWeights.Medium;
        leading.Children.Add(undo); leading.Children.Add(redo); leading.Children.Add(audio); leading.Children.Add(rule);
        trailing.Children.Add(add); trailing.Children.Add(generate); trailing.Children.Add(settings);
        DockPanel.SetDock(leading, Dock.Left); DockPanel.SetDock(trailing, Dock.Right);
        toolbar.Children.Add(leading); toolbar.Children.Add(trailing); toolbar.Children.Add(title);
        root.Children.Add(toolbar); Grid.SetRow(surface, 1); root.Children.Add(surface);
        // A failed action reports on the status line instead of taking the window down.
        void Safely(Action action) { try { action(); } catch (Exception error) { session.Message = error.Message; } }
        undo.Click += (_, _) => Safely(session.UndoFromEditor);
        redo.Click += (_, _) => Safely(session.RedoFromEditor);
        System.Windows.Automation.AutomationProperties.SetName(redo, "Redo edit");
        audio.Click += (_, _) => Safely(session.ToggleSelectedAudio);
        add.Click += (_, _) => Safely(session.AddManualClip);
        generate.Click += async (_, _) => { try { await session.MakeConfiguredShorts(); } catch (Exception error) { session.Message = error.Message; } };
        settings.Click += (_, _) => Safely(() => session.Screen = Screen.ImportSource);
        // Theme resources, so a dark/light switch repaints the toolbar at once.
        title.SetResourceReference(TextBlock.ForegroundProperty, "Ink");
        root.SetResourceReference(Panel.BackgroundProperty, "Surface1");
        timer = new DispatcherTimer(DispatcherPriority.Background, surface.Dispatcher) { Interval = TimeSpan.FromMilliseconds(100) };
        timer.Tick += Tick;
        timer.Start();
        session.PropertyChanged += Changed;
        Refresh();
    }

    static FontFamily Font(string name)
    {
        var folder = Path.Combine(AppContext.BaseDirectory, "Fonts") + Path.DirectorySeparatorChar;
        return Directory.Exists(folder) ? new FontFamily(new Uri(folder, UriKind.Absolute), "./#" + name) : new FontFamily(name + ", Segoe UI");
    }

    void Tick(object? sender, EventArgs args) { if (!disposed && root.IsVisible) surface.InvalidateVisual(); }
    void Changed(object? sender, PropertyChangedEventArgs args)
    {
        if (args.PropertyName is nameof(AppSession.Project) or nameof(AppSession.Selection) or nameof(AppSession.PreviewShortId)
            or nameof(AppSession.IsBusy) or nameof(AppSession.CanUndo) or nameof(AppSession.CanRedo) or nameof(AppSession.Account)
            or nameof(AppSession.ExportChoice) or nameof(AppSession.ExportSummary) or nameof(AppSession.GenerationError)) Refresh();
    }

    public void Refresh()
    {
        if (disposed) return;
        title.Text = session.ActiveSegment is null ? "Source timeline" : "Short timeline";
        title.FontFamily = bodyFont;
        undo.IsEnabled = session.CanUndo && !Blocked;
        redo.IsEnabled = session.CanRedo && !Blocked;
        audio.IsEnabled = session.ActiveSegment is not null && !Blocked;
        audio.Content = session.ActiveSegment?.IsMuted == true ? "\uE74F" : "\uE767";
        add.IsEnabled = generate.IsEnabled = Media is not null && !Blocked;
        settings.IsEnabled = !Blocked;
        var media = Media; var start = session.ActiveSegment?.Start ?? 0; var length = Length;
        var key = media is null ? "" : string.Create(CultureInfo.InvariantCulture, $"{media.Path}|{start:R}|{length:R}|{media.HasAudio}");
        if (resourceKey != key)
        {
            resourceKey = key;
            resources?.Cancel(); resources?.Dispose(); resources = new CancellationTokenSource();
            frames.Clear(); waveform = waveforms.GetValueOrDefault(key);
            loadingWaveform = media?.HasAudio == true && waveform is null;
            if (media is not null) _ = LoadResources(media.Path, start, length, loadingWaveform, key, resources);
        }
        surface.InvalidateVisual();
    }

    void OnUI(Action action)
    {
        if (disposed || surface.Dispatcher.HasShutdownStarted) return;
        if (surface.Dispatcher.CheckAccess()) action(); else surface.Dispatcher.BeginInvoke(action);
    }

    async Task LoadResources(string path, double start, double length, bool hasAudio, string key, CancellationTokenSource request)
    {
        var token = request.Token;
        bool Current() => !disposed && ReferenceEquals(resources, request) && !token.IsCancellationRequested;
        async Task LoadFrames()
        {
            try
            {
                var count = Math.Clamp((int)Math.Ceiling(length / 60), 1, 120);
                var directory = Path.Combine(Renderer.CacheDirectory, "Filmstrip"); Directory.CreateDirectory(directory);
                var stamp = File.Exists(path) ? new FileInfo(path).LastWriteTimeUtc.Ticks : 0;
                for (var index = 0; index < count; index++)
                {
                    token.ThrowIfCancellationRequested();
                    var time = start + Math.Min(length - 0.05, length * (index + 0.5) / count);
                    var identity = string.Create(CultureInfo.InvariantCulture, $"{path}|{stamp}|{time:R}");
                    var file = Path.Combine(directory, Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(identity)))[..32] + ".jpg");
                    byte[]? jpeg = File.Exists(file) ? await File.ReadAllBytesAsync(file, token).ConfigureAwait(false)
                        : await FFmpeg.FrameJpeg(path, Math.Max(0, time), 240, token).ConfigureAwait(false);
                    if (jpeg is null) continue;
                    if (!File.Exists(file))
                    {
                        var temporary = file + $".{Guid.NewGuid()}.tmp";
                        try
                        {
                            await File.WriteAllBytesAsync(temporary, jpeg, token).ConfigureAwait(false);
                            token.ThrowIfCancellationRequested(); File.Move(temporary, file, overwrite: true);
                        }
                        finally { try { File.Delete(temporary); } catch (IOException) { } }
                    }
                    var image = await Task.Run(() =>
                    {
                        using var stream = new MemoryStream(jpeg);
                        var bitmap = new BitmapImage(); bitmap.BeginInit(); bitmap.CacheOption = BitmapCacheOption.OnLoad;
                        bitmap.DecodePixelWidth = 240; bitmap.StreamSource = stream; bitmap.EndInit(); bitmap.Freeze();
                        return bitmap;
                    }, token).ConfigureAwait(false);
                    OnUI(() => { if (Current()) { frames.Add(image); surface.InvalidateVisual(); } });
                }
            }
            catch (OperationCanceledException) { }
            catch (Exception) { /* A missing filmstrip never prevents editing. */ }
        }
        async Task LoadWaveform()
        {
            if (!hasAudio) return;
            try
            {
                const int bars = 1600;
                var levels = new float[bars];
                // Bound PCM allocations for multi-hour sources by reading at most one minute at a time.
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
                    OnUI(() => { if (Current()) { waveform = snapshot; surface.InvalidateVisual(); } });
                }
                OnUI(() =>
                {
                    if (!Current()) return;
                    if (waveforms.Count >= 8) waveforms.Remove(waveforms.Keys.First());
                    waveforms[key] = levels;
                });
            }
            catch (OperationCanceledException) { }
            catch (Exception) { /* A missing waveform never prevents editing. */ }
            finally { OnUI(() => { if (Current()) { loadingWaveform = false; surface.InvalidateVisual(); } }); }
        }
        await Task.WhenAll(LoadFrames(), LoadWaveform()).ConfigureAwait(false);
    }

    SolidColorBrush Brush(string dark, string light, double opacity = 1)
    {
        var text = Light ? light : dark;
        var brush = new SolidColorBrush(Color.FromArgb((byte)(opacity * 255), Convert.ToByte(text[..2], 16), Convert.ToByte(text[2..4], 16), Convert.ToByte(text[4..], 16)));
        brush.Freeze(); return brush;
    }
    static Rect Rect(double x, double y, double width, double height) => new(x, y, Math.Max(0, width), Math.Max(0, height));
    void Text(DrawingContext dc, string value, double x, double y, double width, bool secondary = false, bool mono = false, double size = 11)
    {
        if (width <= 0) return;
        var text = new FormattedText(value.Replace('\n', ' '), CultureInfo.CurrentCulture, FlowDirection.LeftToRight,
            new Typeface(mono ? monoFont : bodyFont, FontStyles.Normal, FontWeights.Normal, FontStretches.Normal), size,
            secondary ? Brush("8A8F98", "5C6068") : Brush("F6F3EC", "0E0F14"), VisualTreeHelper.GetDpi(surface).PixelsPerDip)
        { MaxTextWidth = Math.Max(1, width), MaxLineCount = 1, Trimming = TextTrimming.CharacterEllipsis };
        dc.DrawText(text, new Point(x, y));
    }
    /// A Mac-style track label: a muted icon, then the name.
    void TrackLabel(DrawingContext dc, string glyph, string title, double y)
    {
        var icon = new FormattedText(glyph, CultureInfo.CurrentCulture, FlowDirection.LeftToRight, new Typeface(iconFont, FontStyles.Normal, FontWeights.Normal, FontStretches.Normal), 11,
            Brush("8A8F98", "5C6068"), VisualTreeHelper.GetDpi(surface).PixelsPerDip);
        dc.DrawText(icon, new Point(15, y + 2)); Text(dc, title, 33, y, 64, true);
    }
    static Geometry Line(Point from, Point to)
    {
        var path = new StreamGeometry(); using (var context = path.Open()) { context.BeginFigure(from, false, false); context.LineTo(to, true, false); }
        path.Freeze(); return path;
    }
    void Draw(DrawingContext dc, double width, double height)
    {
        plotWidth = Math.Max(1, width - Left - Right);
        dc.DrawRectangle(Brush("171920", "FFFFFF"), null, Rect(0, 0, width, height));
        dc.DrawRectangle(Brush("20232B", "EDE9E0"), null, Rect(0, 0, 100, height));
        var length = Length;
        for (var index = 0; index <= 6; index++)
        {
            var x = Left + plotWidth * index / 6;
            dc.DrawLine(new Pen(Brush("2C2F37", "E2DED4", 0.7), 1), new Point(x, 24), new Point(x, AudioY + AudioHeight));
            if (session.ActiveSegment is not null || Media is not null) Text(dc, Format.Clock(length * index / 6), x - (index == 6 ? 39 : 0), 4, 50, true, true);
        }
        TrackLabel(dc, "\uE714", "Video", VideoY + 23); TrackLabel(dc, "\uE8B3", "Focus L↕R", FocusY + 7);
        TrackLabel(dc, "\uE8D2", "Text", TextY + 9); TrackLabel(dc, "\uE720", "Audio", AudioY + 11);
        DrawVideo(dc, length); DrawFocus(dc, length); DrawText(dc, length); DrawAudio(dc);
        var time = session.Player?.CurrentTime ?? 0;
        var xHead = Left + plotWidth * Math.Clamp(double.IsFinite(time) ? time / length : 0, 0, 1);
        var ink = Brush("F6F3EC", "0E0F14"); dc.DrawLine(new Pen(ink, 1), new Point(xHead, 27), new Point(xHead, AudioY + AudioHeight));
        var triangle = new StreamGeometry(); using (var path = triangle.Open())
        { path.BeginFigure(new Point(xHead - 4, 22), true, true); path.LineTo(new Point(xHead + 4, 22), true, false); path.LineTo(new Point(xHead, 28), true, false); }
        dc.DrawGeometry(ink, null, triangle);
    }
    void DrawVideo(DrawingContext dc, double length)
    {
        var track = Rect(Left, VideoY, plotWidth, VideoHeight);
        dc.DrawRoundedRectangle(Brush("20232B", "EDE9E0"), null, track, 8, 8);
        dc.PushClip(new RectangleGeometry(track, 7, 7));
        for (var index = 0; index < frames.Count; index++)
        {
            var frame = frames[index]; var cell = plotWidth / frames.Count;
            var scale = Math.Max(cell / frame.PixelWidth, VideoHeight / frame.PixelHeight);
            dc.PushClip(new RectangleGeometry(Rect(Left + index * cell, VideoY, cell, VideoHeight))); dc.PushOpacity(0.82);
            dc.DrawImage(frame, Rect(Left + index * cell + (cell - frame.PixelWidth * scale) / 2, VideoY + (VideoHeight - frame.PixelHeight * scale) / 2,
                frame.PixelWidth * scale, frame.PixelHeight * scale)); dc.Pop(); dc.Pop();
        }
        if (Media is { } media && session.ActiveSegment is null)
            foreach (var clip in session.Project?.Segments.Where(s => s.MediaId == media.Id) ?? [])
            {
                var x = Left + plotWidth * clip.Start / length; var width = Math.Max(6, plotWidth * clip.Duration / length);
                dc.DrawRoundedRectangle(Brush("3FA9F5", "0B6CB5", 0.3), new Pen(Brush("3FA9F5", "0B6CB5"), 2), Rect(x, VideoY + 1, width, VideoHeight - 2), 4, 4);
                if (width > 40) Text(dc, clip.SuggestedTitle ?? "Short", x + 5, VideoY + VideoHeight - 20, width - 10);
            }
        if (Media is { } source)
        {
            // The source badge always uses light text on its dark backing, and is as wide as the name.
            var name = new FormattedText(source.Name, CultureInfo.CurrentCulture, FlowDirection.LeftToRight, new Typeface(bodyFont, FontStyles.Normal, FontWeights.Medium, FontStretches.Normal), 11,
                Brushes.White, VisualTreeHelper.GetDpi(surface).PixelsPerDip) { MaxLineCount = 1, Trimming = TextTrimming.CharacterEllipsis, MaxTextWidth = Math.Max(1, plotWidth - 22) };
            var labelWidth = Math.Max(1, Math.Min(plotWidth - 12, name.Width + 10));
            dc.DrawRoundedRectangle(new SolidColorBrush(Color.FromArgb(140, 0, 0, 0)), null, Rect(Left + 6, VideoY + 6, labelWidth, 22), 3, 3);
            dc.PushClip(new RectangleGeometry(Rect(Left + 6, VideoY + 6, labelWidth, 22)));
            dc.DrawText(name, new Point(Left + 11, VideoY + 9)); dc.Pop();
        }
        else Text(dc, "Add a video to start your timeline", Left + 12, VideoY + 23, plotWidth - 24, true);
        dc.Pop();
        if (session.ActiveSegment is not null) dc.DrawRoundedRectangle(null, new Pen(Brush("3FA9F5", "0B6CB5"), 2), track, 7, 7);
    }
    void DrawFocus(DrawingContext dc, double length)
    {
        dc.DrawRoundedRectangle(Brush("3FA9F5", "0B6CB5", 0.07), null, Rect(Left, FocusY, plotWidth, FocusHeight), 4, 4);
        var clip = session.ActiveSegment;
        if (clip?.SplitScreen == true) { Text(dc, "Split screen · review the framing for each speaker", Left + 8, FocusY + 7, plotWidth - 16, true); return; }
        var points = clip?.CropKeyframes?.OrderBy(p => p.Time).ToList() ?? [];
        var offset = (clip?.CropPosition ?? 0.5) - 0.5;
        Point Position(CropKeyframe point) => new(Left + plotWidth * Math.Clamp(point.Time / length, 0, 1), FocusY + 3 + (1 - Math.Clamp(point.Position + offset, 0, 1)) * (FocusHeight - 6));
        var pen = new Pen(Brush("3FA9F5", "0B6CB5"), 2) { StartLineCap = PenLineCap.Round, EndLineCap = PenLineCap.Round, LineJoin = PenLineJoin.Round };
        if (points.Count == 1) dc.DrawLine(pen, new Point(Left, Position(points[0]).Y), new Point(Left + plotWidth, Position(points[0]).Y));
        else for (var index = 1; index < points.Count; index++)
            if (points[index].IsSceneCut != true) dc.DrawGeometry(null, pen, Line(Position(points[index - 1]), Position(points[index])));
        foreach (var point in points)
        {
            var position = Position(point); var color = point.PreserveWholeFrame == true ? Brush("FFC233", "8F5E00") : Brush("F6F3EC", "0E0F14");
            if (point.PreserveWholeFrame == true) dc.DrawRectangle(color, null, Rect(position.X - 2.5, position.Y - 2.5, 5, 5));
            else dc.DrawEllipse(color, null, position, point.IsSceneCut == true ? 3 : 2, point.IsSceneCut == true ? 3 : 2);
        }
        if (points.Count == 0) Text(dc, clip is null ? "Select a Short to view its focus path" : clip.FitToFrame == true ? "Fit · full source frame" : "Click or drag to set focus", Left + 8, FocusY + 7, plotWidth - 16, true);
        if (focusDrag) dc.DrawEllipse(Brush("FFC233", "8F5E00"), null,
            new Point(Math.Clamp(dragPoint.X, Left, Left + plotWidth), Math.Clamp(dragPoint.Y, FocusY + 2, FocusY + FocusHeight - 2)), 4, 4);
    }
    void DrawText(DrawingContext dc, double length)
    {
        dc.DrawRoundedRectangle(Brush("171920", "FFFFFF"), new Pen(Brush("2C2F37", "E2DED4"), 1), Rect(Left, TextY, plotWidth, TextHeight), 4, 4);
        if (session.ActiveSegment is not { } clip) { Text(dc, "Select a Short to edit text and subtitles", Left + 10, TextY + 9, plotWidth - 20, true); return; }
        if (!string.IsNullOrWhiteSpace(clip.Caption))
        {
            var start = Math.Clamp(clip.CaptionStart ?? 0, 0, length); var duration = Math.Clamp(clip.CaptionDuration ?? clip.Duration, 0, length - start);
            var x = Left + plotWidth * start / length; var width = Math.Max(1, plotWidth * duration / length);
            dc.DrawRoundedRectangle(Brush("FFC233", "8F5E00", 0.32), null, Rect(x, TextY, width, TextHeight), 4, 4);
            Text(dc, clip.Caption, x + 8, TextY + 3, width - 16);
        }
        foreach (var cue in clip.Captions ?? [])
        {
            var start = Math.Clamp(cue.Start, 0, length); var duration = Math.Clamp(cue.Duration, 0, length - start);
            dc.DrawRoundedRectangle(Brush("3FA9F5", "0B6CB5", 0.8), null, Rect(Left + plotWidth * start / length, TextY + 21, Math.Max(2, plotWidth * duration / length), 7), 2, 2);
        }
        if (string.IsNullOrWhiteSpace(clip.Caption) && clip.Captions?.Count is not > 0) Text(dc, "No text or subtitles", Left + 10, TextY + 9, plotWidth - 20, true);
    }
    void DrawAudio(DrawingContext dc)
    {
        var enabled = Media?.HasAudio == true && session.ActiveSegment?.IsMuted != true;
        dc.DrawRoundedRectangle(enabled ? Brush("3FA9F5", "0B6CB5", 0.16) : Brush("0E0F14", "EDE9E0"), null, Rect(Left, AudioY, plotWidth, AudioHeight), 4, 4);
        if (enabled && waveform is { Length: > 0 } levels)
        {
            var peak = Math.Max(0.001, levels.Max()); var count = Math.Max(1, (int)(plotWidth / 3)); var pen = new Pen(Brush("3FA9F5", "0B6CB5", 0.65), 1);
            for (var index = 0; index < count; index++)
            {
                var first = index * levels.Length / count; var last = Math.Max(first + 1, (index + 1) * levels.Length / count); var value = 0f;
                for (var i = first; i < Math.Min(last, levels.Length); i++) value = Math.Max(value, levels[i]);
                var amplitude = Math.Sqrt(value / peak) * (AudioHeight / 2 - 3); var x = Left + index * plotWidth / count;
                dc.DrawLine(pen, new Point(x, AudioY + AudioHeight / 2 - amplitude), new Point(x, AudioY + AudioHeight / 2 + amplitude));
            }
        }
        var label = session.ActiveSegment?.IsMuted == true ? "Muted" : Media?.HasAudio == true ? loadingWaveform ? "Source audio · loading waveform…" : "Source audio" : "No audio";
        dc.DrawRoundedRectangle(Brush("171920", "FFFFFF", 0.85), null, Rect(Left + 6, AudioY + 7, Math.Max(1, Math.Min(plotWidth - 12, loadingWaveform ? 240 : 100)), 20), 3, 3);
        Text(dc, label, Left + 11, AudioY + 10, plotWidth - 22, true);
    }

    double TimeAt(double x) => Math.Clamp((x - Left) / plotWidth * Length, 0, Length);
    bool BeginDrag(Point point)
    {
        dragActive = focusDrag = false;
        if (!root.IsEnabled || Blocked || point.X < Left || point.X > Left + plotWidth) return false;
        dragActive = true; draggedShortId = session.PreviewShortId; dragStart = dragPoint = point;
        focusDrag = point.Y >= FocusY && point.Y <= FocusY + FocusHeight && session.ActiveSegment is { SplitScreen: not true };
        if (!focusDrag && (point.Y < VideoY || session.ActiveSegment is not null)) session.SeekPreview(TimeAt(point.X));
        return true;
    }
    void MoveDrag(Point point)
    {
        if (!root.IsEnabled || Blocked || !dragActive) return;
        dragPoint = point;
        if (focusDrag) surface.InvalidateVisual();
        else if (dragStart.Y < VideoY || session.ActiveSegment is not null) session.SeekPreview(TimeAt(point.X));
    }
    void EndDrag(Point point)
    {
        if (!root.IsEnabled || Blocked || !dragActive) { dragActive = focusDrag = false; return; }
        dragActive = false; dragPoint = point; var moved = (dragPoint - dragStart).Length > 4;
        if (focusDrag)
        {
            if (draggedShortId == session.PreviewShortId) session.AdjustCropKeyframe(TimeAt(dragStart.X), TimeAt(point.X), Math.Clamp(1 - (point.Y - FocusY) / FocusHeight, 0, 1), !moved);
            focusDrag = false;
        }
        else if (session.ActiveSegment is null && dragStart.Y >= VideoY && dragStart.Y <= VideoY + VideoHeight)
        {
            var time = TimeAt(dragStart.X);
            var selected = session.Project?.Segments.LastOrDefault(s => s.MediaId == Media?.Id && time >= s.Start && time <= s.Start + s.Duration);
            if (selected is not null && !moved) session.SelectPreview(selected.Id); else session.SeekPreview(TimeAt(point.X));
        }
        else session.SeekPreview(TimeAt(point.X));
        surface.InvalidateVisual();
    }

    public void Dispose()
    {
        if (disposed) return;
        disposed = true; timer.Stop(); timer.Tick -= Tick;
        session.PropertyChanged -= Changed;
        resources?.Cancel(); resources?.Dispose(); resources = null;
        frames.Clear(); waveforms.Clear();
        if (surface.IsMouseCaptured) surface.ReleaseMouseCapture();
    }
}
