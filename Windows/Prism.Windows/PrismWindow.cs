using System.ComponentModel;
using System.Globalization;
using System.IO;
using System.Windows;
using System.Windows.Automation;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Media;
using System.Windows.Media.Imaging;
using System.Windows.Shapes;
using System.Windows.Threading;
using Prism.Core;
using Path = System.IO.Path;

namespace Prism.Windows;

public sealed partial class PrismWindow : Window
{
    /// Ink text on the Sky action fill, in both themes.
    internal static readonly SolidColorBrush OnAction = Frozen(Color.FromRgb(14, 15, 20));
    const string IconFont = "Segoe Fluent Icons, Segoe MDL2 Assets";

    readonly AppSession session;
    readonly WindowsEditor editor;
    readonly Grid layout = new();
    readonly Grid overlayHost = new();
    readonly DockPanel navigation = new() { LastChildFill = false };
    readonly ContentControl content = new();
    readonly Border sidePanel;
    readonly Border top = new() { Padding = new Thickness(20, 16, 152, 16) };
    readonly TextBlock heading = Text("Home", 18, display: true);
    readonly TextBlock status = Text("", 12, muted: true);
    readonly ProgressBar busy = new() { IsIndeterminate = true, Width = 44, Height = 4, Margin = new Thickness(12, 0, 0, 0) };
    TextBlock memory = new(), storage = new(), ringLabel = new(), freeLabel = new();
    ProgressBar memoryBar = new(), storageBar = new();
    System.Windows.Shapes.Path? ring, storageRing;
    readonly Dictionary<Screen, Button> navButtons = [];
    readonly List<Action> appearanceUpdates = [];
    readonly Button minimize, maximize, close;
    readonly DispatcherTimer resourceTimer = new();
    readonly DispatcherTimer activityTimer = new();
    readonly Dictionary<string, ProjectSummary> summaries = [];
    string renderedScreen = "", renderedPage = "", modalKind = "", lastMessage = "";
    bool queued, disposed, showAll, showUnfinished, sidebarCollapsed, notifying;
    int createStep, localRevision, settingsCategory;
    long homeRevision;
    Guid? openFolder;
    Border? localCard;
    Action? updateScreen, updateModal;

    public PrismWindow()
    {
        Title = "Prism";
        var icon = Path.Combine(AppContext.BaseDirectory, "Brand", "Prism.png");
        if (File.Exists(icon)) Icon = BitmapFrame.Create(new Uri(icon));
        Width = 1440; Height = 920;
        MinWidth = 900; MinHeight = 620;
        WindowStartupLocation = WindowStartupLocation.CenterScreen;
        UseLayoutRounding = true; SnapsToDevicePixels = true;
        // Prism draws its own title bar and caption buttons, so the page runs to the top edge like the Mac app.
        System.Windows.Shell.WindowChrome.SetWindowChrome(this, new System.Windows.Shell.WindowChrome { CaptionHeight = 0, ResizeBorderThickness = new Thickness(6), GlassFrameThickness = new Thickness(0, 0, 0, 1), UseAeroCaptionButtons = false });
        StateChanged += (_, _) => { FitMaximized(); ((TextBlock)maximize!.Content).Text = WindowState == WindowState.Maximized ? "\uE923" : "\uE922"; };
        Activated += (_, _) => TintCaption(); Deactivated += (_, _) => TintCaption();
        SourceInitialized += (_, _) => { TintTitleBar(); System.Windows.Interop.HwndSource.FromHwnd(new System.Windows.Interop.WindowInteropHelper(this).Handle)?.AddHook(CaptionHook); };
        session = new AppSession(new WindowsPlatform());
        updater = CreateUpdater();
        InstallStyles();
        ApplyTheme();
        SetResourceReference(BackgroundProperty, "Surface0");
        SetResourceReference(ForegroundProperty, "Ink");
        SetResourceReference(FontFamilyProperty, "UiFont");
        editor = new WindowsEditor(session, this);
        editor.Error += message => ShowNotice("Could not complete action", message);
        var root = new Grid();
        root.RowDefinitions.Add(new RowDefinition());
        root.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
        root.Children.Add(layout);
        root.Children.Add(updateBanner);
        root.Children.Add(tutorialShade);
        tutorialCoach.SetResourceReference(Border.BackgroundProperty, "Surface1"); tutorialCoach.SetResourceReference(Border.BorderBrushProperty, "Line");
        Grid.SetRow(tutorialCoach, 1); root.Children.Add(tutorialCoach);
        Grid.SetRowSpan(overlayHost, 2); root.Children.Add(overlayHost);
        LayoutUpdated += (_, _) => PlaceSpotlight();
        (minimize, maximize, close) = (CaptionButton("\uE921", "Minimize"), CaptionButton("\uE922", "Maximize"), CaptionButton("\uE8BB", "Close"));
        minimize.Click += (_, _) => WindowState = WindowState.Minimized;
        maximize.Click += (_, _) => ToggleMaximize();
        close.Click += (_, _) => Close();
        var captions = Row(minimize, maximize, close); captions.HorizontalAlignment = HorizontalAlignment.Right; captions.VerticalAlignment = VerticalAlignment.Top;
        root.Children.Add(captions);
        overlayHost.Visibility = Visibility.Collapsed;
        Content = root;
        layout.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(252) });
        layout.ColumnDefinitions.Add(new ColumnDefinition());
        sidePanel = new Border { Child = navigation, BorderThickness = new Thickness(0, 0, 1, 0) };
        sidePanel.SetResourceReference(Border.BackgroundProperty, "Surface1");
        sidePanel.SetResourceReference(Border.BorderBrushProperty, "Line");
        BuildSidebar();
        layout.Children.Add(sidePanel);
        var main = new Grid();
        main.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
        main.RowDefinitions.Add(new RowDefinition());
        Grid.SetColumn(main, 1);
        layout.Children.Add(main);
        var header = new Grid();
        foreach (var width in new[] { GridLength.Auto, new GridLength(1, GridUnitType.Star), GridLength.Auto, GridLength.Auto }) header.ColumnDefinitions.Add(new ColumnDefinition { Width = width });
        heading.Margin = new Thickness(0, 0, 20, 0); header.Children.Add(heading);
        status.TextTrimming = TextTrimming.CharacterEllipsis; status.TextWrapping = TextWrapping.NoWrap; status.TextAlignment = TextAlignment.Right;
        Grid.SetColumn(status, 1); header.Children.Add(status);
        Grid.SetColumn(busy, 2); header.Children.Add(busy);
        var appearance = AppearanceSwitch(); appearance.Margin = new Thickness(12, 0, 0, 0);
        Grid.SetColumn(appearance, 3); header.Children.Add(appearance);
        top.Child = header; top.Background = Brushes.Transparent; top.MouseLeftButtonDown += (_, args) => DragFrom(args);
        main.Children.Add(top);
        Grid.SetRow(content, 1); main.Children.Add(content);
        session.PropertyChanged += SessionChanged;
        session.Notified += (title, body) => Dispatcher.BeginInvoke(new Action(() => NotifyIfInBackground(title, body)));
        Closed += (_, _) => DisposeSession();
        PreviewKeyDown += (_, args) =>
        {
            if (args.Key == Key.Escape && Dismiss()) { args.Handled = true; return; }
            // The Mac's menu shortcuts, with Ctrl for ⌘; like its menus, only while Prism is free to change screens.
            var canUseMenus = !session.IsBusy && session.Account.IsSignedIn && !session.Tutorial.IsActive && modalKind.Length == 0;
            var control = Keyboard.Modifiers == ModifierKeys.Control; var controlShift = Keyboard.Modifiers == (ModifierKeys.Control | ModifierKeys.Shift);
            if (!canUseMenus || !(control || controlShift)) return;
            switch (args.Key)
            {
                case Key.N when control: StartCreate(); break;
                case Key.OemComma when control: Navigate(Screen.Settings); break;
                case Key.O when control: StartCreate(); _ = ChooseVideo(); break;
                case Key.O when controlShift: if (ChooseFolder("Open a Prism project (.relio)") is { } path) session.Open(path); break;
                case Key.E when control && session.Screen == Screen.Editor && session.Project?.Media.Count > 0: session.ChooseExport(); break;
                default: return;
            }
            args.Handled = true;
        };
        SizeChanged += (_, _) => { if (overlayHost.Children.Count > 0 && overlayHost.Children[0] is Border { Child: ScrollViewer scroll }) scroll.MaxHeight = Math.Max(300, ActualHeight - 90); };
        resourceTimer.Tick += (_, _) => RefreshResources();
        activityTimer.Interval = TimeSpan.FromSeconds(1);
        activityTimer.Tick += (_, _) => { if (modalKind is "progress" or "working" or "testing") updateModal?.Invoke(); };
        activityTimer.Start();
        RestartResourceTimer();
        StartUpdates();
        Refresh();
    }

    void SessionChanged(object? sender, PropertyChangedEventArgs args)
    {
        if (args.PropertyName is nameof(AppSession.ProjectListRevision) or nameof(AppSession.ProjectFolders) or nameof(AppSession.RecentProjectPaths) or nameof(AppSession.Project))
        { homeRevision++; summaries.Clear(); }
        if (queued || disposed) return;
        queued = true;
        Dispatcher.BeginInvoke(DispatcherPriority.DataBind, new Action(() => { queued = false; if (!disposed) Refresh(); }));
    }

    void Refresh()
    {
        // The title bar names the open project in the editor, like the Mac app; a pending notice keeps its own title.
        if (!notifying) Title = session.Screen == Screen.Editor ? session.Project?.DisplayTitle ?? "Prism" : "Prism";
        heading.Text = session.Screen switch
        {
            Screen.Home => "Home", Screen.Settings => "Settings", Screen.Create or Screen.ImportSource => "Create Shorts",
            _ => session.Project?.DisplayTitle ?? "Editor",
        };
        // Like the Mac app, only the import flow shows the running status line; elsewhere errors arrive as notices.
        status.Text = session.Screen is Screen.Create or Screen.ImportSource ? session.Message : "";
        busy.Visibility = session.IsBusy ? Visibility.Visible : Visibility.Collapsed;
        var editing = session.Screen == Screen.Editor;
        layout.ColumnDefinitions[0].Width = new GridLength(editing ? 0 : sidebarCollapsed ? 76 : 252);
        sidePanel.Visibility = top.Visibility = editing ? Visibility.Collapsed : Visibility.Visible;
        foreach (var (screen, button) in navButtons)
        {
            button.IsEnabled = !session.IsBusy;
            if (screen == Screen.ImportSource) continue;
            var selected = session.Screen == screen;
            if (selected) button.SetResourceReference(Control.BackgroundProperty, "Surface2"); else button.Background = Brushes.Transparent;
            button.FontWeight = selected ? FontWeights.Medium : FontWeights.Normal;
            if (screen == Screen.Editor) button.Visibility = session.Project is null ? Visibility.Collapsed : Visibility.Visible;
        }
        var key = session.Screen switch
        {
            Screen.Home => $"home:{homeRevision}:{showAll}:{showUnfinished}:{openFolder}",
            Screen.Create or Screen.ImportSource => $"create:{createStep}:{session.ShortsSource?.Id}",
            Screen.Settings => $"settings:{settingsCategory}:{session.Account.IsSignedIn}:{updater.ReadyVersion}:{updater.AvailableVersion}:{updater.CheckResult}", _ => "editor",
        };
        if (renderedScreen != key)
        {
            renderedScreen = key; updateScreen = null;
            var page = session.Screen.ToString();
            content.Content = null;
            content.Content = session.Screen switch
            {
                Screen.Home => Home(), Screen.Settings => SettingsPage(),
                Screen.Create or Screen.ImportSource => CreateFlow(), _ => editor.Widget,
            };
            // A short fade when the page itself changes, like the Mac app's screen transitions; re-renders of the same page stay still.
            if (page != renderedPage) { renderedPage = page; content.BeginAnimation(OpacityProperty, new System.Windows.Media.Animation.DoubleAnimation(0, 1, TimeSpan.FromMilliseconds(160))); }
        }
        updateScreen?.Invoke();
        editor.Refresh();
        if (lastMessage != session.Message)
        {
            lastMessage = session.Message;
            if (!session.IsBusy && session.GenerationError is null && session.ExportChoice is null && session.ExportSummary is null
                && (lastMessage.StartsWith("Could not", StringComparison.Ordinal) || lastMessage.StartsWith("Choose valid", StringComparison.Ordinal)
                    || lastMessage.StartsWith("No file exists", StringComparison.Ordinal) || lastMessage.Contains("could not be opened", StringComparison.Ordinal)))
                ShowNotice("Could not complete action", lastMessage);
        }
        RefreshModal();
        RefreshBanner();
        UpdateTutorial();
    }

    /// While Prism is in the background, a finished run or export flashes its taskbar button until the person returns,
    /// the Windows counterpart of the Mac's notification. The taskbar tooltip says what happened.
    void NotifyIfInBackground(string title, string body)
    {
        if (disposed || IsActive) return;
        notifying = true;
        Title = $"{title} · Prism";
        var flash = new FlashInfo { Size = (uint)System.Runtime.InteropServices.Marshal.SizeOf<FlashInfo>(), Window = new System.Windows.Interop.WindowInteropHelper(this).Handle, Flags = 3 | 12 };
        FlashWindowEx(ref flash);
        void Restore(object? sender, EventArgs args) { notifying = false; Activated -= Restore; Refresh(); }
        Activated += Restore;
    }

    [System.Runtime.InteropServices.StructLayout(System.Runtime.InteropServices.LayoutKind.Sequential)]
    struct FlashInfo { public uint Size; public IntPtr Window; public uint Flags; public uint Count; public uint Timeout; }
    // Flags: FLASHW_ALL (3) | FLASHW_TIMERNOFG (12), flashing until the window comes to the foreground.
    [System.Runtime.InteropServices.DllImport("user32.dll")] static extern bool FlashWindowEx(ref FlashInfo info);

    void InvalidateScreen() { renderedScreen = ""; Refresh(); }
    void Navigate(Screen screen)
    {
        if (session.IsBusy) return;
        createStep = 0; session.Screen = screen; Refresh();
    }
    void StartCreate() { createStep = 0; session.StartLongVideoToShort(); Refresh(); }

    void BuildSidebar()
    {
        navigation.Children.Clear(); navButtons.Clear();
        navigation.Margin = new Thickness(sidebarCollapsed ? 14 : 24);
        var upper = new StackPanel(); DockPanel.SetDock(upper, Dock.Top);
        var lower = new StackPanel(); DockPanel.SetDock(lower, Dock.Bottom);
        if (sidebarCollapsed)
        {
            var expand = Link(Button("", () => { sidebarCollapsed = false; BuildSidebar(); Refresh(); }));
            expand.Content = Glyph("", 18); expand.HorizontalAlignment = HorizontalAlignment.Center; expand.ToolTip = "Expand sidebar";
            AutomationProperties.SetName(expand, "Expand sidebar"); upper.Children.Add(expand);
        }
        else
        {
            var brand = new DockPanel { Background = Brushes.Transparent };
            brand.MouseLeftButtonDown += (_, args) => DragFrom(args);
            var collapse = Link(Button("", () => { sidebarCollapsed = true; BuildSidebar(); Refresh(); }));
            collapse.Content = Glyph("", 14); collapse.ToolTip = "Collapse sidebar";
            AutomationProperties.SetName(collapse, "Collapse sidebar");
            DockPanel.SetDock(collapse, Dock.Right); brand.Children.Add(collapse);
            var mark = Mark(24); mark.Margin = new Thickness(0, 0, 10, 0);
            var name = Text("Prism", 24, display: true); name.Margin = new Thickness(0);
            brand.Children.Add(Row(mark, name));
            upper.Children.Add(brand);
            var tagline = Text("Your video editor · Cloud AI", 12, muted: true); tagline.Margin = new Thickness(0, 12, 0, 0);
            upper.Children.Add(tagline);
        }
        upper.Children.Add(Divider(new Thickness(0, 22, 0, 22)));
        upper.Children.Add(NavItem("\uEA8A", "Home", Screen.Home, () => Navigate(Screen.Home)));
        upper.Children.Add(NavItem("", "Create Shorts", Screen.ImportSource, StartCreate, prominent: true));
        upper.Children.Add(NavItem("", "Editor", Screen.Editor, () => Navigate(Screen.Editor)));
        lower.Children.Add(NavItem("", "Settings", Screen.Settings, () => Navigate(Screen.Settings)));
        lower.Children.Add(sidebarCollapsed ? RamRing() : ResourceSummary());
        navigation.Children.Add(upper); navigation.Children.Add(lower);
        RefreshResources();
    }
    Button NavItem(string glyph, string title, Screen screen, Action action, bool prominent = false)
    {
        var vertical = prominent ? 13 : 10;
        var button = Button("", action);
        button.BorderThickness = new Thickness(0); button.Padding = new Thickness(12, vertical, 12, vertical); button.Margin = new Thickness(0, 0, 0, 6);
        button.FontSize = 14; button.FontWeight = prominent ? FontWeights.Medium : FontWeights.Normal; button.ToolTip = title; button.HorizontalAlignment = HorizontalAlignment.Stretch;
        button.HorizontalContentAlignment = sidebarCollapsed ? HorizontalAlignment.Center : HorizontalAlignment.Left;
        AutomationProperties.SetName(button, title);
        FrameworkElement mark = prominent ? PlusTile(16, 9) : Glyph(glyph, sidebarCollapsed ? 16 : 15);
        if (sidebarCollapsed)
        {
            // Only the icon gets a small pill, with its name below, so the narrow sidebar stays light (as on the Mac).
            var name = Text(prominent ? "Create" : title, 10); name.FontWeight = FontWeights.Medium; name.Margin = new Thickness(0, 5, 0, 0); name.HorizontalAlignment = HorizontalAlignment.Center;
            mark.HorizontalAlignment = HorizontalAlignment.Center;
            button.Content = Column(mark, name);
        }
        else { mark.Margin = new Thickness(0, 0, 12, 0); button.Content = Row(mark, Label(title, 14)); }
        if (prominent) { button.SetResourceReference(Control.BackgroundProperty, "Action"); button.Foreground = OnAction; }
        navButtons[screen] = button;
        return button;
    }
    UIElement ResourceSummary()
    {
        var panel = new StackPanel { Margin = new Thickness(0, 17, 0, 0), ToolTip = "RAM and available storage refresh at the interval set in Settings" };
        var title = Text("System resources", 11, muted: true); title.FontWeight = FontWeights.Medium; title.Margin = new Thickness(0, 0, 0, 8);
        panel.Children.Add(title);
        memory = Text("", 11, muted: true, mono: true); storage = Text("", 11, muted: true, mono: true);
        memoryBar = new ProgressBar { Height = 4, Maximum = 1, Margin = new Thickness(0, 4, 0, 12) };
        storageBar = new ProgressBar { Height = 4, Maximum = 1, Margin = new Thickness(0, 4, 0, 0) };
        panel.Children.Add(ResourceLine("", "RAM used", memory)); panel.Children.Add(memoryBar);
        panel.Children.Add(ResourceLine("", "Storage free", storage)); panel.Children.Add(storageBar);
        ring = storageRing = null;
        return panel;
    }
    static DockPanel ResourceLine(string glyph, string title, TextBlock value)
    {
        var line = new DockPanel();
        value.Margin = new Thickness(4, 0, 0, 0); DockPanel.SetDock(value, Dock.Right); line.Children.Add(value);
        var mark = Glyph(glyph, 11, "Muted"); mark.Margin = new Thickness(0, 0, 6, 0);
        var label = Text(title, 11, muted: true); label.FontWeight = FontWeights.Medium; label.Margin = new Thickness(0);
        line.Children.Add(Row(mark, label));
        return line;
    }
    /// The collapsed sidebar shows RAM (outer ring) and free storage (inner ring) with the free space below, like the Mac app.
    UIElement RamRing()
    {
        var host = new Grid { Width = 50, Height = 50, HorizontalAlignment = HorizontalAlignment.Center };
        Ellipse Track(double inset, double width) { var track = new Ellipse { StrokeThickness = width, Margin = new Thickness(inset) }; track.SetResourceReference(Shape.StrokeProperty, "Line"); return track; }
        host.Children.Add(Track(2, 4)); host.Children.Add(Track(8, 3));
        ring = new System.Windows.Shapes.Path { StrokeThickness = 4, StrokeStartLineCap = PenLineCap.Round, StrokeEndLineCap = PenLineCap.Round }; ring.SetResourceReference(Shape.StrokeProperty, "Ink");
        storageRing = new System.Windows.Shapes.Path { StrokeThickness = 3, StrokeStartLineCap = PenLineCap.Round, StrokeEndLineCap = PenLineCap.Round }; storageRing.SetResourceReference(Shape.StrokeProperty, "Accent");
        host.Children.Add(ring); host.Children.Add(storageRing);
        var ram = Text("RAM", 7, muted: true); ram.FontWeight = FontWeights.Medium; ram.Margin = new Thickness(0); ram.HorizontalAlignment = HorizontalAlignment.Center;
        ringLabel = Text("", 10, display: true); ringLabel.Margin = new Thickness(0); ringLabel.HorizontalAlignment = HorizontalAlignment.Center;
        var middle = Column(ram, ringLabel); middle.VerticalAlignment = VerticalAlignment.Center; host.Children.Add(middle);
        freeLabel = Text("", 9); freeLabel.FontWeight = FontWeights.Medium; freeLabel.SetResourceReference(TextBlock.ForegroundProperty, "Accent");
        freeLabel.HorizontalAlignment = HorizontalAlignment.Center; freeLabel.Margin = new Thickness(0, 6, 0, 0);
        memory = new TextBlock(); storage = new TextBlock(); memoryBar = new ProgressBar(); storageBar = new ProgressBar();
        var column = Column(host, freeLabel); column.Margin = new Thickness(0, 17, 0, 0); column.HorizontalAlignment = HorizontalAlignment.Center;
        return column;
    }

    /// An arc from twelve o'clock, clockwise, for `fraction` of a circle of `radius` around the ring's centre.
    static Geometry Arc(double fraction, double radius)
    {
        var used = Math.Clamp(fraction, 0, 0.9999); var angle = used * 2 * Math.PI;
        var figure = new PathFigure { StartPoint = new Point(25, 25 - radius) };
        figure.Segments.Add(new ArcSegment(new Point(25 + radius * Math.Sin(angle), 25 - radius * Math.Cos(angle)), new Size(radius, radius), 0, used > 0.5, SweepDirection.Clockwise, true));
        return new PathGeometry([figure]);
    }

    void RestartResourceTimer()
    {
        resourceTimer.Stop();
        resourceTimer.Interval = TimeSpan.FromSeconds(Math.Clamp(session.Settings.ResourceRefreshSeconds, 1, 3600));
        resourceTimer.Start(); RefreshResources();
    }
    void RefreshResources()
    {
        var profile = MachineProfile.Detect();
        memory.Text = string.Create(CultureInfo.InvariantCulture, $"{profile.MemoryUsedGB:0.0} / {profile.MemoryGB} GB");
        storage.Text = $"{profile.FreeGB} / {profile.StorageGB} GB";
        memoryBar.Value = profile.MemoryUsage; storageBar.Value = profile.FreeStorageRatio;
        if (ring is null || storageRing is null) return;
        ring.Data = Arc(profile.MemoryUsage, 21); storageRing.Data = Arc(profile.FreeStorageRatio, 15.5);
        ringLabel.Text = $"{(int)(profile.MemoryUsage * 100)}%";
        freeLabel.Text = $"{profile.FreeGB} GB free";
        var summary = string.Create(CultureInfo.InvariantCulture, $"RAM used: {profile.MemoryUsedGB:0.0} of {profile.MemoryGB} GB · Storage free: {profile.FreeGB} of {profile.StorageGB} GB");
        ring.ToolTip = storageRing.ToolTip = summary;
        AutomationProperties.SetName(freeLabel, $"RAM {(int)(profile.MemoryUsage * 100)} percent used; {profile.FreeGB} gigabytes of storage free");
    }

    /// The dark/light switch: two icon segments in a pill, shared with the editor header.
    internal FrameworkElement AppearanceSwitch()
    {
        var row = new StackPanel { Orientation = Orientation.Horizontal };
        var pill = new Border { Child = row, Padding = new Thickness(2), CornerRadius = new CornerRadius(8), VerticalAlignment = VerticalAlignment.Center };
        pill.SetResourceReference(Border.BackgroundProperty, "Surface2");
        foreach (var (mode, glyph, title) in new[] { ("dark", "", "Dark mode"), ("light", "", "Light mode") })
        {
            var button = new Button { Content = Glyph(glyph, 12), Width = 30, Height = 24, Padding = new Thickness(0), Margin = new Thickness(0), ToolTip = title, HorizontalContentAlignment = HorizontalAlignment.Center };
            AutomationProperties.SetName(button, title);
            button.Click += (_, _) => { session.Settings.Appearance = mode; session.Settings.Save(); ApplyTheme(); };
            void Update()
            {
                var selected = (session.Settings.Appearance == "light" ? "light" : "dark") == mode;
                if (selected) { button.SetResourceReference(BackgroundProperty, "Surface1"); button.SetResourceReference(BorderBrushProperty, "Line"); button.SetResourceReference(ForegroundProperty, "Ink"); }
                else { button.Background = button.BorderBrush = Brushes.Transparent; button.SetResourceReference(ForegroundProperty, "Muted"); }
            }
            Update(); appearanceUpdates.Add(Update); row.Children.Add(button);
        }
        return pill;
    }

    /// Windows caption buttons, drawn by Prism in its own title bar: 46 × 32, close turns red on hover.
    Button CaptionButton(string glyph, string title)
    {
        var button = new Button { Content = new TextBlock { Text = glyph, FontFamily = new FontFamily(IconFont), FontSize = 10 }, Width = 46, Height = 32, Padding = new Thickness(0),
            Margin = new Thickness(0), BorderThickness = new Thickness(0), Background = Brushes.Transparent, Focusable = false, Cursor = Cursors.Arrow, ToolTip = title };
        button.SetResourceReference(ForegroundProperty, "Ink");
        AutomationProperties.SetName(button, title);
        var hot = title == "Close" ? Frozen(Color.FromRgb(196, 43, 28)) : null;
        var face = new FrameworkElementFactory(typeof(Border)); face.Name = "face";
        face.SetBinding(Border.BackgroundProperty, new System.Windows.Data.Binding("Background") { RelativeSource = System.Windows.Data.RelativeSource.TemplatedParent });
        var presenter = new FrameworkElementFactory(typeof(ContentPresenter)); presenter.SetValue(HorizontalAlignmentProperty, HorizontalAlignment.Center); presenter.SetValue(VerticalAlignmentProperty, VerticalAlignment.Center);
        face.AppendChild(presenter);
        button.Template = new ControlTemplate(typeof(Button)) { VisualTree = face };
        void Hover(bool on, bool pressed = false)
        {
            if (!on) { button.Background = Brushes.Transparent; button.SetResourceReference(ForegroundProperty, "Ink"); return; }
            if (hot is not null) { button.Background = pressed ? Frozen(Color.FromRgb(148, 31, 20)) : hot; button.Foreground = Brushes.White; }
            else { var ink = ((SolidColorBrush)Resources["Ink"]).Color; button.Background = Frozen(Color.FromArgb(pressed ? (byte)36 : (byte)20, ink.R, ink.G, ink.B)); }
        }
        button.MouseEnter += (_, _) => Hover(true); button.MouseLeave += (_, _) => Hover(false);
        button.PreviewMouseLeftButtonDown += (_, _) => Hover(true, true); button.PreviewMouseLeftButtonUp += (_, _) => Hover(button.IsMouseOver);
        button.Tag = (Action<bool, bool>)Hover;
        return button;
    }

    void ToggleMaximize() => WindowState = WindowState == WindowState.Maximized ? WindowState.Normal : WindowState.Maximized;

    /// Inactive windows dim their caption glyphs, as Windows does.
    void TintCaption() { foreach (var button in new[] { minimize, maximize, close }) button.Opacity = IsActive ? 1 : 0.45; }

    /// Tells Windows the maximize button sits under the pointer, so Windows 11 opens its snap layouts there; the click is then handled here.
    IntPtr CaptionHook(IntPtr window, int message, IntPtr wParam, IntPtr lParam, ref bool handled)
    {
        const int HitTest = 0x84, NcMouseMove = 0xA0, NcLeftDown = 0xA1, NcLeftUp = 0xA2, NcMouseLeave = 0x2A2, MaxButton = 9;
        var hover = (Action<bool, bool>)maximize.Tag;
        switch (message)
        {
            case HitTest when OverMaximize(lParam): handled = true; return MaxButton;
            case NcMouseMove when wParam == MaxButton: hover(true, false); handled = true; break;
            case NcLeftDown when wParam == MaxButton: hover(true, true); handled = true; break;
            case NcLeftUp when wParam == MaxButton: hover(false, false); ToggleMaximize(); handled = true; break;
            case NcMouseLeave: case NcMouseMove: hover(false, false); break;
        }
        return IntPtr.Zero;
    }

    bool OverMaximize(IntPtr lParam)
    {
        if (!maximize.IsVisible) return false;
        var value = lParam.ToInt64();
        var point = maximize.PointFromScreen(new Point((short)(value & 0xFFFF), (short)((value >> 16) & 0xFFFF)));
        return point.X >= 0 && point.Y >= 0 && point.X < maximize.ActualWidth && point.Y < maximize.ActualHeight;
    }

    /// Drags the window from Prism's own title areas; a double-click zooms, like the Mac title bar.
    internal void DragFrom(MouseButtonEventArgs args)
    {
        if (args.ChangedButton != MouseButton.Left) return;
        if (args.ClickCount == 2) ToggleMaximize();
        else if (args.ButtonState == MouseButtonState.Pressed) { try { DragMove(); } catch (InvalidOperationException) { } }
    }

    /// A maximized custom-chrome window spills past the screen by its frame width; pad it back in.
    void FitMaximized()
    {
        var frame = SystemParameters.WindowResizeBorderThickness;
        ((FrameworkElement)Content).Margin = WindowState == WindowState.Maximized ? new Thickness(frame.Left + 4, frame.Top + 4, frame.Right + 4, frame.Bottom + 4) : new Thickness(0);
    }

    [System.Runtime.InteropServices.DllImport("dwmapi.dll")]
    static extern int DwmSetWindowAttribute(IntPtr window, int attribute, ref int value, int size);

    /// Paints the Windows title bar in the app's colors (Windows 11), and dark when the theme is dark (Windows 10 too).
    void TintTitleBar()
    {
        var handle = new System.Windows.Interop.WindowInteropHelper(this).Handle;
        if (handle == IntPtr.Zero) return;
        static int Ref(Color color) => color.R | color.G << 8 | color.B << 16;
        var dark = session.Settings.Appearance == "light" ? 0 : 1;
        var caption = Ref(((SolidColorBrush)Resources["Surface1"]).Color);
        var text = Ref(((SolidColorBrush)Resources["Ink"]).Color);
        var border = Ref(((SolidColorBrush)Resources["Line"]).Color);
        _ = DwmSetWindowAttribute(handle, 20, ref dark, sizeof(int));
        _ = DwmSetWindowAttribute(handle, 35, ref caption, sizeof(int));
        _ = DwmSetWindowAttribute(handle, 36, ref text, sizeof(int));
        _ = DwmSetWindowAttribute(handle, 34, ref border, sizeof(int));
        var round = 2; _ = DwmSetWindowAttribute(handle, 33, ref round, sizeof(int));
    }

    Task ChooseVideo()
    {
        if (session.IsBusy) return Task.CompletedTask;
        var dialog = new Microsoft.Win32.OpenFileDialog { Title = "Choose your long video", Filter = "Video files|*.mov;*.mp4;*.m4v;*.avi;*.mkv;*.webm|All files|*.*" };
        return dialog.ShowDialog(this) == true ? ImportTyped(dialog.FileName) : Task.CompletedTask;
    }
    string? ChooseFolder(string title)
    {
        var dialog = new Microsoft.Win32.OpenFolderDialog { Title = title, Multiselect = false };
        return dialog.ShowDialog(this) == true ? dialog.FolderName : null;
    }

    static SolidColorBrush Frozen(Color color) { var brush = new SolidColorBrush(color); brush.Freeze(); return brush; }
    static StackPanel Column(params UIElement[] children)
    {
        var panel = new StackPanel(); foreach (var child in children) panel.Children.Add(child); return panel;
    }
    static StackPanel Row(params UIElement[] children)
    {
        var panel = new StackPanel { Orientation = Orientation.Horizontal }; foreach (var child in children) panel.Children.Add(child); return panel;
    }
    static TextBlock Text(string text, double size = 13, bool muted = false, bool display = false, bool mono = false)
    {
        var label = new TextBlock { Text = text, FontSize = size, TextWrapping = TextWrapping.Wrap, Margin = new Thickness(0, 4, 0, 5), VerticalAlignment = VerticalAlignment.Center };
        label.SetResourceReference(TextBlock.ForegroundProperty, muted ? "Muted" : "Ink");
        label.SetResourceReference(TextBlock.FontFamilyProperty, display ? "DisplayFont" : mono ? "MonoFont" : "UiFont");
        label.FontWeight = display ? FontWeights.Medium : FontWeights.Normal;
        return label;
    }
    /// Text that takes its color and font from the control it sits in, so primary buttons keep ink text.
    static TextBlock Label(string text, double size = 0)
    {
        var label = new TextBlock { Text = text, VerticalAlignment = VerticalAlignment.Center, TextTrimming = TextTrimming.CharacterEllipsis };
        if (size > 0) label.FontSize = size;
        return label;
    }
    /// A Segoe Fluent glyph; without a brush key it follows the surrounding foreground.
    static TextBlock Glyph(string glyph, double size = 14, string? brush = null)
    {
        var icon = new TextBlock { Text = glyph, FontFamily = new FontFamily(IconFont), FontSize = size, VerticalAlignment = VerticalAlignment.Center, HorizontalAlignment = HorizontalAlignment.Center };
        if (brush is not null) icon.SetResourceReference(TextBlock.ForegroundProperty, brush);
        return icon;
    }
    /// The Prism mark: amber and coral faces over a Sky base, the same geometry as the Mac app's mark.
    internal static FrameworkElement Mark(double height)
    {
        var canvas = new Canvas { Width = 184, Height = 202 };
        Point P(double x, double y) => new(x * 184, y * 202);
        void Face(string color, params Point[] points)
        {
            var polygon = new Polygon { Fill = Frozen((Color)ColorConverter.ConvertFromString(color)) };
            foreach (var point in points) polygon.Points.Add(point);
            canvas.Children.Add(polygon);
        }
        Point apex = P(0.5, 0), left = P(0, 0.797), right = P(1, 0.797), center = P(0.5, 0.545), bottom = P(0.5, 1);
        Face("#FFC233", apex, left, center); Face("#FF6B57", apex, right, center);
        Face("#3FA9F5", left, center, right); Face("#3996DA", left, right, bottom);
        return new Viewbox { Child = canvas, Height = height, VerticalAlignment = VerticalAlignment.Center };
    }
    static Border Divider(Thickness margin)
    {
        var line = new Border { Height = 1, Margin = margin }; line.SetResourceReference(Border.BackgroundProperty, "Line"); return line;
    }
    /// The Mac's plus.square.fill: an ink tile with a Sky plus, for Create on the Sky fill.
    internal static Border PlusTile(double size, double glyph)
    {
        var plus = Glyph("\uE710", glyph); plus.SetResourceReference(TextBlock.ForegroundProperty, "Action"); plus.FontWeight = FontWeights.Bold;
        return new Border { Width = size, Height = size, CornerRadius = new CornerRadius(size / 5), Background = OnAction, Child = plus, VerticalAlignment = VerticalAlignment.Center };
    }

    /// A Mac-style check: a ring, filled with a check when selected.
    internal static Grid CheckCircle(bool selected)
    {
        var host = new Grid { Width = 18, Height = 18, VerticalAlignment = VerticalAlignment.Center };
        var circle = new Ellipse { StrokeThickness = 1.5 };
        if (selected) { circle.SetResourceReference(Shape.FillProperty, "Accent"); circle.SetResourceReference(Shape.StrokeProperty, "Accent"); }
        else circle.SetResourceReference(Shape.StrokeProperty, "Muted");
        host.Children.Add(circle);
        if (selected) host.Children.Add(Glyph("", 10, "Surface1"));
        return host;
    }
    /// Columns of at least `min` wide that share the row, like SwiftUI's adaptive grid.
    internal static WrapPanel AdaptiveGrid(double min, IEnumerable<UIElement> items, double spacing = 12)
    {
        var grid = new WrapPanel();
        foreach (var item in items) { if (item is FrameworkElement element) element.Margin = new Thickness(0, 0, spacing, spacing); grid.Children.Add(item); }
        grid.SizeChanged += (_, args) =>
        {
            if (!args.WidthChanged || args.NewSize.Width <= 0) return;
            var columns = Math.Max(1, (int)((args.NewSize.Width + spacing) / (min + spacing)));
            grid.ItemWidth = Math.Floor(args.NewSize.Width / columns);
        };
        return grid;
    }
    Button Button(string title, Action action, bool primary = false, bool danger = false, string? icon = null)
    {
        var button = NewButton(title, primary, danger, icon);
        button.Click += (_, _) => { try { action(); } catch (Exception error) { ShowNotice("Could not complete action", error.Message); } };
        return button;
    }
    Button Button(string title, Func<Task> action, bool primary = false, bool danger = false, string? icon = null)
    {
        var button = NewButton(title, primary, danger, icon);
        button.Click += async (_, _) => { try { await action(); } catch (Exception error) { ShowNotice("Could not complete action", error.Message); } };
        return button;
    }
    static Button NewButton(string title, bool primary, bool danger, string? icon = null)
    {
        var button = new Button { Margin = new Thickness(0, 4, 8, 4), Padding = new Thickness(16, 0, 16, 0), MinHeight = 40, FontSize = 14, HorizontalAlignment = HorizontalAlignment.Left };
        if (icon is null) button.Content = title;
        else { var mark = Glyph(icon, 12); mark.Margin = new Thickness(0, 0, 8, 0); button.Content = Row(mark, Label(title)); }
        if (primary) { button.SetResourceReference(Control.BackgroundProperty, "Action"); button.SetResourceReference(Control.BorderBrushProperty, "Action"); button.Foreground = OnAction; }
        if (danger) button.SetResourceReference(Control.ForegroundProperty, "Coral");
        return button;
    }
    /// No outline until hovered: the Mac app's ghost buttons.
    static Button Ghost(Button button) { button.BorderBrush = Brushes.Transparent; return button; }
    /// Small text or icon buttons: muted, compact, a soft fill on hover.
    static Button Link(Button button)
    {
        button.BorderBrush = Brushes.Transparent; button.MinHeight = 0; button.Padding = new Thickness(8, 5, 8, 5); button.FontSize = 13;
        button.HorizontalAlignment = HorizontalAlignment.Left; button.SetResourceReference(Control.ForegroundProperty, "Muted");
        return button;
    }
    static TextBox Entry(string value, string placeholder, Action<string>? changed = null)
    {
        var entry = new TextBox { Text = value, Tag = placeholder, MinWidth = 80, Margin = new Thickness(0, 4, 8, 4), Padding = new Thickness(10) };
        AutomationProperties.SetName(entry, placeholder);
        if (changed is not null) entry.TextChanged += (_, _) => changed(entry.Text);
        return entry;
    }
    static Border Card(params UIElement[] children)
    {
        var border = new Border { Child = Column(children), CornerRadius = new CornerRadius(16), BorderThickness = new Thickness(1), Padding = new Thickness(20), Margin = new Thickness(0, 0, 0, 16) };
        border.SetResourceReference(Border.BackgroundProperty, "Surface1"); border.SetResourceReference(Border.BorderBrushProperty, "Line");
        return border;
    }
    /// A borderless page panel: Surface1 on the page, the Mac app's cards.
    static Border Surface(UIElement child, double radius = 16, double padding = 18)
    {
        var border = new Border { Child = child, CornerRadius = new CornerRadius(radius), Padding = new Thickness(padding) };
        border.SetResourceReference(Border.BackgroundProperty, "Surface1");
        return border;
    }
    static ScrollViewer Scroll(UIElement child) => new() { Content = child, VerticalScrollBarVisibility = ScrollBarVisibility.Auto, HorizontalScrollBarVisibility = ScrollBarVisibility.Disabled };
    static StackPanel Field(string title, UIElement child) => Column(Text(title, 12, muted: true), child);
    static Grid SplitRow(UIElement left, UIElement right)
    {
        var row = new Grid { Margin = new Thickness(0, 4, 0, 4) };
        row.ColumnDefinitions.Add(new ColumnDefinition()); row.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        row.Children.Add(left); Grid.SetColumn(right, 1); row.Children.Add(right); return row;
    }
    static ComboBox Combo(IEnumerable<string> values, int selected, Action<int> changed)
    {
        var combo = new ComboBox { Margin = new Thickness(0, 4, 8, 4), MinWidth = 130, Padding = new Thickness(8) };
        foreach (var value in values) combo.Items.Add(value);
        combo.SelectedIndex = selected;
        combo.SelectionChanged += (_, _) => changed(combo.SelectedIndex);
        return combo;
    }
    static Image Picture(byte[] bytes, double width, double height)
    {
        var image = new BitmapImage();
        using (var stream = new MemoryStream(bytes)) { image.BeginInit(); image.CacheOption = BitmapCacheOption.OnLoad; image.StreamSource = stream; image.EndInit(); }
        image.Freeze();
        return new Image { Source = image, Width = width, Height = height, Stretch = Stretch.UniformToFill };
    }
    static UIElement BrandMark()
    {
        var mark = Mark(26); mark.Margin = new Thickness(0, 0, 10, 0);
        var name = Text("Prism", 22, display: true); name.Margin = new Thickness(0);
        return Row(mark, name);
    }
    void DisposeSession()
    {
        if (disposed) return; disposed = true;
        resourceTimer.Stop(); activityTimer.Stop(); session.PropertyChanged -= SessionChanged; editor.Dispose(); session.Dispose();
    }
}
