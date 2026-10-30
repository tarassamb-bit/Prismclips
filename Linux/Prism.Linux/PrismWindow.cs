using System.ComponentModel;
using System.Globalization;
using Prism.Core;

namespace Prism.Linux;

/// <summary>The GTK shell keeps text controls alive while the shared session reports progress.</summary>
public sealed partial class PrismWindow : IDisposable
{
    readonly Gtk.ApplicationWindow window;
    readonly AppSession session;
    readonly LinuxEditor editor;
    readonly SynchronizationContext? ui;
    readonly Gtk.Box layout = Gtk.Box.New(Gtk.Orientation.Horizontal, 0);
    readonly Gtk.Box main = Gtk.Box.New(Gtk.Orientation.Vertical, 0);
    readonly Gtk.Box content = Gtk.Box.New(Gtk.Orientation.Vertical, 0);
    readonly Gtk.Box sidebar = Gtk.Box.New(Gtk.Orientation.Vertical, 0);
    readonly Gtk.Box top = Gtk.Box.New(Gtk.Orientation.Horizontal, 12);
    readonly Gtk.Overlay overlay = Gtk.Overlay.New();
    readonly Gtk.Label heading = Label("Home", "d18");
    readonly Gtk.Label status = Label("", "muted");
    readonly Gtk.Spinner busy = Gtk.Spinner.New();
    Gtk.Label memoryLabel = Gtk.Label.New(""), storageLabel = Gtk.Label.New(""), ringLabel = Gtk.Label.New("");
    Gtk.ProgressBar memoryBar = Gtk.ProgressBar.New(), storageBar = Gtk.ProgressBar.New();
    readonly Dictionary<Screen, Gtk.Button> navigation = [];
    readonly Gtk.CssProvider css = Gtk.CssProvider.New();
    System.Threading.Timer? resourceTimer;
    System.Threading.Timer? activityTimer;
    string renderedScreen = "", renderedPage = "";
    string modalKind = "";
    Gtk.Widget? modal;
    Gtk.Box? localCard;
    bool queued, disposed, showAll, showUnfinished, sidebarCollapsed;
    Guid? openFolder;
    int createStep, settingsCategory;
    long homeRevision;
    string lastMessage = "";
    Action? updateScreen, updateModal;
    readonly Dictionary<string, ProjectSummary> summaries = [];

    public PrismWindow(Gtk.Application application)
    {
        ui = SynchronizationContext.Current;
        LinuxPlatform.RegisterFonts();
        session = new AppSession(new LinuxPlatform());
        window = Gtk.ApplicationWindow.New(application);
        window.Title = "Prism";
        window.SetDefaultSize(1440, 920);
        window.SetSizeRequest(900, 620);
        // A themed title bar in Prism's colours, with the desktop's own window buttons, instead of the system's grey bar.
        var titlebar = Gtk.HeaderBar.New();
        titlebar.AddCssClass("prism-titlebar");
        titlebar.TitleWidget = Label("Prism", "muted", "t12", "medium");
        window.SetTitlebar(titlebar);
        editor = new LinuxEditor(session, window, AppearanceSwitch);
        editor.Error += message => ShowNotice("Could not complete action", message);
        ApplyTheme();
        sidebar.AddCssClass("sidebar");
        sidebar.Hexpand = false;
        BuildSidebar();
        top.AddCssClass("topbar");
        heading.MarginEnd = 20;
        status.Hexpand = true;
        status.Xalign = 1;
        status.Ellipsize = Pango.EllipsizeMode.End;
        top.Append(heading);
        top.Append(status);
        top.Append(busy);
        top.Append(AppearanceSwitch());
        main.Hexpand = true;
        main.Vexpand = true;
        content.Hexpand = true;
        content.Vexpand = true;
        main.Append(top);
        main.Append(content);
        layout.Append(sidebar);
        layout.Append(main);
        overlay.Child = layout;
        window.Child = overlay;
        var shortcuts = Gtk.EventControllerKey.New();
        shortcuts.OnKeyPressed += (_, args) =>
        {
            if (args.Keyval == 0xff1b) return Dismiss();
            if (args.Keyval is not ('n' or 'N') || (args.State & Gdk.ModifierType.ControlMask) == 0 || session.Screen != Screen.Home || session.IsBusy || modalKind.Length > 0) return false;
            StartCreate();
            return true;
        };
        window.AddController(shortcuts);
        session.PropertyChanged += SessionChanged;
        window.OnCloseRequest += (_, _) => { Dispose(); return false; };
        RestartResourceTimer();
        activityTimer = new System.Threading.Timer(_ => OnUI(() =>
        {
            if (!disposed && modalKind is "progress" or "working" or "testing") updateModal?.Invoke();
        }), null, TimeSpan.FromSeconds(1), TimeSpan.FromSeconds(1));
        Refresh();
    }

    public void Present() => window.Present();

    void SessionChanged(object? sender, PropertyChangedEventArgs args)
    {
        if (args.PropertyName is nameof(AppSession.ProjectListRevision) or nameof(AppSession.RecentProjectPaths) or nameof(AppSession.ProjectFolders) or nameof(AppSession.Project))
        { homeRevision++; summaries.Clear(); }
        if (queued || disposed) return;
        queued = true;
        OnUI(() => { queued = false; if (!disposed) Refresh(); });
    }

    void OnUI(Action action)
    {
        if (ui is null) action();
        else ui.Post(_ => action(), null);
    }

    void Refresh()
    {
        heading.SetText(session.Screen switch
        {
            Screen.Home => "Home", Screen.Settings => "Settings", Screen.Create or Screen.ImportSource => "Create Shorts",
            _ => session.Project?.DisplayTitle ?? "Editor",
        });
        // Like the Mac app, only the import flow shows the running status line; elsewhere errors arrive as notices.
        status.SetText(session.Screen is Screen.Create or Screen.ImportSource ? session.Message : "");
        busy.Visible = session.IsBusy;
        busy.Spinning = session.IsBusy;
        var editing = session.Screen == Screen.Editor;
        sidebar.Visible = top.Visible = !editing;
        foreach (var (screen, button) in navigation)
        {
            button.Sensitive = !session.IsBusy;
            if (screen == Screen.ImportSource) continue;
            if (session.Screen == screen) button.AddCssClass("selected"); else button.RemoveCssClass("selected");
            if (screen == Screen.Editor) button.Visible = session.Project is not null;
        }
        var key = session.Screen switch
        {
            Screen.Home => $"home:{homeRevision}:{showAll}:{showUnfinished}:{openFolder}",
            Screen.Create or Screen.ImportSource => $"create:{createStep}:{session.ShortsSource?.Id}",
            Screen.Settings => $"settings:{settingsCategory}:{session.Account.IsSignedIn}",
            _ => "editor",
        };
        if (key != renderedScreen)
        {
            renderedScreen = key;
            updateScreen = null;
            var page = session.Screen.ToString();
            ClearContent();
            var child = session.Screen switch
            {
                Screen.Home => Home(),
                Screen.Create or Screen.ImportSource => CreateFlow(),
                Screen.Settings => SettingsPage(),
                _ => editor.Widget,
            };
            // A short crossfade when the page itself changes, like the Mac app's screen transitions; re-renders of the same page stay still.
            var fade = Gtk.Revealer.New();
            fade.TransitionType = Gtk.RevealerTransitionType.Crossfade;
            fade.TransitionDuration = page == renderedPage ? 0u : 160u;
            fade.Hexpand = fade.Vexpand = true;
            fade.Child = child;
            content.Append(fade);
            renderedPage = page;
            OnUI(() => fade.RevealChild = true);
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
    }

    void Navigate(Screen screen)
    {
        if (session.IsBusy) return;
        createStep = 0;
        session.Screen = screen;
        Refresh();
    }

    void StartCreate()
    {
        createStep = 0;
        session.StartLongVideoToShort();
        Refresh();
    }

    void InvalidateScreen() { renderedScreen = ""; Refresh(); }

    void BuildSidebar()
    {
        Clear(sidebar);
        navigation.Clear();
        sidebar.SetSizeRequest(sidebarCollapsed ? 76 : 252, -1);
        sidebar.MarginStart = 0;
        var upper = Column(6);
        if (sidebarCollapsed)
        {
            var expand = IconButton("sidebar-show-symbolic", "Expand sidebar", () => { sidebarCollapsed = false; BuildSidebar(); Refresh(); });
            expand.Halign = Gtk.Align.Center;
            upper.Append(expand);
        }
        else
        {
            var brand = Row(10);
            brand.Append(Mark(24));
            var name = Label("Prism", "d24");
            name.Hexpand = true;
            brand.Append(name);
            brand.Append(IconButton("sidebar-show-symbolic", "Collapse sidebar", () => { sidebarCollapsed = true; BuildSidebar(); Refresh(); }));
            upper.Append(brand);
            var tagline = Label("Your video editor · Cloud AI", "muted");
            tagline.MarginTop = 6;
            upper.Append(tagline);
        }
        var rule = Divider();
        rule.MarginTop = 16;
        rule.MarginBottom = 16;
        upper.Append(rule);
        upper.Append(NavItem("go-home-symbolic", "Home", Screen.Home, () => Navigate(Screen.Home)));
        upper.Append(NavItem("list-add-symbolic", "Create Shorts", Screen.ImportSource, StartCreate, prominent: true));
        upper.Append(NavItem("video-x-generic-symbolic", "Editor", Screen.Editor, () => Navigate(Screen.Editor)));
        sidebar.Append(upper);
        sidebar.Append(Spacer());
        sidebar.Append(NavItem("emblem-system-symbolic", "Settings", Screen.Settings, () => Navigate(Screen.Settings)));
        sidebar.Append(sidebarCollapsed ? RamRing() : ResourceSummary());
        RestartResourceTimer();
    }

    Gtk.Button NavItem(string icon, string title, Screen screen, Action action, bool prominent = false)
    {
        var button = Gtk.Button.New();
        button.AddCssClass("nav");
        if (prominent) button.AddCssClass("prominent");
        button.TooltipText = title;
        Gtk.Widget mark = prominent ? PlusTile(16) : Icon(icon, 16);
        if (sidebarCollapsed) button.Child = mark;
        else
        {
            var row = Row(12);
            row.Append(mark);
            row.Append(Label(title));
            button.Child = row;
        }
        button.OnClicked += (_, _) =>
        {
            try { action(); }
            catch (Exception error) { ShowNotice("Could not complete action", error.Message); }
        };
        navigation[screen] = button;
        return button;
    }

    Gtk.Widget ResourceSummary()
    {
        var panel = Column(6);
        panel.MarginTop = 17;
        panel.TooltipText = "RAM and available storage refresh at the interval set in Settings";
        var title = Label("System resources", "muted", "t11", "medium");
        title.MarginBottom = 4;
        panel.Append(title);
        memoryLabel = Label("", "mono");
        storageLabel = Label("", "mono");
        memoryBar = Gtk.ProgressBar.New();
        storageBar = Gtk.ProgressBar.New();
        panel.Append(ResourceLine("drive-harddisk-solidstate-symbolic", "RAM used", memoryLabel));
        panel.Append(memoryBar);
        var gap = Column(0); gap.MarginTop = 6; panel.Append(gap);
        panel.Append(ResourceLine("drive-harddisk-symbolic", "Storage free", storageLabel));
        panel.Append(storageBar);
        return panel;
    }

    static Gtk.Box ResourceLine(string icon, string title, Gtk.Label value)
    {
        var line = Row(6);
        var mark = Icon(icon, 12);
        mark.AddCssClass("muted");
        line.Append(mark);
        var label = Label(title, "muted", "t11", "medium");
        label.Hexpand = true;
        line.Append(label);
        line.Append(value);
        return line;
    }

    /// The collapsed sidebar shows RAM as a ring, like the Mac app.
    Gtk.Widget RamRing()
    {
        memoryLabel = Gtk.Label.New(""); storageLabel = Gtk.Label.New(""); memoryBar = Gtk.ProgressBar.New(); storageBar = Gtk.ProgressBar.New();
        ringLabel = Label("", "display", "t9");
        ringLabel.Xalign = 0.5f;
        ringLabel.Justify = Gtk.Justification.Center;
        var ring = Gtk.DrawingArea.New();
        ring.ContentWidth = 44;
        ring.ContentHeight = 44;
        ring.SetDrawFunc((_, cr, width, height) =>
        {
            var used = Math.Clamp(memoryBar.Fraction, 0, 1);
            var (line, ink) = session.Settings.Appearance == "light" ? ((0.886, 0.871, 0.831), (0.055, 0.059, 0.078)) : ((0.173, 0.184, 0.216), (0.965, 0.953, 0.925));
            cr.LineWidth = 4;
            cr.SetSourceRgb(line.Item1, line.Item2, line.Item3);
            cr.Arc(width / 2.0, height / 2.0, 20, 0, 2 * Math.PI); cr.Stroke();
            cr.SetSourceRgb(ink.Item1, ink.Item2, ink.Item3);
            cr.LineCap = Cairo.LineCap.Round;
            cr.Arc(width / 2.0, height / 2.0, 20, -Math.PI / 2, -Math.PI / 2 + used * 2 * Math.PI); cr.Stroke();
        });
        var host = Gtk.Overlay.New();
        host.Child = ring;
        ringLabel.Halign = Gtk.Align.Center;
        ringLabel.Valign = Gtk.Align.Center;
        host.AddOverlay(ringLabel);
        host.Halign = Gtk.Align.Center;
        host.MarginTop = 17;
        memoryBar.OnNotify += (_, _) => ring.QueueDraw();
        return host;
    }

    void RestartResourceTimer()
    {
        resourceTimer?.Dispose();
        var seconds = Math.Clamp(session.Settings.ResourceRefreshSeconds, 1, 3600);
        resourceTimer = new System.Threading.Timer(_ =>
        {
            var profile = MachineProfile.Detect();
            OnUI(() =>
            {
                if (disposed) return;
                memoryLabel.SetText(string.Create(CultureInfo.InvariantCulture, $"{profile.MemoryUsedGB:0.0} / {profile.MemoryGB} GB"));
                storageLabel.SetText($"{profile.FreeGB} / {profile.StorageGB} GB");
                memoryBar.Fraction = profile.MemoryUsage;
                storageBar.Fraction = profile.FreeStorageRatio;
                ringLabel.SetText($"{(int)(profile.MemoryUsage * 100)}%\nRAM");
                ringLabel.TooltipText = string.Create(CultureInfo.InvariantCulture, $"RAM used: {profile.MemoryUsedGB:0.0} of {profile.MemoryGB} GB · Storage free: {profile.FreeGB} of {profile.StorageGB} GB");
            });
        }, null, TimeSpan.Zero, TimeSpan.FromSeconds(seconds));
    }

    /// The dark/light switch: two segments in a pill, shared with the editor header.
    Gtk.Widget AppearanceSwitch()
    {
        var pill = Row(2);
        pill.AddCssClass("pill");
        pill.Valign = Gtk.Align.Center;
        foreach (var (mode, glyph, title) in new[] { ("dark", "☾", "Dark mode"), ("light", "☀", "Light mode") })
        {
            var button = Gtk.Button.NewWithLabel(glyph);
            button.TooltipText = title;
            button.OnClicked += (_, _) => { session.Settings.Appearance = mode; session.Settings.Save(); ApplyTheme(); };
            void Update()
            {
                if ((session.Settings.Appearance == "light" ? "light" : "dark") == mode) button.AddCssClass("selected"); else button.RemoveCssClass("selected");
            }
            Update();
            appearanceUpdates.Add(Update);
            pill.Append(button);
        }
        return pill;
    }

    async Task ChooseVideo()
    {
        if (session.IsBusy) return;
        try
        {
            var dialog = Gtk.FileDialog.New();
            dialog.Title = "Choose your long video";
            var file = await dialog.OpenAsync(window);
            if (file?.GetPath() is { } path) { createStep = 0; await session.ImportSource(path); Refresh(); }
        }
        catch (Exception error) when (error.Message.Contains("dismiss", StringComparison.OrdinalIgnoreCase) || error.Message.Contains("cancel", StringComparison.OrdinalIgnoreCase)) { }
        catch (Exception error) { ShowNotice("Could not open video", error.Message); }
    }

    async Task<string?> ChooseFolder(string title)
    {
        try
        {
            var dialog = Gtk.FileDialog.New();
            dialog.Title = title;
            var file = await dialog.SelectFolderAsync(window);
            return file?.GetPath();
        }
        catch (Exception error) when (error.Message.Contains("dismiss", StringComparison.OrdinalIgnoreCase) || error.Message.Contains("cancel", StringComparison.OrdinalIgnoreCase)) { return null; }
        catch (Exception error) { session.Message = error.Message; return null; }
    }

    static Gtk.Box Column(int spacing = 12) => Gtk.Box.New(Gtk.Orientation.Vertical, spacing);
    static Gtk.Box Row(int spacing = 8) => Gtk.Box.New(Gtk.Orientation.Horizontal, spacing);
    static Gtk.Box Spacer() { var box = Column(0); box.Hexpand = true; box.Vexpand = true; return box; }
    /// Pushes the next items in a row to the right without stretching the row vertically.
    static Gtk.Box Gap() { var box = Column(0); box.Hexpand = true; return box; }
    static Gtk.Box Divider() { var line = Column(0); line.AddCssClass("divider"); return line; }
    /// Wrapping text, for paragraphs.
    static Gtk.Label Text(string text, params string[] classes)
    {
        var label = Label(text, classes);
        label.Wrap = true;
        label.WrapMode = Pango.WrapMode.WordChar;
        label.MaxWidthChars = 70;
        return label;
    }
    /// One-line text, for names and controls.
    static Gtk.Label Label(string text, params string[] classes)
    {
        var label = Gtk.Label.New(text);
        label.Xalign = 0;
        foreach (var name in classes) label.AddCssClass(name);
        return label;
    }
    static Gtk.Image Icon(string name, int size = 16)
    {
        var image = Gtk.Image.NewFromIconName(name);
        image.PixelSize = size;
        return image;
    }
    /// The Mac's plus.square.fill: an ink tile with a Sky plus.
    static Gtk.Widget PlusTile(int size)
    {
        var tile = Gtk.CenterBox.New();
        tile.AddCssClass("plus-tile");
        tile.SetSizeRequest(size, size);
        tile.Valign = Gtk.Align.Center;
        tile.Halign = Gtk.Align.Start;
        var plus = Label("+", size >= 24 ? "t16" : "t12");
        tile.CenterWidget = plus;
        return tile;
    }
    /// The Prism mark: amber and coral faces over a Sky base, the same geometry as the Mac app's mark.
    internal static Gtk.Widget Mark(int height)
    {
        var area = Gtk.DrawingArea.New();
        area.ContentHeight = height;
        area.ContentWidth = (int)Math.Round(height * 184.0 / 202.0);
        area.Valign = Gtk.Align.Center;
        area.SetDrawFunc((_, cr, width, h) =>
        {
            void Face(double r, double g, double b, params (double X, double Y)[] points)
            {
                cr.SetSourceRgb(r, g, b);
                cr.MoveTo(points[0].X * width, points[0].Y * h);
                foreach (var point in points.Skip(1)) cr.LineTo(point.X * width, point.Y * h);
                cr.ClosePath(); cr.Fill();
            }
            (double, double) apex = (0.5, 0), left = (0, 0.797), right = (1, 0.797), center = (0.5, 0.545), bottom = (0.5, 1);
            Face(1, 0.761, 0.2, apex, left, center);
            Face(1, 0.420, 0.341, apex, right, center);
            Face(0.247, 0.663, 0.961, left, center, right);
            Face(0.224, 0.588, 0.855, left, right, bottom);
        });
        return area;
    }
    Gtk.Button Button(string title, Action action, string? cssClass = null)
    {
        var button = Gtk.Button.NewWithLabel(title);
        Style(button, cssClass);
        button.OnClicked += (_, _) =>
        {
            try { action(); }
            catch (Exception error) { ShowNotice("Could not complete action", error.Message); }
        };
        return button;
    }
    Gtk.Button Button(string title, Func<Task> action, string? cssClass = null)
    {
        var button = Gtk.Button.NewWithLabel(title);
        Style(button, cssClass);
        button.OnClicked += async (_, _) =>
        {
            try { await action(); }
            catch (Exception error) { ShowNotice("Could not complete action", error.Message); }
        };
        return button;
    }
    /// Buttons keep their natural width, as on the Mac; classes are space-separated.
    static void Style(Gtk.Button button, string? cssClass)
    {
        button.Halign = Gtk.Align.Start;
        foreach (var name in (cssClass ?? "").Split(' ', StringSplitOptions.RemoveEmptyEntries)) button.AddCssClass(name);
    }
    /// A button with a leading icon.
    Gtk.Button IconText(string icon, string title, Action action, string? cssClass = null)
    {
        var button = Button("", action, cssClass);
        var row = Row(8);
        row.Append(Icon(icon, 14));
        row.Append(Label(title));
        button.Child = row;
        return button;
    }
    Gtk.Button IconButton(string icon, string title, Action action)
    {
        var button = Button("", action, "icon link");
        button.Child = Icon(icon, 16);
        button.TooltipText = title;
        return button;
    }
    static Gtk.Entry Entry(string value, string placeholder, Action<string>? changed = null)
    {
        var entry = Gtk.Entry.New();
        entry.SetText(value);
        entry.PlaceholderText = placeholder;
        entry.Hexpand = true;
        if (changed is not null) entry.OnChanged += (_, _) => changed(entry.GetText());
        return entry;
    }
    static Gtk.Box Card(params Gtk.Widget[] children)
    {
        var card = Column(12);
        card.AddCssClass("card");
        foreach (var child in children) card.Append(child);
        return card;
    }
    /// A borderless page panel: Surface1 on the page, the Mac app's cards.
    static Gtk.Box Surface(int spacing, params Gtk.Widget[] children)
    {
        var panel = Column(spacing);
        panel.AddCssClass("surface");
        foreach (var child in children) panel.Append(child);
        return panel;
    }
    static Gtk.ScrolledWindow Scroll(Gtk.Widget child)
    {
        var scrolled = Gtk.ScrolledWindow.New();
        scrolled.Child = child;
        scrolled.Hexpand = true;
        scrolled.Vexpand = true;
        scrolled.SetPolicy(Gtk.PolicyType.Never, Gtk.PolicyType.Automatic);
        return scrolled;
    }
    static void Clear(Gtk.Box box) { while (box.GetFirstChild() is { } child) box.Remove(child); }
    /// The editor widget outlives its page, so it is detached from the old fade before the fade goes.
    void ClearContent()
    {
        while (content.GetFirstChild() is { } child)
        {
            if (child is Gtk.Revealer fade) fade.Child = null;
            content.Remove(child);
        }
    }
    static Gtk.ComboBoxText Combo(IEnumerable<string> values, int selected, Action<int> changed)
    {
        var combo = Gtk.ComboBoxText.New();
        foreach (var value in values) combo.AppendText(value);
        combo.Active = selected;
        combo.Halign = Gtk.Align.Start;
        combo.OnChanged += (_, _) => changed(combo.Active);
        return combo;
    }
    /// A picture whose natural size is exactly width × height: GTK otherwise asks for the full image size and stretches cards.
    static Gtk.Picture Thumbnail(byte[] bytes, int width, int height, bool fit = false)
    {
        var picture = Picture(Scaled(bytes, width, height, fit), width, height);
        picture.ContentFit = fit ? Gtk.ContentFit.Contain : Gtk.ContentFit.Cover;
        return picture;
    }

    /// The image redrawn at exactly width × height pixels, cropped to fill or fitted inside; GTK sizes a picture by its pixels.
    internal static byte[] Scaled(byte[] bytes, int width, int height, bool fit)
    {
        try
        {
            using var source = SkiaSharp.SKBitmap.Decode(bytes);
            if (source is not null)
            {
                using var target = new SkiaSharp.SKBitmap(width, height);
                using (var canvas = new SkiaSharp.SKCanvas(target))
                {
                    canvas.Clear(SkiaSharp.SKColors.Transparent);
                    var scale = fit ? Math.Min(target.Width / (float)source.Width, target.Height / (float)source.Height) : Math.Max(target.Width / (float)source.Width, target.Height / (float)source.Height);
                    var w = source.Width * scale; var h = source.Height * scale;
                    using var paint = new SkiaSharp.SKPaint { IsAntialias = true };
                    canvas.DrawImage(SkiaSharp.SKImage.FromBitmap(source), new SkiaSharp.SKRect((target.Width - w) / 2, (target.Height - h) / 2, (target.Width + w) / 2, (target.Height + h) / 2), new SkiaSharp.SKSamplingOptions(SkiaSharp.SKFilterMode.Linear), paint);
                }
                using var image = SkiaSharp.SKImage.FromBitmap(target);
                using var encoded = image.Encode(SkiaSharp.SKEncodedImageFormat.Png, 90);
                bytes = encoded.ToArray();
            }
        }
        catch (Exception) { }
        return bytes;
    }
    static Gtk.Picture Picture(byte[] bytes, int width, int height)
    {
        using var data = GLib.Bytes.New(bytes);
        var texture = Gdk.Texture.NewFromBytes(data);
        var picture = Gtk.Picture.NewForPaintable(texture);
        picture.SetSizeRequest(width, height);
        picture.CanShrink = true;
        picture.ContentFit = Gtk.ContentFit.Cover;
        return picture;
    }
    static Gtk.Widget BrandMark()
    {
        var row = Row(10);
        row.Append(Mark(26));
        row.Append(Label("Welcome to Prism", "d22"));
        return row;
    }

    public void Dispose()
    {
        if (disposed) return;
        disposed = true;
        resourceTimer?.Dispose();
        activityTimer?.Dispose();
        session.PropertyChanged -= SessionChanged;
        editor.Dispose();
        session.Dispose();
    }
}
