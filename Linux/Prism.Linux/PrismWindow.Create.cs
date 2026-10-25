using System.Globalization;
using System.Runtime.InteropServices;
using Prism.Core;

namespace Prism.Linux;

public sealed partial class PrismWindow
{
    Gtk.Widget CreateFlow()
    {
        var video = session.ShortsSource;
        var step = video is null ? 1 : Math.Clamp(createStep + 2, 2, 4);
        var page = Column(0);
        page.AddCssClass("section");
        page.MarginStart = page.MarginEnd = 30;
        var eyebrow = Label(step switch
        {
            1 => "Step 1 of 5 · Choose video", 2 => "Step 2 of 5 · Set up Shorts",
            3 => "Step 3 of 5 · Choose captions", _ => "Step 4 of 5 · Choose content type",
        }, "muted", "medium");
        var title = Text(step switch
        {
            1 => "Add your long video", 2 => "Choose your Short settings", 3 => "Choose your captions", _ => "What kind of video is it?",
        }, "d36");
        var subtitle = Text(step switch
        {
            1 => "Upload a video first. Then choose clip lengths and which part to analyze.",
            2 => "Your video is ready. Choose how to turn it into Shorts.",
            3 => "Pick how speech appears on your Shorts. You can change it for each Short in the editor.",
            _ => "This tells Prism what to look for and how to lay out each Short. You can change the layout for each Short in the editor.",
        }, "muted", "t16");
        foreach (var line in new[] { eyebrow, title, subtitle }) { line.Halign = Gtk.Align.Center; line.Xalign = 0.5f; line.Justify = Gtk.Justification.Center; }
        title.MarginTop = 8; subtitle.MarginTop = 8; subtitle.MarginBottom = 20;
        page.Append(eyebrow); page.Append(title); page.Append(subtitle);
        if (video is null) UploadStep(page);
        else if (step == 2) SettingsStep(page, video);
        else if (step == 3) CaptionStep(page);
        else TypeStep(page);
        var home = IconText("go-previous-symbolic", "Back to Home", () => Navigate(Screen.Home), "link");
        home.MarginTop = 20;
        page.Append(home);
        return Scroll(page);
    }

    void UploadStep(Gtk.Box page)
    {
        var upload = Column(12);
        upload.AddCssClass("dropzone");
        upload.SetSizeRequest(-1, 270);
        var inner = Column(10);
        inner.Valign = Gtk.Align.Center;
        inner.Vexpand = true;
        var arrow = Icon("document-send-symbolic", 52);
        arrow.Halign = Gtk.Align.Center;
        var prompt = Label("Drag and drop your video here", "d20");
        prompt.Halign = Gtk.Align.Center;
        var formats = Label("MOV, MP4, M4V, AVI, MKV or WebM", "muted");
        formats.Halign = Gtk.Align.Center;
        var browse = Button("Browse files", async () => await ChooseVideo(), "primary");
        browse.Halign = Gtk.Align.Center;
        browse.MarginTop = 6;
        inner.Append(arrow); inner.Append(prompt); inner.Append(formats); inner.Append(browse);
        upload.Append(inner);
        AcceptVideoDrop(upload, on => { if (on) upload.AddCssClass("target"); else upload.RemoveCssClass("target"); prompt.SetText(on ? "Drop to import" : "Drag and drop your video here"); });
        page.Append(upload);
        var label = Label("Or paste a file path", "muted", "medium");
        label.MarginTop = 20; label.MarginBottom = 6;
        page.Append(label);
        var path = Entry(session.SourcePath, "/home/you/Videos/my-video.mp4", value => session.SourcePath = value);
        path.AddCssClass("mono");
        path.OnActivate += async (_, _) => await ImportTyped(path.GetText());
        var import = Button("Import path", async () => await ImportTyped(path.GetText()), "primary");
        var row = Row(10);
        row.Append(path);
        row.Append(import);
        page.Append(row);
        var note = Text("Prism copies the selected video into your private Prism library.", "muted");
        note.MarginTop = 6;
        page.Append(note);
        updateScreen = () =>
        {
            path.Sensitive = upload.Sensitive = !session.IsBusy;
            import.Sensitive = !session.IsBusy && !string.IsNullOrWhiteSpace(session.SourcePath);
        };
    }

    void SettingsStep(Gtk.Box page, MediaItem video)
    {
        var name = Row(8);
        var check = Icon("object-select-symbolic", 14);
        check.AddCssClass("accent");
        name.Append(check);
        name.Append(Label(video.Name, "accent"));
        var chosen = Surface(8, name, Label(string.Create(CultureInfo.InvariantCulture, $"Video duration: {Format.Clock(video.Duration)} · {video.Duration / 60:0.00} minutes"), "muted", "t13"),
            Button("Choose a different video", async () => await ChooseVideo()));
        chosen.MarginBottom = 20;
        page.Append(chosen);

        var count = Label("", "medium");
        count.SetSizeRequest(70, -1);
        count.Xalign = 0.5f;
        var fewer = Button("−", () => session.ShortCount = Math.Max(1, session.ShortCount - 1), "compact");
        var more = Button("+", () => session.ShortCount = Math.Min(10, session.ShortCount + 1), "compact");
        fewer.TooltipText = "Fewer Shorts"; more.TooltipText = "More Shorts";
        var stepper = Row(6);
        stepper.Append(fewer); stepper.Append(count); stepper.Append(more);
        double[] durations = [15, 30, 45, 60];
        var length = Combo(durations.Select(seconds => $"{seconds:0} seconds"), Math.Max(0, Array.IndexOf(durations, session.ShortDuration)), index =>
        { if (index >= 0) session.ShortDuration = durations[index]; });
        var regions = Enum.GetValues<SourceRegion>();
        var region = Combo(regions.Select(value => value.Title()), Array.IndexOf(regions, session.ShortSourceRegion), index =>
        { if (index >= 0) session.ShortSourceRegion = regions[index]; });
        var columns = Gtk.Box.New(Gtk.Orientation.Horizontal, 18);
        columns.Homogeneous = true;
        columns.MarginTop = 6; columns.MarginBottom = 6;
        columns.Append(IconField("view-list-symbolic", "How many", stepper));
        columns.Append(IconField("preferences-system-time-symbolic", "Approx. length", length));
        columns.Append(IconField("video-x-generic-symbolic", "Take clips from", region));
        var start = Entry(session.CustomStartMinutes, "Start in minutes", value => session.CustomStartMinutes = value);
        var end = Entry(session.CustomEndMinutes, "End in minutes", value => session.CustomEndMinutes = value);
        var range = Gtk.Box.New(Gtk.Orientation.Horizontal, 12);
        range.Homogeneous = true;
        range.Append(Field("Start (minutes)", start));
        range.Append(Field("End (minutes)", end));
        var rangeNote = Label("", "muted");
        var custom = Column(8);
        custom.Append(range); custom.Append(rangeNote);
        var explanation = Text("", "muted");
        var settings = Surface(10, Label("Shorts settings", "muted", "medium"), columns, custom, explanation);
        settings.MarginBottom = 20;
        page.Append(settings);
        var next = IconText("go-next-symbolic", "Next: Choose captions", () => { createStep = 1; InvalidateScreen(); }, "primary");
        next.Halign = Gtk.Align.Center;
        page.Append(next);
        updateScreen = () =>
        {
            count.SetText($"{session.ShortCount} Shorts");
            fewer.Sensitive = session.ShortCount > 1; more.Sensitive = session.ShortCount < 10;
            custom.Visible = session.ShortSourceRegion == SourceRegion.Custom;
            if (session.CustomRangeError is { } error) { rangeNote.SetText("⚠ " + error); rangeNote.AddCssClass("warning"); }
            else
            {
                rangeNote.RemoveCssClass("warning");
                try
                {
                    var (from, to) = session.ShortSourceRegion.Interval(video.Duration, AppSession.MinuteSeconds(session.CustomStartMinutes), AppSession.MinuteSeconds(session.CustomEndMinutes));
                    rangeNote.SetText($"Analyze {Format.Clock(from)} to {Format.Clock(to)} · {Format.Clock(to - from)} selected");
                }
                catch (Exception) { rangeNote.SetText(""); }
            }
            explanation.SetText($"Prism will analyze frames and available speech, then suggest up to {session.ShortCount} distinct moments of about {session.ShortDuration:0} seconds in the {session.ShortSourceRegion.Title().ToLowerInvariant()}. Review every pick before exporting.");
            next.Sensitive = !session.IsBusy && session.CustomRangeError is null;
        };
    }

    static Gtk.Box IconField(string icon, string title, Gtk.Widget control)
    {
        var label = Row(6);
        var mark = Icon(icon, 12);
        mark.AddCssClass("muted");
        label.Append(mark);
        label.Append(Label(title, "muted"));
        var box = Column(6);
        box.Append(label);
        box.Append(control);
        return box;
    }

    void CaptionStep(Gtk.Box page)
    {
        var grid = Grid();
        var cards = new Dictionary<CaptionStyle, (Gtk.Button Card, Gtk.DrawingArea Check)>();
        foreach (var style in CaptionStyles.Choices)
        {
            var preview = Gtk.CenterBox.New();
            preview.AddCssClass("poster");
            preview.SetSizeRequest(-1, 84);
            try { preview.CenterWidget = Thumbnail(CaptionRenderer.StylePreview(style), 160, 64, fit: true); } catch { }
            var check = CheckCircle();
            var name = Row(8);
            name.MarginTop = 12;
            name.Append(check);
            name.Append(Label(style.Title(), "t14", "medium"));
            var detail = Text(style.Detail(), "muted"); detail.MaxWidthChars = 26;
            detail.Lines = 2;
            detail.Ellipsize = Pango.EllipsizeMode.End;
            detail.SetSizeRequest(-1, 34);
            detail.Valign = Gtk.Align.Start;
            var body = Column(4);
            body.Append(preview); body.Append(name); body.Append(detail);
            body.MarginStart = body.MarginEnd = body.MarginTop = body.MarginBottom = 8;
            var card = Button("", () => session.ShortCaptionStyle = style, "tile");
            card.Halign = Gtk.Align.Fill;
            card.Child = body;
            cards[style] = (card, check);
            grid.Append(card);
        }
        page.Append(grid);
        var note = Text("This style follows each spoken word. Gemini times the words; if a clip has none, its captions show as whole phrases.", "muted");
        note.MarginTop = 12;
        page.Append(note);
        page.Append(StepFooter("Back to settings", 0, IconText("go-next-symbolic", "Next: Choose content type", () => { createStep = 2; InvalidateScreen(); }, "primary")));
        updateScreen = () =>
        {
            foreach (var (style, (card, check)) in cards) Select(card, check, session.ShortCaptionStyle == style);
            note.Visible = session.ShortCaptionStyle.UsesWordTiming();
        };
    }

    void TypeStep(Gtk.Box page)
    {
        var grid = Grid();
        var cards = new Dictionary<VideoType, (Gtk.Button Card, Gtk.DrawingArea Check)>();
        foreach (var type in VideoTypes.All)
        {
            var check = CheckCircle();
            var top = Row(8);
            var name = Label(type.Title(), "t14", "medium");
            name.Hexpand = true;
            top.Append(name);
            top.Append(check);
            var detail = Text(type.Detail(), "muted"); detail.MaxWidthChars = 32;
            detail.Lines = 3;
            detail.Ellipsize = Pango.EllipsizeMode.End;
            detail.SetSizeRequest(-1, 50);
            detail.Valign = Gtk.Align.Start;
            var body = Column(8);
            body.Append(top); body.Append(detail);
            body.MarginStart = body.MarginEnd = body.MarginTop = body.MarginBottom = 8;
            var card = Button("", () => session.ShortVideoType = type, "tile");
            card.Halign = Gtk.Align.Fill;
            card.Child = body;
            cards[type] = (card, check);
            grid.Append(card);
        }
        page.Append(grid);
        var analyze = Button("Analyze and create Shorts", async () => await session.ContinueImport(), "primary");
        page.Append(StepFooter("Back to captions", 1, analyze));
        updateScreen = () =>
        {
            foreach (var (type, (card, check)) in cards) Select(card, check, session.ShortVideoType == type);
            analyze.Sensitive = !session.IsBusy && session.CustomRangeError is null;
        };
    }

    static void Select(Gtk.Button card, Gtk.DrawingArea check, bool selected)
    {
        if (selected) card.AddCssClass("selected"); else card.RemoveCssClass("selected");
        check.Name = selected ? "on" : "off";
        check.QueueDraw();
    }

    /// A Mac-style check: a ring, filled with a check when selected. Its widget name carries the state.
    Gtk.DrawingArea CheckCircle()
    {
        var area = Gtk.DrawingArea.New();
        area.ContentWidth = area.ContentHeight = 18;
        area.Valign = Gtk.Align.Center;
        area.SetDrawFunc((_, cr, width, height) =>
        {
            var light = session.Settings.Appearance == "light";
            var on = area.Name == "on";
            var (r, g, b) = on ? light ? (0.043, 0.424, 0.710) : (0.247, 0.663, 0.961) : light ? (0.361, 0.376, 0.408) : (0.541, 0.561, 0.596);
            cr.SetSourceRgb(r, g, b);
            cr.LineWidth = 1.5;
            cr.Arc(width / 2.0, height / 2.0, 7.5, 0, 2 * Math.PI);
            if (!on) { cr.Stroke(); return; }
            cr.Fill();
            cr.SetSourceRgb(light ? 1 : 0.09, light ? 1 : 0.098, light ? 1 : 0.125);
            cr.LineWidth = 1.8;
            cr.MoveTo(width / 2.0 - 3.5, height / 2.0); cr.LineTo(width / 2.0 - 1, height / 2.0 + 2.5); cr.LineTo(width / 2.0 + 3.5, height / 2.0 - 2.5);
            cr.Stroke();
        });
        return area;
    }

    Gtk.Box StepFooter(string back, int backStep, Gtk.Button forward)
    {
        var row = Row(8);
        row.MarginTop = 16;
        var previous = IconText("go-previous-symbolic", back, () => { createStep = backStep; InvalidateScreen(); });
        row.Append(previous);
        row.Append(Gap());
        row.Append(forward);
        return row;
    }

    static Gtk.Box Field(string label, Gtk.Widget widget)
    {
        var box = Column(6);
        box.Hexpand = true;
        box.Append(Label(label, "muted"));
        box.Append(widget);
        return box;
    }

    async Task ImportTyped(string text)
    {
        var path = text.Trim().Trim('"');
        if (path.StartsWith('~')) path = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), path[1..].TrimStart('/'));
        if (Uri.TryCreate(path, UriKind.Absolute, out var uri) && uri.IsFile) path = uri.LocalPath;
        if (!File.Exists(path)) { ShowNotice("Could not import video", "No file exists at that path."); return; }
        createStep = 0;
        await session.ImportSource(path);
        if (session.Message.StartsWith("Could not", StringComparison.Ordinal) || session.Message.Contains("could not be opened", StringComparison.Ordinal))
            ShowNotice("Could not import video", session.Message);
        Refresh();
    }

    void AcceptVideoDrop(Gtk.Widget widget, Action<bool> highlight)
    {
        var files = Gtk.DropTarget.New(Gdk.FileList.GetGType(), Gdk.DragAction.Copy);
        files.OnEnter += (_, _) => { highlight(true); return Gdk.DragAction.Copy; };
        files.OnLeave += (_, _) => highlight(false);
        files.OnDrop += (sender, args) =>
        {
            highlight(false);
            if (session.IsBusy) return false;
            var list = gdk_file_list_get_files(args.Value.GetBoxed());
            if (list == IntPtr.Zero) return false;
            var item = Marshal.ReadIntPtr(list);
            var pointer = g_file_get_path(item);
            if (pointer == IntPtr.Zero) return false;
            var path = Marshal.PtrToStringUTF8(pointer);
            g_free(pointer);
            if (path is null) return false;
            _ = ImportTyped(path);
            return true;
        };
        widget.AddController(files);
        var strings = Gtk.DropTarget.New(GObject.Type.String, Gdk.DragAction.Copy);
        strings.OnDrop += (sender, args) =>
        {
            if (session.IsBusy) return false;
            var path = args.Value.GetString()?.Split('\n', StringSplitOptions.RemoveEmptyEntries).FirstOrDefault()?.Trim();
            if (path is null) return false;
            _ = ImportTyped(path);
            return true;
        };
        widget.AddController(strings);
    }

    [DllImport("libgtk-4.so.1")] static extern IntPtr gdk_file_list_get_files(IntPtr fileList);
    [DllImport("libgio-2.0.so.0")] static extern IntPtr g_file_get_path(IntPtr file);
    [DllImport("libglib-2.0.so.0")] static extern void g_free(IntPtr memory);
}
