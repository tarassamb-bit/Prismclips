using System.Globalization;
using System.IO;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Controls.Primitives;
using System.Windows.Input;
using System.Windows.Media;
using System.Windows.Media.Imaging;
using System.Windows.Threading;
using Microsoft.Win32;
using Prism.Core;

namespace Prism.Windows;

/// <summary>A persistent native editor: only selection-dependent panels change; text entry and playback survive status updates.</summary>
public sealed class WindowsEditor : IDisposable
{
    readonly AppSession session;
    readonly Window window;
    readonly Grid root = new();
    readonly Grid panes = new();
    readonly StackPanel media = Column(), captions = Column();
    readonly TextBlock detail = Text("", 11, true);
    readonly MediaElement video = new() { LoadedBehavior = MediaState.Manual, UnloadedBehavior = MediaState.Manual, ScrubbingEnabled = true, Stretch = Stretch.Uniform };
    readonly TextBlock title = Text("Editor", 12), saved = Text("", 11, true), engine = Text("Prism AI cloud", 12, true), status = Text("", 12, true), playerTime = Text("00:00 / 00:00", 11, true), sourceName = Text("Source video", 12, true);
    readonly TextBlock playerNotice = Text("Your video goes here", 13, false), ratio = Text("Original", 11, true), noticeIcon = Glyph("\uE714", 36);
    readonly StackPanel notice = new();
    readonly Border leftPanel, rightPanel;
    readonly Button noticeAction;
    readonly TextBlock playGlyph, expandGlyph;
    readonly Button play, expand, export;
    readonly Slider seek = new() { Minimum = 0, Maximum = 1, SmallChange = 0.1, LargeChange = 5, VerticalAlignment = VerticalAlignment.Center, MinWidth = 80 };
    readonly WindowsTimeline timeline;
    readonly PreviewPlayer player;
    readonly DispatcherTimer ticker = new() { Interval = TimeSpan.FromMilliseconds(100) };
    readonly Dictionary<string, byte[]> thumbnails = [];
    readonly Dictionary<CaptionStyle, byte[]> stylePreviews = [];
    readonly HashSet<string> loadingThumbnails = [];
    readonly GridSplitter leftSplitter, rightSplitter, timelineSplitter;
    string? mediaSignature, captionSignature;
    string? loadedPath, loadedIdentity;
    double pendingSeek;
    bool resumePlayback, previewSuspended, updatingSeek, disposed, expanded, noticeRetry;
    Button? saveCaptions;

    public UIElement Widget => root;
    /// <summary>What each step of the editor tour highlights.</summary>
    public Dictionary<FirstRunTutorial.Step, FrameworkElement> TutorialTargets { get; }
    public event Action<string>? Error;

    public WindowsEditor(AppSession session, Window window)
    {
        this.session = session; this.window = window;
        player = new PreviewPlayer(video, ClearPlayback); session.Player = player;
        root.SetResourceReference(System.Windows.Controls.Panel.BackgroundProperty, "Surface0");
        root.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
        root.RowDefinitions.Add(new RowDefinition { Height = new GridLength(1, GridUnitType.Star), MinHeight = 180 });
        root.RowDefinitions.Add(new RowDefinition { Height = new GridLength(5) });
        root.RowDefinitions.Add(new RowDefinition { Height = new GridLength(session.Settings.TimelineHeight), MinHeight = 150 });
        root.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
        // The right margin leaves room for the window's minimize, maximize and close buttons.
        var header = new DockPanel { Margin = new Thickness(20, 0, 152, 0), Height = 54, LastChildFill = true };
        var home = Button("‹  Home", () => { player.Pause(); session.Screen = Screen.Home; }); Plain(home); home.ToolTip = "Back to projects"; DockPanel.SetDock(home, Dock.Left); header.Children.Add(home);
        var rule = new Border { Width = 1, Height = 20, Margin = new Thickness(10, 0, 16, 0) }; rule.SetResourceReference(Border.BackgroundProperty, "Line"); DockPanel.SetDock(rule, Dock.Left); header.Children.Add(rule);
        var actions = Row(); actions.VerticalAlignment = VerticalAlignment.Center; DockPanel.SetDock(actions, Dock.Right);
        saved.Margin = new Thickness(0, 0, 16, 0); actions.Children.Add(saved);
        engine.Margin = new Thickness(0, 0, 12, 0); actions.Children.Add(engine);
        var appearance = ((PrismWindow)window).AppearanceSwitch(); appearance.Margin = new Thickness(8, 0, 6, 0); actions.Children.Add(appearance);
        export = Button("Export", () => session.ChooseExport(), primary: true); export.Padding = new Thickness(18, 8, 18, 8); export.Margin = new Thickness(6, 0, 0, 0);
        export.ToolTip = "Choose which Shorts, the main video and the quality to export · Ctrl+E"; actions.Children.Add(export); header.Children.Add(actions);
        title.FontWeight = FontWeights.Medium; title.TextWrapping = TextWrapping.NoWrap; title.TextTrimming = TextTrimming.CharacterEllipsis; title.Margin = new Thickness(0, 0, 0, 2);
        var heading = new StackPanel { VerticalAlignment = VerticalAlignment.Center }; heading.Children.Add(title); heading.Children.Add(detail); header.Children.Add(heading);
        var bar = new Border { Child = header, BorderThickness = new Thickness(0, 0, 0, 1) }; bar.SetResourceReference(Border.BackgroundProperty, "Surface1"); bar.SetResourceReference(Border.BorderBrushProperty, "Line");
        bar.MouseLeftButtonDown += (_, args) => ((PrismWindow)window).DragFrom(args);
        Add(root, bar, 0);

        panes.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(session.Settings.LeftSidebarWidth), MinWidth = 200 });
        panes.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(5) });
        panes.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star), MinWidth = 200 });
        panes.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(5) });
        panes.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(session.Settings.RightSidebarWidth), MinWidth = 220 });
        var library = Column(); library.Children.Add(media);
        var autoSettings = Button("Auto Shorts settings", () => session.Screen = Screen.ImportSource); Plain(autoSettings);
        autoSettings.HorizontalAlignment = HorizontalAlignment.Stretch; autoSettings.Padding = new Thickness(14); autoSettings.FontSize = 11;
        var autoBar = new Border { Child = autoSettings, BorderThickness = new Thickness(0, 1, 0, 0) }; autoBar.SetResourceReference(Border.BorderBrushProperty, "Line");
        var left = new DockPanel(); DockPanel.SetDock(autoBar, Dock.Bottom); left.Children.Add(autoBar); left.Children.Add(Scroll(library));
        left.AllowDrop = true;
        left.DragOver += (_, args) => { args.Effects = !session.IsBusy && args.Data.GetDataPresent(DataFormats.FileDrop) ? DragDropEffects.Copy : DragDropEffects.None; args.Handled = true; };
        left.Drop += async (_, args) =>
        {
            args.Handled = true;
            if (!session.IsBusy && args.Data.GetData(DataFormats.FileDrop) is string[] paths && paths.FirstOrDefault() is { } path)
                await Safe(() => session.ImportSource(path));
        };
        leftPanel = Panel(left, new Thickness(0, 0, 1, 0)); Add(panes, leftPanel, 0, 0); leftSplitter = Splitter(); Add(panes, leftSplitter, 0, 1);

        var viewer = new Grid();
        viewer.RowDefinitions.Add(new RowDefinition { Height = new GridLength(40) }); viewer.RowDefinitions.Add(new RowDefinition { Height = new GridLength(1, GridUnitType.Star) }); viewer.RowDefinitions.Add(new RowDefinition { Height = new GridLength(44) });
        var viewerHead = new DockPanel { Margin = new Thickness(16, 0, 10, 0) };
        var original = IconButton("", "Preview original source", () => session.SelectPreview(null)); DockPanel.SetDock(original, Dock.Right); viewerHead.Children.Add(original);
        ratio.Margin = new Thickness(10, 0, 6, 0); DockPanel.SetDock(ratio, Dock.Right); viewerHead.Children.Add(ratio);
        sourceName.FontWeight = FontWeights.Medium; sourceName.TextWrapping = TextWrapping.NoWrap; sourceName.TextTrimming = TextTrimming.CharacterEllipsis; sourceName.SetResourceReference(TextBlock.ForegroundProperty, "Ink");
        viewerHead.Children.Add(sourceName); Add(viewer, viewerHead, 0);
        var picture = new Grid { Background = Brushes.Black, MinHeight = 140, ClipToBounds = true, Margin = new Thickness(16, 0, 16, 0), Cursor = Cursors.Hand, ToolTip = "Click to play or pause · double-click to fill the window" };
        picture.Children.Add(video);
        picture.MouseLeftButtonDown += (_, args) => { if (session.PreviewPath is null) return; if (args.ClickCount == 2) session.IsPlayerExpanded = !session.IsPlayerExpanded; else session.TogglePlayback(); };
        noticeIcon.Foreground = Brushes.Gray; noticeIcon.Margin = new Thickness(0, 0, 0, 10);
        playerNotice.Foreground = new SolidColorBrush(Color.FromRgb(246, 243, 236)); playerNotice.TextAlignment = TextAlignment.Center; playerNotice.MaxWidth = 360;
        noticeAction = NewButton("Import video", false); noticeAction.Margin = new Thickness(0, 12, 0, 0); noticeAction.HorizontalAlignment = HorizontalAlignment.Center;
        noticeAction.Foreground = new SolidColorBrush(Color.FromRgb(246, 243, 236)); noticeAction.BorderBrush = new SolidColorBrush(Color.FromArgb(90, 255, 255, 255));
        notice.Children.Add(noticeIcon); notice.Children.Add(playerNotice); notice.Children.Add(noticeAction);
        notice.HorizontalAlignment = HorizontalAlignment.Center; notice.VerticalAlignment = VerticalAlignment.Center; notice.Margin = new Thickness(24); picture.Children.Add(notice); Add(viewer, picture, 1);
        var controls = new Grid { Margin = new Thickness(18, 0, 14, 0) };
        foreach (var width in new[] { GridLength.Auto, GridLength.Auto, GridLength.Auto, new GridLength(1, GridUnitType.Star), GridLength.Auto, GridLength.Auto }) controls.ColumnDefinitions.Add(new ColumnDefinition { Width = width });
        playerTime.SetResourceReference(TextBlock.FontFamilyProperty, "MonoFont"); playerTime.Margin = new Thickness(0, 0, 12, 0); Add(controls, playerTime, 0, 0);
        Add(controls, IconButton("", "Go to start · ← → to step, Shift for 5 s", () => session.SeekPreview(0)), 0, 1);
        play = IconButton("", "Play or pause · Space", session.TogglePlayback); playGlyph = (TextBlock)play.Content; Add(controls, play, 0, 2);
        seek.Margin = new Thickness(10, 0, 10, 0); seek.ValueChanged += (_, _) => { if (!updatingSeek) session.SeekPreview(seek.Value); }; Add(controls, seek, 0, 3);
        var fps = Text("30 fps", 11, true); fps.SetResourceReference(TextBlock.FontFamilyProperty, "MonoFont"); fps.Margin = new Thickness(0, 0, 8, 0); Add(controls, fps, 0, 4);
        expand = IconButton("", "Fill the window · press Esc to exit", () => session.IsPlayerExpanded = !session.IsPlayerExpanded); expandGlyph = (TextBlock)expand.Content; Add(controls, expand, 0, 5);
        Add(viewer, controls, 2);
        Add(panes, viewer, 0, 2); rightSplitter = Splitter(); Add(panes, rightSplitter, 0, 3);

        var captionPanel = new DockPanel();
        var captionTitle = Text("Captions", 12); captionTitle.FontWeight = FontWeights.Medium;
        var captionHeading = new Border { Child = captionTitle, Height = 40, Padding = new Thickness(16, 0, 16, 0), BorderThickness = new Thickness(0, 0, 0, 1) };
        captionHeading.SetResourceReference(Border.BorderBrushProperty, "Line");
        DockPanel.SetDock(captionHeading, Dock.Top); captionPanel.Children.Add(captionHeading);
        captionPanel.Children.Add(Scroll(captions));
        rightPanel = Panel(captionPanel, new Thickness(1, 0, 0, 0)); Add(panes, rightPanel, 0, 4); Add(root, panes, 1);
        timelineSplitter = new GridSplitter { Height = 5, HorizontalAlignment = HorizontalAlignment.Stretch, VerticalAlignment = VerticalAlignment.Stretch, ResizeDirection = GridResizeDirection.Rows, ResizeBehavior = GridResizeBehavior.PreviousAndNext, ShowsPreview = true, Background = Brushes.Transparent, Cursor = Cursors.SizeNS };
        Add(root, timelineSplitter, 2);
        timeline = new WindowsTimeline(session); var timelinePanel = Panel(timeline.Widget, new Thickness(0, 1, 0, 0)); Add(root, timelinePanel, 3);
        TutorialTargets = new() { [FirstRunTutorial.Step.Shorts] = leftPanel, [FirstRunTutorial.Step.Preview] = viewer, [FirstRunTutorial.Step.Editing] = rightPanel,
            [FirstRunTutorial.Step.Timeline] = timelinePanel, [FirstRunTutorial.Step.Export] = export };
        var footer = new DockPanel { Height = 28, Margin = new Thickness(16, 0, 16, 0) };
        var format = Text("Shorts export at 1080 × 1920 · MP4", 11, true); format.SetResourceReference(TextBlock.FontFamilyProperty, "MonoFont"); DockPanel.SetDock(format, Dock.Right); footer.Children.Add(format);
        status.FontSize = 11; status.TextWrapping = TextWrapping.NoWrap; status.TextTrimming = TextTrimming.CharacterEllipsis; status.SetResourceReference(TextBlock.ForegroundProperty, "Ink"); footer.Children.Add(status);
        Add(root, Panel(footer, new Thickness(0, 1, 0, 0)), 4);
        noticeAction.Click += async (_, _) => { if (noticeRetry) session.SelectPreview(session.PreviewShortId); else await Safe(ImportVideo); };
        leftSplitter.DragCompleted += (_, _) => SavePaneSizes(); rightSplitter.DragCompleted += (_, _) => SavePaneSizes(); timelineSplitter.DragCompleted += (_, _) => SavePaneSizes();
        video.MediaOpened += MediaOpened; video.MediaEnded += (_, _) => player.Pause();
        video.MediaFailed += (_, args) => { player.Pause(); SignalError("Could not play this video: " + args.ErrorException.Message); };
        window.PreviewKeyDown += OnKeyDown; ticker.Tick += Tick; ticker.Start(); Refresh();
    }

    public void Refresh()
    {
        if (disposed) return;
        if (session.Screen != Screen.Editor) { player.Pause(); return; }
        if (!ReferenceEquals(session.Player, player)) session.Player = player;
        title.Text = session.Project?.DisplayTitle ?? "Editor"; saved.Text = session.LastSavedAt is { } time ? "✓ Saved " + time.ToString("t", CultureInfo.CurrentCulture) : "";
        saved.ToolTip = "Prism saves every change to this project automatically";
        status.Text = session.Message;
        var count = session.Project?.Segments.Count ?? 0;
        detail.Text = count == 0 ? "No Shorts yet" : count == 1 ? "1 Short" : $"{count} Shorts";
        if (session.Project?.Media.FirstOrDefault(m => m.Kind == "video") is { } source) detail.Text += $" · from a {Format.Clock(source.Duration)} video";
        engine.Text = session.GenerationStage; engine.Visibility = session.IsBusy ? Visibility.Visible : Visibility.Collapsed;
        export.IsEnabled = session.Project?.Media.Count > 0 && !session.IsBusy;
        play.IsEnabled = seek.IsEnabled = session.PreviewPath is not null && !session.IsPreviewLoading;
        var number = session.ActiveSegment is { } active ? (session.Project?.Segments.FindIndex(s => s.Id == active.Id) ?? 0) + 1 : 0;
        sourceName.Text = session.ActiveSegment is null ? "Source video" : string.IsNullOrEmpty(session.ActiveSegment.SuggestedTitle) ? $"Short {number} preview" : $"Short {number} · {session.ActiveSegment.SuggestedTitle}";
        ratio.Text = session.ActiveSegment is null ? "Original" : "Vertical · 9:16";
        expandGlyph.Text = session.IsPlayerExpanded ? "\uE73F" : "\uE740";
        if (expanded != session.IsPlayerExpanded)
        {
            expanded = session.IsPlayerExpanded;
            if (expanded) SavePaneSizes();
            leftPanel.Visibility = rightPanel.Visibility = leftSplitter.Visibility = rightSplitter.Visibility = timelineSplitter.Visibility = timeline.Widget.Visibility = expanded ? Visibility.Collapsed : Visibility.Visible;
            panes.ColumnDefinitions[0].MinWidth = expanded ? 0 : 200; panes.ColumnDefinitions[4].MinWidth = expanded ? 0 : 220;
            panes.ColumnDefinitions[0].Width = new GridLength(expanded ? 0 : session.Settings.LeftSidebarWidth);
            panes.ColumnDefinitions[4].Width = new GridLength(expanded ? 0 : session.Settings.RightSidebarWidth);
            panes.ColumnDefinitions[1].Width = panes.ColumnDefinitions[3].Width = new GridLength(expanded ? 0 : 5);
            root.RowDefinitions[3].MinHeight = expanded ? 0 : 150; root.RowDefinitions[2].Height = new GridLength(expanded ? 0 : 5); root.RowDefinitions[3].Height = new GridLength(expanded ? 0 : session.Settings.TimelineHeight);
        }
        SyncPlayer();
        var signature = session.Project is null ? "" : session.Project.Id + "|" + string.Join("|", session.Project.Media.Select(m => $"{m.Id}:{m.Thumbnail}:{m.Path}"))
            + string.Join("|", session.Project.Segments.Select(s => $"{s.Id}:{s.Start}:{s.Duration}:{s.SuggestedTitle}:{s.Score}")) + session.PreviewShortId + "|" + session.Selection + "|" + session.IsBusy;
        if (signature != mediaSignature) { mediaSignature = signature; BuildMedia(); }
        var selected = session.ActiveSegment; var clipSignature = (selected is null ? "source" : PrismJson.Serialize(selected)) + "|" + session.TimingShortIds.Count;
        if (captionSignature != clipSignature && !TextEditingInside(captions)) { captionSignature = clipSignature; BuildCaptions(); }
        timeline.Refresh();
    }

    void SyncPlayer()
    {
        var identity = session.PreviewShortId?.ToString() ?? "source:" + session.Selection;
        if (session.PreviewPath is null)
        {
            if (loadedPath is not null && !previewSuspended)
            {
                pendingSeek = loadedIdentity == identity ? player.CurrentTime : 0; resumePlayback = loadedIdentity == identity && player.IsPlaying;
                player.Pause(); previewSuspended = true;
            }
            notice.Visibility = Visibility.Visible;
            var failed = !session.IsPreviewLoading && session.PreviewError is not null;
            playerNotice.Text = session.IsPreviewLoading ? "Rendering preview…" : session.PreviewError ?? "Your video goes here";
            noticeIcon.Text = session.IsPreviewLoading ? "\uE916" : failed ? "\uE7BA" : "\uE714";
            noticeIcon.Foreground = failed ? new SolidColorBrush(Color.FromRgb(255, 194, 51)) : Brushes.Gray;
            noticeAction.Visibility = session.IsPreviewLoading ? Visibility.Collapsed : Visibility.Visible;
            noticeAction.Content = failed ? "Retry preview" : "Import video"; noticeAction.IsEnabled = !session.IsBusy;
            noticeRetry = failed;
            return;
        }
        notice.Visibility = Visibility.Collapsed;
        var wasSuspended = previewSuspended; previewSuspended = false;
        if (loadedPath == session.PreviewPath) { if (wasSuspended) RestorePlayback(); return; }
        if (loadedIdentity != identity) { pendingSeek = 0; resumePlayback = false; }
        else if (!wasSuspended) { pendingSeek = player.CurrentTime; resumePlayback = player.IsPlaying; }
        player.Pause(); loadedIdentity = identity; loadedPath = session.PreviewPath;
        video.Source = new Uri(Path.GetFullPath(loadedPath)); seek.Maximum = Math.Max(0.01, session.PreviewLength);
        // Manual media must be opened to make paused scrubbing and MediaOpened reliable.
        video.Play(); video.Pause();
    }

    void ClearPlayback()
    {
        video.Close();
        loadedPath = loadedIdentity = null;
        pendingSeek = 0;
        resumePlayback = previewSuspended = false;
    }

    void MediaOpened(object? sender, RoutedEventArgs args)
    {
        try { RestorePlayback(); }
        catch (Exception error) { SignalError("Could not play this video: " + error.Message); }
    }
    void RestorePlayback()
    {
        player.Seek(Math.Clamp(pendingSeek, 0, Math.Max(0, session.PreviewLength)));
        if (resumePlayback) player.Play(); pendingSeek = 0; resumePlayback = false;
    }
    void Tick(object? sender, EventArgs args)
    {
        if (disposed || session.Screen != Screen.Editor) return;
        // While the slider is held, it shows where the person drags it, not where playback was a moment ago.
        if (!seek.IsMouseCaptureWithin) { updatingSeek = true; seek.Value = player.CurrentTime; updatingSeek = false; }
        playerTime.Text = Format.Clock(player.CurrentTime) + " / " + Format.Clock(session.PreviewLength);
        playGlyph.Text = player.IsPlaying ? "\uE769" : "\uE768";
    }

    Expander FoldingSection(UIElement heading, StackPanel content, bool expanded, Action<bool> save)
    {
        var section = new Expander { Header = heading, Content = content, IsExpanded = expanded, HorizontalAlignment = HorizontalAlignment.Stretch };
        section.Expanded += (_, _) => { save(true); session.Settings.Save(); };
        section.Collapsed += (_, _) => { save(false); session.Settings.Save(); };
        return section;
    }

    void BuildMedia()
    {
        media.Children.Clear(); media.Margin = new Thickness(6);
        var project = session.Project;
        if (project is { Segments.Count: > 0 })
        {
            var create = Link("Create more", "", () => _ = Safe(() => session.MakeConfiguredShorts())); create.ToolTip = "Analyze this video's unused moments for more Shorts"; create.IsEnabled = !session.IsBusy;
            var count = Text($"{project.Segments.Count}", 11, true); count.FontWeight = FontWeights.Medium; count.Margin = new Thickness(6, 0, 0, 0);
            var section = Column();
            var tools = Row();
            if (project.Segments.Any(clip => clip.Score is not null))
            {
                var sort = IconButton("\uE8CB", session.Settings.ShortsBestFirst ? "Show Shorts in video order" : "Show best Shorts first", () => { session.Settings.ShortsBestFirst = !session.Settings.ShortsBestFirst; session.Settings.Save(); BuildMedia(); });
                if (session.Settings.ShortsBestFirst) sort.SetResourceReference(Control.ForegroundProperty, "Accent");
                tools.Children.Add(sort);
            }
            tools.Children.Add(create);
            var fold = FoldingSection(Heading(Row(SectionLabel("Shorts"), count), tools), section, !session.Settings.ShortsCollapsed, value => session.Settings.ShortsCollapsed = !value);
            media.Children.Add(fold);
            var cards = new List<UIElement>();
            foreach (var (shortClip, index) in OrderedShorts(project)) cards.Add(ShortCard(project, shortClip, index + 1));
            section.Children.Add(PrismWindow.AdaptiveGrid(112, cards, 10));
            media.Children.Add(Rule());
        }
        var add = IconButton("", "Import video", () => _ = Safe(ImportVideo)); add.IsEnabled = !session.IsBusy;
        var main = Column();
        media.Children.Add(FoldingSection(Heading(SectionLabel("Main video"), add), main, !session.Settings.MainVideoCollapsed, value => session.Settings.MainVideoCollapsed = !value));
        var import = AsyncButton("Import", ImportVideo); import.HorizontalAlignment = HorizontalAlignment.Stretch; import.SetResourceReference(Control.BackgroundProperty, "Surface2");
        import.BorderBrush = Brushes.Transparent; import.Padding = new Thickness(0, 9, 0, 9); import.Margin = new Thickness(0, 4, 0, 10); import.IsEnabled = !session.IsBusy;
        if (project is null || project.Media.Count == 0) main.Children.Add(import);
        if (project is null || project.Media.Count == 0) { var empty = Text("Import a video to begin editing.", 12, true); empty.Margin = new Thickness(0, 24, 0, 24); main.Children.Add(empty); return; }
        main.Children.Add(PrismWindow.AdaptiveGrid(112, project.Media.Select(item => (UIElement)MediaCard(item)), 10));
        var clip = Link("Add clip to timeline", "", session.AddManualClip); clip.IsEnabled = !session.IsBusy; main.Children.Add(clip);
    }

    UIElement ShortCard(ProjectData project, EditSegment clip, int number)
    {
        var selected = clip.Id == session.PreviewShortId;
        var image = new Image { Stretch = Stretch.UniformToFill };
        var source = project.Media.FirstOrDefault(m => m.Id == clip.MediaId);
        if (source is not null)
        {
            var at = Math.Min(Math.Max(0.1, clip.Start + clip.Duration * 0.45), Math.Max(0.1, source.Duration - 0.1));
            var key = source.Id + ":" + at.ToString("R", CultureInfo.InvariantCulture);
            if (thumbnails.TryGetValue(key, out var bytes)) image.Source = Bitmap(bytes);
            else if (source.Thumbnail is { } path && File.Exists(path)) image.Source = Picture(path).Source;
            if (!thumbnails.ContainsKey(key) && loadingThumbnails.Add(key)) _ = LoadThumbnail(key, source.Path, at, image);
        }
        var poster = new Grid { Height = 82, ClipToBounds = true }; poster.SetResourceReference(System.Windows.Controls.Panel.BackgroundProperty, "Surface2");
        poster.Children.Add(image);
        if (clip.Score is { } score)
        {
            var rating = new TextBlock { Text = score.ToString(CultureInfo.InvariantCulture), Foreground = Brushes.White, FontSize = 10, FontWeight = FontWeights.Medium };
            var badge = new Border { Child = rating, Background = new SolidColorBrush(Color.FromArgb(153, 0, 0, 0)), CornerRadius = new CornerRadius(10), Padding = new Thickness(6, 3, 6, 3), Margin = new Thickness(5), HorizontalAlignment = HorizontalAlignment.Left, VerticalAlignment = VerticalAlignment.Top, ToolTip = $"Prism AI score: {score} of 100" };
            System.Windows.Automation.AutomationProperties.SetName(badge, $"Prism AI score {score} of 100");
            System.Windows.Controls.Panel.SetZIndex(badge, 1); poster.Children.Add(badge);
        }
        poster.Children.Add(new Border { Background = new LinearGradientBrush(Colors.Transparent, Color.FromArgb(178, 0, 0, 0), 90) { StartPoint = new Point(0, 0.5), EndPoint = new Point(0, 1) } });
        var label = new DockPanel { VerticalAlignment = VerticalAlignment.Bottom, Margin = new Thickness(5) };
        var white = new SolidColorBrush(Color.FromRgb(246, 243, 236));
        var length = new TextBlock { Text = Format.Clock(clip.Duration), Foreground = white, FontSize = 11, FontWeight = FontWeights.Medium }; DockPanel.SetDock(length, Dock.Right); label.Children.Add(length);
        var name = new StackPanel { Orientation = Orientation.Horizontal };
        name.Children.Add(Glyph("", 9, white)); name.Children.Add(new TextBlock { Text = $" Short {number}", Foreground = white, FontSize = 11, FontWeight = FontWeights.Medium });
        if (clip.SplitScreen == true) { var split = Glyph("", 10, white); split.Margin = new Thickness(4, 0, 0, 0); split.ToolTip = "Split screen"; name.Children.Add(split); }
        if (clip.SelectionReason?.StartsWith("Weaker pick", StringComparison.Ordinal) == true)
        { var weak = Glyph("", 10, new SolidColorBrush(Color.FromRgb(255, 194, 51))); weak.Margin = new Thickness(4, 0, 0, 0); weak.ToolTip = "Weaker pick: check this one before exporting"; name.Children.Add(weak); }
        label.Children.Add(name); poster.Children.Add(label);
        poster.SizeChanged += (_, args) => poster.Clip = new RectangleGeometry(new Rect(args.NewSize), 4, 4);
        var body = new StackPanel(); body.Children.Add(poster);
        if (!string.IsNullOrEmpty(clip.SuggestedTitle)) { var title = Text(clip.SuggestedTitle, 11); title.FontWeight = FontWeights.Medium; title.MaxHeight = 30; title.TextTrimming = TextTrimming.CharacterEllipsis; title.Margin = new Thickness(0, 5, 0, 0); body.Children.Add(title); }
        var starts = Text("Starts at " + Format.Clock(clip.Start), 11, true); starts.TextWrapping = TextWrapping.NoWrap; starts.Margin = new Thickness(0, 3, 0, 0); body.Children.Add(starts);
        var card = Button("", () => { session.Selection = clip.MediaId; session.SelectPreview(clip.Id); });
        card.SetResourceReference(FrameworkElement.StyleProperty, "Tile"); card.Content = body; card.Padding = new Thickness(5); card.Margin = new Thickness(0); card.HorizontalAlignment = HorizontalAlignment.Stretch;
        card.SetResourceReference(Control.BackgroundProperty, selected ? "AccentWash" : "Surface2");
        if (selected) card.SetResourceReference(Control.BorderBrushProperty, "Accent"); else card.BorderBrush = Brushes.Transparent;
        System.Windows.Automation.AutomationProperties.SetName(card, $"Preview Short {number}"); card.ToolTip = "Right-click for more";
        var menu = new ContextMenu();
        foreach (var (header, action) in new (string, Action)[] { ("Preview", () => { session.Selection = clip.MediaId; session.SelectPreview(clip.Id); }), ("Export this Short…", () => session.ChooseExport(clip.Id)), ("Remove Short", () => session.RemoveShort(clip.Id)) })
        { var item = new MenuItem { Header = header }; item.Click += (_, _) => { try { action(); } catch (Exception error) { SignalError(error.Message); } }; menu.Items.Add(item); }
        card.ContextMenu = menu;
        var remove = new Button { Content = Glyph("", 9, white), Width = 22, Height = 22, Padding = new Thickness(0), BorderThickness = new Thickness(0), Background = new SolidColorBrush(Color.FromArgb(199, 0, 0, 0)),
            HorizontalAlignment = HorizontalAlignment.Right, VerticalAlignment = VerticalAlignment.Top, Margin = new Thickness(9), ToolTip = "Remove Short · Undo available", IsEnabled = !session.IsBusy };
        remove.Template = RoundTemplate();
        System.Windows.Automation.AutomationProperties.SetName(remove, $"Remove Short {number}");
        remove.Click += (_, _) => { try { session.RemoveShort(clip.Id); } catch (Exception error) { SignalError(error.Message); } };
        var host = new Grid(); host.Children.Add(card); host.Children.Add(remove);
        return host;
    }

    Button MediaCard(MediaItem item)
    {
        var selected = session.PreviewShortId is null && session.Selection == item.Id;
        var poster = new Grid { Height = 70, ClipToBounds = true }; poster.SetResourceReference(System.Windows.Controls.Panel.BackgroundProperty, "Surface1");
        if (item.Thumbnail is { } path && File.Exists(path)) { var image = Picture(path); image.Height = double.NaN; image.Margin = new Thickness(0); poster.Children.Add(image); }
        else poster.Children.Add(Glyph("", 16, null, true));
        var clock = new TextBlock { Text = Format.Clock(item.Duration), FontSize = 11, Foreground = new SolidColorBrush(Color.FromRgb(246, 243, 236)) }; clock.SetResourceReference(TextBlock.FontFamilyProperty, "MonoFont");
        poster.Children.Add(new Border { Child = clock, Background = new SolidColorBrush(Color.FromArgb(204, 0, 0, 0)), CornerRadius = new CornerRadius(3), Padding = new Thickness(4, 2, 4, 2), Margin = new Thickness(4), HorizontalAlignment = HorizontalAlignment.Right, VerticalAlignment = VerticalAlignment.Bottom });
        poster.SizeChanged += (_, args) => poster.Clip = new RectangleGeometry(new Rect(args.NewSize), 4, 4);
        var name = Text(item.Name, 11); name.TextWrapping = TextWrapping.NoWrap; name.TextTrimming = TextTrimming.CharacterEllipsis; name.Margin = new Thickness(0, 5, 0, 0);
        var size = Text($"{item.Width} × {item.Height}", 11, true); size.Margin = new Thickness(0, 2, 0, 0);
        var body = new StackPanel(); body.Children.Add(poster); body.Children.Add(name); body.Children.Add(size);
        var card = Button("", () => { session.Selection = item.Id; session.SelectPreview(null); });
        card.SetResourceReference(FrameworkElement.StyleProperty, "Tile"); card.Content = body; card.Padding = new Thickness(6); card.Margin = new Thickness(0); card.HorizontalAlignment = HorizontalAlignment.Stretch;
        card.SetResourceReference(Control.BackgroundProperty, "Surface2");
        if (selected) card.SetResourceReference(Control.BorderBrushProperty, "Accent"); else card.BorderBrush = Brushes.Transparent;
        System.Windows.Automation.AutomationProperties.SetName(card, "Source video " + item.Name);
        return card;
    }

    async Task LoadThumbnail(string key, string path, double at, Image image)
    {
        try
        {
            var bytes = await FFmpeg.FrameJpeg(path, at, 360);
            if (disposed || bytes is null) return; thumbnails[key] = bytes; image.Source = Bitmap(bytes);
        }
        catch (Exception) { }
        finally { loadingThumbnails.Remove(key); }
    }

    async Task ImportVideo()
    {
        var picker = new OpenFileDialog { Title = "Import video", Filter = "Video files|*.mov;*.mp4;*.m4v;*.avi;*.mkv;*.webm|All files|*.*" };
        if (picker.ShowDialog(window) == true) await session.ImportSource(picker.FileName);
    }

    void BuildCaptions()
    {
        captions.Children.Clear(); captions.Margin = new Thickness(6); saveCaptions = null;
        if (session.ActiveSegment is not { } clip) { var empty = Text("Select a Short to change its captions.", 12, true); empty.Margin = new Thickness(0, 28, 0, 28); captions.Children.Add(empty); return; }
        var chosen = clip.CaptionStyle ?? CaptionStyle.Classic;
        var current = chosen.Resolved(clip.VideoType, clip.SplitScreen == true);
        var hasAudio = session.Project?.Media.FirstOrDefault(m => m.Id == clip.MediaId)?.HasAudio == true;
        var styles = Column();
        captions.Children.Add(FoldingSection(SectionLabel("Caption style"), styles, !session.Settings.CaptionStyleCollapsed, value => session.Settings.CaptionStyleCollapsed = !value));
        foreach (var style in CaptionStyles.Choices)
        {
            var selected = chosen == style || chosen == CaptionStyle.Clean && style == CaptionStyle.Classic;
            if (!stylePreviews.TryGetValue(style, out var bytes)) stylePreviews[style] = bytes = CaptionRenderer.StylePreview(style);
            var preview = new Border { Width = 112, Height = 34, CornerRadius = new CornerRadius(8), Padding = new Thickness(4, 0, 4, 0), Background = new SolidColorBrush(Color.FromRgb(71, 71, 71)), Child = new Image { Source = Bitmap(bytes), Stretch = Stretch.Uniform } };
            var title = Text(style.Title(), 12); title.FontWeight = FontWeights.Medium; title.Margin = new Thickness(0);
            var words = new StackPanel { Margin = new Thickness(10, 0, 8, 0), VerticalAlignment = VerticalAlignment.Center }; words.Children.Add(title); words.Children.Add(Text(style.Detail(), 11, true));
            var row = new DockPanel(); DockPanel.SetDock(preview, Dock.Left); row.Children.Add(preview);
            var check = PrismWindow.CheckCircle(selected); DockPanel.SetDock(check, Dock.Right); row.Children.Add(check); row.Children.Add(words);
            var button = Button("", () => session.SetSelectedCaptionStyle(style)); button.SetResourceReference(FrameworkElement.StyleProperty, "Tile");
            button.Content = row; button.Padding = new Thickness(8); button.Margin = new Thickness(0, 0, 0, 8); button.HorizontalAlignment = HorizontalAlignment.Stretch;
            button.SetResourceReference(Control.BackgroundProperty, selected ? "AccentWash" : "Surface2");
            if (selected) button.SetResourceReference(Control.BorderBrushProperty, "Accent"); else button.BorderBrush = Brushes.Transparent;
            button.IsEnabled = !session.IsBusy && !selected;
            System.Windows.Automation.AutomationProperties.SetName(button, style.Title());
            styles.Children.Add(button);
        }
        if (session.TimingShortIds.Count > 0)
            styles.Children.Add(Text(session.TimingShortIds.Count == 1 ? "Timing the words of 1 Short…" : $"Timing the words of {session.TimingShortIds.Count} Shorts…", 11, true));
        else if (current.UsesWordTiming() && clip.SpeechWords is not { Count: > 0 } && hasAudio)
            styles.Children.Add(Text("Word timing is estimated for this Short. Transcribing may improve it.", 11, true));
        styles.Children.Add(Caption("Position", false));
        var positions = Enum.GetValues<CaptionPosition>();
        styles.Children.Add(Segmented(positions.Select(p => p.Title()).ToArray(), Array.IndexOf(positions, clip.CaptionPosition ?? CaptionPosition.Bottom), index => session.SetSelectedCaptionLayout(position: positions[index])));
        styles.Children.Add(Caption("Size", false));
        var sizes = Enum.GetValues<CaptionSize>();
        styles.Children.Add(Segmented(sizes.Select(s => s.Title()).ToArray(), Array.IndexOf(sizes, clip.CaptionSize ?? CaptionSize.Medium), index => session.SetSelectedCaptionLayout(size: sizes[index])));
        var animated = new CheckBox { Content = "Pop-in animation", IsChecked = clip.CaptionAnimated == true, FontSize = 12, Margin = new Thickness(0, 10, 0, 0) };
        animated.Click += (_, _) => { try { session.SetSelectedCaptionLayout(animated: animated.IsChecked == true); } catch (Exception error) { SignalError(error.Message); } };
        styles.Children.Add(animated);
        styles.Children.Add(Rule());
        var transcribe = Link("Transcribe", "", () => _ = Safe(session.RegenerateSelectedSubtitles));
        transcribe.IsEnabled = !session.IsBusy && hasAudio;
        System.Windows.Automation.AutomationProperties.SetName(transcribe, "Transcribe speech into captions");
        transcribe.ToolTip = hasAudio ? "Transcribe with Prism AI in the cloud." : "This source video has no audio track.";
        var lines = Column();
        captions.Children.Add(FoldingSection(Heading(SectionLabel("Caption text"), transcribe), lines, !session.Settings.CaptionTextCollapsed, value => session.Settings.CaptionTextCollapsed = !value));
        var cues = clip.Captions ?? [];
        if (cues.Count == 0) { lines.Children.Add(Text(hasAudio ? "No captions yet. Transcribe this Short to create them." : "This source has no audio, so there is no speech to caption.", 12, true)); return; }
        var editors = new List<TextBox>();
        foreach (var cue in cues)
        {
            var jump = Link(Format.Clock(cue.Start), "", () => session.SeekPreview(cue.Start)); jump.SetResourceReference(Control.FontFamilyProperty, "MonoFont"); jump.FontSize = 11; jump.ToolTip = "Jump to this line in the preview";
            jump.SetResourceReference(Control.ForegroundProperty, "Muted"); lines.Children.Add(jump);
            var entry = new TextBox { Text = cue.Text, TextWrapping = TextWrapping.Wrap, AcceptsReturn = true, Padding = new Thickness(7), FontSize = 12, Margin = new Thickness(0, 0, 0, 6) };
            System.Windows.Automation.AutomationProperties.SetName(entry, "Caption at " + Format.Clock(cue.Start)); lines.Children.Add(entry); editors.Add(entry);
        }
        lines.Children.Add(Text("Clear a line to remove it. Changing a line's words turns off its yellow highlight.", 11, true));
        var save = Button("Save captions", () => session.UpdateSelectedCaptionTexts(editors.Select(e => e.Text).ToArray()), primary: true);
        save.ToolTip = "Save captions · Ctrl+S"; saveCaptions = save;
        save.HorizontalAlignment = HorizontalAlignment.Stretch; save.Padding = new Thickness(0, 9, 0, 9); save.Margin = new Thickness(0, 6, 0, 0); save.IsEnabled = false;
        foreach (var entry in editors) entry.TextChanged += (_, _) => save.IsEnabled = !session.IsBusy && !editors.Select(e => e.Text).SequenceEqual(cues.Select(c => c.Text));
        lines.Children.Add(save);
    }

    void SavePaneSizes()
    {
        if (session.IsPlayerExpanded || panes.ActualWidth <= 0 || root.RowDefinitions[3].ActualHeight <= 0) return;
        session.Settings.LeftSidebarWidth = Math.Clamp(panes.ColumnDefinitions[0].ActualWidth, 200, 440);
        session.Settings.RightSidebarWidth = Math.Clamp(panes.ColumnDefinitions[4].ActualWidth, 220, 460);
        session.Settings.TimelineHeight = Math.Clamp(root.RowDefinitions[3].ActualHeight, 150, 620); session.Settings.Save();
    }
    void OnKeyDown(object sender, KeyEventArgs args)
    {
        // Ctrl+S saves edited caption lines, also while one of them is being typed in, as ⌘S does on the Mac.
        if (args.Key == Key.S && Keyboard.Modifiers == ModifierKeys.Control && session.Screen == Screen.Editor && !disposed
            && saveCaptions is { IsEnabled: true, IsVisible: true } save)
        {
            args.Handled = true;
            save.RaiseEvent(new RoutedEventArgs(System.Windows.Controls.Primitives.ButtonBase.ClickEvent));
            return;
        }
        if (disposed || session.Screen != Screen.Editor || !root.IsEnabled || !session.Account.IsSignedIn || session.IsBusy
            || session.ExportChoice is not null || session.ExportSummary is not null || session.GenerationError is not null || session.PendingPaidRun is not null || session.Tutorial.IsActive || Typing()) return;
        try
        {
            var shift = Keyboard.Modifiers.HasFlag(ModifierKeys.Shift);
            switch (args.Key)
            {
                case Key.Space: session.TogglePlayback(); break;
                case Key.Left: session.SeekPreviewBy(shift ? -5 : -1); break;
                case Key.Right: session.SeekPreviewBy(shift ? 5 : 1); break;
                case Key.Delete: if (session.PreviewShortId is { } id) session.RemoveShort(id); break;
                case Key.Z when Keyboard.Modifiers.HasFlag(ModifierKeys.Control): if (shift) session.RedoFromEditor(); else session.UndoFromEditor(); break;
                case Key.Y when Keyboard.Modifiers.HasFlag(ModifierKeys.Control): session.RedoFromEditor(); break;
                case Key.Up: SelectAdjacentShort(-1); break;
                case Key.Down: SelectAdjacentShort(1); break;
                case Key.Escape when session.IsPlayerExpanded: session.IsPlayerExpanded = false; break;
                default: return;
            }
            args.Handled = true;
        }
        catch (Exception error) { SignalError(error.Message); }
    }
    IEnumerable<(EditSegment Clip, int Index)> OrderedShorts(ProjectData project)
    {
        var clips = project.Segments.Select((clip, index) => (Clip: clip, Index: index));
        return session.Settings.ShortsBestFirst ? clips.OrderByDescending(value => value.Clip.Score ?? -1).ThenBy(value => value.Index) : clips;
    }

    void SelectAdjacentShort(int direction)
    {
        if (session.Project is not { Segments.Count: > 0 } project) return;
        var ordered = OrderedShorts(project).Select(value => value.Clip).ToList();
        var index = ordered.FindIndex(clip => clip.Id == session.PreviewShortId);
        index = index < 0 ? (direction > 0 ? 0 : ordered.Count - 1) : Math.Clamp(index + direction, 0, ordered.Count - 1);
        var clip = ordered[index]; session.Selection = clip.MediaId; session.SelectPreview(clip.Id);
    }

    static bool Typing()
    {
        for (var focused = Keyboard.FocusedElement as DependencyObject; focused is not null; focused = Parent(focused))
            if (focused is TextBoxBase or PasswordBox or ComboBox) return true;
        return false;
    }
    static DependencyObject? Parent(DependencyObject node) => node is Visual or System.Windows.Media.Media3D.Visual3D ? VisualTreeHelper.GetParent(node) : LogicalTreeHelper.GetParent(node);
    static bool TextEditingInside(DependencyObject ancestor)
    {
        var editing = false;
        for (var focused = Keyboard.FocusedElement as DependencyObject; focused is not null; focused = Parent(focused))
        {
            if (focused is TextBoxBase or PasswordBox) editing = true;
            if (ReferenceEquals(focused, ancestor)) return editing;
        }
        return false;
    }
    void SignalError(string message) { session.Message = message; Error?.Invoke(message); }
    async Task Safe(Func<Task> action) { try { await action(); } catch (Exception error) { SignalError(error.Message); } }
    Button Button(string title, Action action, bool primary = false, bool danger = false)
    {
        var button = NewButton(title, primary, danger); button.Click += (_, _) => { try { action(); } catch (Exception error) { SignalError(error.Message); } }; return button;
    }
    Button AsyncButton(string title, Func<Task> action, bool primary = false)
    {
        var button = NewButton(title, primary); button.Click += async (_, _) => await Safe(action); return button;
    }
    static Button NewButton(string title, bool primary, bool danger = false)
    {
        var button = new Button { Content = title, Margin = new Thickness(0, 3, 5, 3), Padding = new Thickness(10, 7, 10, 7) };
        if (primary) { button.SetResourceReference(Control.BackgroundProperty, "Action"); button.Foreground = Brushes.Black; }
        if (danger) button.SetResourceReference(Control.ForegroundProperty, "Coral"); return button;
    }
    /// The Mac editor's link buttons: no outline, compact, a soft fill on hover.
    static void Plain(Button button) { button.BorderBrush = Brushes.Transparent; button.Padding = new Thickness(8, 5, 8, 5); button.VerticalAlignment = VerticalAlignment.Center; }
    static TextBlock Text(string value, double size = 13, bool muted = false)
    {
        var text = new TextBlock { Text = value, FontSize = size, TextWrapping = TextWrapping.Wrap, Margin = new Thickness(0, 3, 0, 3), VerticalAlignment = VerticalAlignment.Center };
        text.SetResourceReference(TextBlock.ForegroundProperty, muted ? "Muted" : "Ink"); if (size >= 15) text.SetResourceReference(TextBlock.FontFamilyProperty, "DisplayFont"); return text;
    }
    static TextBlock Glyph(string glyph, double size, Brush? brush = null, bool muted = false)
    {
        var icon = new TextBlock { Text = glyph, FontFamily = new FontFamily("Segoe Fluent Icons, Segoe MDL2 Assets"), FontSize = size, VerticalAlignment = VerticalAlignment.Center, HorizontalAlignment = HorizontalAlignment.Center };
        if (brush is not null) icon.Foreground = brush; else if (muted) icon.SetResourceReference(TextBlock.ForegroundProperty, "Muted");
        return icon;
    }
    /// The Mac editor's icon buttons: a 30 px square that lights up on hover.
    Button IconButton(string glyph, string title, Action action)
    {
        var button = Button("", action); Plain(button); button.Content = Glyph(glyph, 13); button.Width = 30; button.Height = 30; button.Padding = new Thickness(0); button.Margin = new Thickness(0);
        button.ToolTip = title; System.Windows.Automation.AutomationProperties.SetName(button, title); return button;
    }
    /// Accent text links with an icon: Create more, Transcribe, Re-track.
    Button Link(string title, string glyph, Action action)
    {
        var button = Button("", action); Plain(button); button.FontSize = 11; button.HorizontalAlignment = HorizontalAlignment.Left; button.Margin = new Thickness(-8, 2, 0, 2);
        var mark = Glyph(glyph, 11); mark.Margin = new Thickness(0, 0, 6, 0);
        var row = new StackPanel { Orientation = Orientation.Horizontal }; row.Children.Add(mark); row.Children.Add(new TextBlock { Text = title, VerticalAlignment = VerticalAlignment.Center });
        button.Content = row; button.SetResourceReference(Control.ForegroundProperty, "Accent"); return button;
    }
    static UIElement ToolHeader(string glyph, string title)
    {
        var panel = new StackPanel { MinWidth = 72 };
        var icon = Glyph(glyph, 17); icon.Margin = new Thickness(0, 2, 0, 6); panel.Children.Add(icon);
        panel.Children.Add(new TextBlock { Text = title, FontSize = 11, HorizontalAlignment = HorizontalAlignment.Center }); return panel;
    }
    static TextBlock SectionLabel(string title) { var label = Text(title, 14); label.FontWeight = FontWeights.Medium; return label; }
    static TextBlock Caption(string title, bool muted = true) { var label = Text(title, 11, muted); label.FontWeight = FontWeights.Medium; label.Margin = new Thickness(0, 12, 0, 4); return label; }
    static DockPanel Heading(UIElement left, UIElement right)
    {
        var row = new DockPanel { Margin = new Thickness(0, 4, 0, 4) }; DockPanel.SetDock(right, Dock.Right); row.Children.Add(right); row.Children.Add(left); return row;
    }
    static Border Rule() { var line = new Border { Height = 1, Margin = new Thickness(0, 14, 0, 6) }; line.SetResourceReference(Border.BackgroundProperty, "Line"); return line; }
    static Border Panel(UIElement child, Thickness edge)
    {
        var panel = new Border { Child = child, BorderThickness = edge }; panel.SetResourceReference(Border.BackgroundProperty, "Surface1"); panel.SetResourceReference(Border.BorderBrushProperty, "Line"); return panel;
    }
    /// A segmented picker: equal buttons, the chosen one tinted with the accent.
    UniformGrid Segmented(string[] titles, int selected, Action<int> chosen)
    {
        var grid = new UniformGrid { Rows = 1, Margin = new Thickness(0, 2, 0, 4) };
        for (var index = 0; index < titles.Length; index++)
        {
            var choice = index;
            var button = Button(titles[index], () => { if (choice != selected) chosen(choice); }); button.FontSize = 11; button.Padding = new Thickness(4, 7, 4, 7); button.Margin = new Thickness(0, 0, index == titles.Length - 1 ? 0 : 6, 0);
            button.SetResourceReference(Control.BackgroundProperty, index == selected ? "AccentWash" : "Surface2");
            if (index == selected) { button.SetResourceReference(Control.BorderBrushProperty, "Accent"); button.SetResourceReference(Control.ForegroundProperty, "Accent"); }
            else { button.BorderBrush = Brushes.Transparent; button.SetResourceReference(Control.ForegroundProperty, "Muted"); }
            grid.Children.Add(button);
        }
        return grid;
    }
    static ControlTemplate RoundTemplate()
    {
        var border = new FrameworkElementFactory(typeof(Border)); border.SetValue(Border.CornerRadiusProperty, new CornerRadius(11)); border.SetBinding(Border.BackgroundProperty, new System.Windows.Data.Binding("Background") { RelativeSource = System.Windows.Data.RelativeSource.TemplatedParent });
        var content = new FrameworkElementFactory(typeof(ContentPresenter)); content.SetValue(FrameworkElement.HorizontalAlignmentProperty, HorizontalAlignment.Center); content.SetValue(FrameworkElement.VerticalAlignmentProperty, VerticalAlignment.Center);
        border.AppendChild(content); return new ControlTemplate(typeof(Button)) { VisualTree = border };
    }
    static StackPanel Column() => new() { Orientation = Orientation.Vertical, Margin = new Thickness(8) };
    static StackPanel Row(params UIElement[] children) { var row = new StackPanel { Orientation = Orientation.Horizontal }; foreach (var child in children) row.Children.Add(child); return row; }
    static ScrollViewer Scroll(UIElement child) => new() { Content = child, VerticalScrollBarVisibility = ScrollBarVisibility.Auto, HorizontalScrollBarVisibility = ScrollBarVisibility.Disabled };
    static Border Card(UIElement child)
    {
        var border = new Border { Child = child, Padding = new Thickness(10), CornerRadius = new CornerRadius(12), BorderThickness = new Thickness(1), Margin = new Thickness(0, 5, 0, 5) };
        border.SetResourceReference(Border.BackgroundProperty, "Surface1"); border.SetResourceReference(Border.BorderBrushProperty, "Line"); return border;
    }
    static FrameworkElement Field(string title, FrameworkElement control)
    { var panel = Column(); panel.Margin = new Thickness(0, 4, 0, 4); panel.Children.Add(Text(title, 11, true)); panel.Children.Add(control); return panel; }
    static ComboBox Combo(string[] values, int selected) => new() { ItemsSource = values, SelectedIndex = selected, MinHeight = 32 };
    static void StyleTabs(TabControl tabs)
    {
        tabs.SetResourceReference(Control.BackgroundProperty, "Surface0"); tabs.SetResourceReference(Control.ForegroundProperty, "Ink"); tabs.SetResourceReference(Control.BorderBrushProperty, "Line");
    }
    static TabItem Tab(object title, UIElement content)
    {
        var tab = new TabItem { Header = title, Content = content, Padding = new Thickness(10, 8, 10, 8) };
        tab.SetResourceReference(Control.BackgroundProperty, "Surface1"); tab.SetResourceReference(Control.ForegroundProperty, "Ink"); tab.SetResourceReference(Control.BorderBrushProperty, "Line"); return tab;
    }
    static GridSplitter Splitter() { var splitter = new GridSplitter { Width = 5, HorizontalAlignment = HorizontalAlignment.Stretch, VerticalAlignment = VerticalAlignment.Stretch, ResizeDirection = GridResizeDirection.Columns, ResizeBehavior = GridResizeBehavior.PreviousAndNext, ShowsPreview = true, Background = Brushes.Transparent, Cursor = Cursors.SizeWE, ToolTip = "Drag to resize sidebar" }; return splitter; }
    static void Add(Grid grid, UIElement child, int row, int column = 0) { Grid.SetRow(child, row); Grid.SetColumn(child, column); grid.Children.Add(child); }
    static Image Picture(string path)
    {
        var image = new Image { Height = 88, Stretch = Stretch.UniformToFill, ClipToBounds = true, Margin = new Thickness(0, 0, 0, 6) };
        try { image.Source = Bitmap(File.ReadAllBytes(path)); } catch (Exception) { }
        return image;
    }
    static BitmapImage Bitmap(byte[] bytes)
    {
        using var stream = new MemoryStream(bytes); var image = new BitmapImage(); image.BeginInit(); image.CacheOption = BitmapCacheOption.OnLoad; image.StreamSource = stream; image.EndInit(); image.Freeze(); return image;
    }
    public void Dispose()
    {
        if (disposed) return; SavePaneSizes(); disposed = true; ticker.Stop(); window.PreviewKeyDown -= OnKeyDown; video.MediaOpened -= MediaOpened; ClearPlayback();
        if (ReferenceEquals(session.Player, player)) session.Player = null; timeline.Dispose();
    }
    sealed class PreviewPlayer(MediaElement element, Action clear) : IPreviewPlayer
    {
        public bool IsPlaying { get; private set; }
        public double CurrentTime => element.Position.TotalSeconds;
        public void Seek(double seconds) { if (double.IsFinite(seconds)) element.Position = TimeSpan.FromSeconds(Math.Max(0, seconds)); }
        public void Play() { element.Play(); IsPlaying = true; }
        public void Pause() { element.Pause(); IsPlaying = false; }
        public void Clear() { IsPlaying = false; clear(); }
        public void TogglePlayback() { if (IsPlaying) Pause(); else Play(); }
    }
}
