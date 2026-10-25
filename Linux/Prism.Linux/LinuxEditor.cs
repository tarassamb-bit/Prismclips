using System.Globalization;
using Prism.Core;

namespace Prism.Linux;

/// <summary>The persistent editor surface. Refresh changes data without replacing the video or the active text fields.</summary>
public sealed class LinuxEditor : IDisposable
{
    readonly AppSession session;
    readonly Gtk.Window window;
    readonly SynchronizationContext? context = SynchronizationContext.Current;
    readonly Gtk.Box root = Box(Gtk.Orientation.Vertical, 0);
    readonly Gtk.Box media = Box(Gtk.Orientation.Vertical, 10);
    readonly Gtk.Box captions = Box(Gtk.Orientation.Vertical, 12);
    readonly Gtk.Box inspector = Box(Gtk.Orientation.Vertical, 12);
    readonly Gtk.Box chatHistory = Box(Gtk.Orientation.Vertical, 10);
    readonly Gtk.Box timelineSection = Box(Gtk.Orientation.Vertical, 6);
    readonly Gtk.Box rightPanel = Box(Gtk.Orientation.Vertical, 0);
    readonly Gtk.Notebook leftTabs = Gtk.Notebook.New();
    readonly Gtk.Notebook rightTabs = Gtk.Notebook.New();
    readonly Gtk.Paned outer = Gtk.Paned.New(Gtk.Orientation.Horizontal);
    readonly Gtk.Paned middle = Gtk.Paned.New(Gtk.Orientation.Horizontal);
    readonly Gtk.Paned vertical = Gtk.Paned.New(Gtk.Orientation.Vertical);
    readonly Gtk.Video video = Gtk.Video.New();
    readonly Gtk.Label title = Label("Editor", "subtitle");
    readonly Gtk.Label saved = Label("", "muted");
    readonly Gtk.Label status = Label("", "muted");
    readonly Gtk.Label playerNotice = Label("Import a video to begin.", "muted");
    readonly Gtk.Label playerTime = Label("00:00 / 00:00", "mono");
    readonly Gtk.Label sourceName = Label("Source video", "muted");
    Gtk.Button play;
    readonly Gtk.Button undo, exports, export;
    readonly Gtk.Label engine = Label("☁ Gemini cloud", "muted");
    Gtk.Button expand;
    Gtk.Button noticeAction;
    Gtk.Widget leftPanel;
    readonly Gtk.Box notice = Box(Gtk.Orientation.Vertical, 10);
    readonly Gtk.Image noticeIcon = Gtk.Image.NewFromIconName("video-x-generic-symbolic");
    readonly Gtk.Label ratio = Label("Original", "muted", "t11");
    bool noticeRetry;
    readonly Gtk.Scale seek = Gtk.Scale.NewWithRange(Gtk.Orientation.Horizontal, 0, 1, 0.01);
    readonly Gtk.Entry chatInput = Gtk.Entry.New();
    readonly Gtk.EventControllerKey keys = Gtk.EventControllerKey.New();
    readonly LinuxTimeline timeline;
    readonly PreviewPlayer player;
    readonly System.Threading.Timer ticker;
    readonly Dictionary<string, byte[]> thumbnailCache = [];
    readonly Dictionary<CaptionStyle, byte[]> stylePreviews = [];
    readonly HashSet<string> loadingThumbnails = [];
    string? mediaSignature, inspectorSignature, captionSignature;
    Guid? inspectorId;
    int chatCount = -1;
    string? loadedPath, loadedIdentity;
    double pendingSeek;
    bool pendingSeekReady, resumePlayback, updatingSeek, disposed, panesInitialized, previewSuspended, chatNeedsScroll;
    Gtk.ScrolledWindow? chatScroll;
    int clockTicks;

    public Gtk.Widget Widget => root;
    public event Action<string>? Error;

    public LinuxEditor(AppSession session, Gtk.Window window, Func<Gtk.Widget> appearanceSwitch)
    {
        this.session = session;
        this.window = window;
        player = new PreviewPlayer(video, ClearPlayback);
        session.Player = player;
        root.SetHexpand(true); root.SetVexpand(true);
        // The Mac editor's header: Home, the mark, project and step, then save state, engine, Exports, theme, undo and Export.
        var header = Box(Gtk.Orientation.Horizontal, 14); header.AddCssClass("toolbar");
        var home = Button("‹  Home", () => { video.GetMediaStream()?.Pause(); session.Screen = Screen.Home; }, "link"); home.TooltipText = "Back to projects"; header.Append(home);
        var rule = Box(Gtk.Orientation.Vertical, 0); rule.AddCssClass("divider"); rule.SetSizeRequest(1, 20); rule.SetValign(Gtk.Align.Center); header.Append(rule);
        header.Append(PrismWindow.Mark(20));
        header.Append(Label("Prism", "d20"));
        title.RemoveCssClass("subtitle"); title.AddCssClass("t12"); title.AddCssClass("medium"); title.SetEllipsize(Pango.EllipsizeMode.End);
        var heading = Box(Gtk.Orientation.Vertical, 2); heading.SetHexpand(true); heading.SetValign(Gtk.Align.Center); heading.Append(title); heading.Append(Label("Step 5 · Review and export", "muted", "t11")); header.Append(heading);
        saved.AddCssClass("t11"); saved.SetValign(Gtk.Align.Center); header.Append(saved);
        engine.SetValign(Gtk.Align.Center); header.Append(engine);
        exports = Button("Exports", session.RevealExports, "link"); exports.TooltipText = "Open this project's Exports folder"; header.Append(exports);
        var appearance = appearanceSwitch(); header.Append(appearance);
        undo = Button("↶", session.UndoFromEditor, "icon link"); undo.TooltipText = "Undo edit · Ctrl+Z"; header.Append(undo);
        export = Button("Export", () => session.ChooseExport(), "primary compact"); export.TooltipText = "Choose which Shorts, the main video and the quality to export"; export.SetValign(Gtk.Align.Center); header.Append(export);
        root.Append(header);

        Pad(media, 14); Pad(captions, 14); Pad(inspector, 16); Pad(chatHistory, 14);
        media.SetSpacing(10); captions.SetSpacing(10); inspector.SetSpacing(8);
        leftTabs.AddCssClass("tools");
        leftTabs.AppendPage(Scroll(media), ToolHeader("video-x-generic-symbolic", "Shorts"));
        leftTabs.AppendPage(Scroll(captions), ToolHeader("media-view-subtitles-symbolic", "Captions"));
        leftTabs.SetVexpand(true);
        var autoSettings = Button("✦  Auto Shorts settings", () => session.Screen = Screen.ImportSource, "footer-action");
        var leftPanel = Box(Gtk.Orientation.Vertical, 0); leftPanel.AddCssClass("panel"); leftPanel.Append(leftTabs); leftPanel.Append(autoSettings);
        leftPanel.SetSizeRequest(200, -1);
        this.leftPanel = leftPanel;
        outer.SetStartChild(leftPanel); outer.SetEndChild(middle);
        outer.SetResizeStartChild(false); outer.SetShrinkStartChild(false); outer.SetWideHandle(false);

        var viewer = Box(Gtk.Orientation.Vertical, 0); viewer.AddCssClass("canvas"); viewer.SetHexpand(true); viewer.SetVexpand(true);
        var playerHeader = Box(Gtk.Orientation.Horizontal, 8); playerHeader.AddCssClass("player-head");
        sourceName.RemoveCssClass("muted"); sourceName.AddCssClass("t12"); sourceName.AddCssClass("medium"); sourceName.SetWrap(false); sourceName.SetEllipsize(Pango.EllipsizeMode.End);
        sourceName.SetHexpand(true); sourceName.SetValign(Gtk.Align.Center); playerHeader.Append(sourceName);
        ratio.SetValign(Gtk.Align.Center); playerHeader.Append(ratio);
        playerHeader.Append(IconButton("view-dual-symbolic", "Preview original source", () => session.SelectPreview(null)));
        viewer.Append(playerHeader);
        video.SetAutoplay(false); video.SetLoop(false); video.SetHexpand(true); video.SetVexpand(true); video.SetSizeRequest(180, 220);
        var picture = Gtk.Overlay.New(); picture.AddCssClass("player"); picture.SetHexpand(true); picture.SetVexpand(true); picture.SetChild(video);
        picture.SetMarginStart(16); picture.SetMarginEnd(16);
        playerNotice.SetHalign(Gtk.Align.Center); playerNotice.SetJustify(Gtk.Justification.Center); playerNotice.SetWrap(true); playerNotice.SetMaxWidthChars(40);
        playerNotice.RemoveCssClass("muted"); playerNotice.AddCssClass("t13");
        noticeAction = Button("Import video", () => { if (noticeRetry) session.SelectPreview(session.PreviewShortId); else _ = ImportVideo(); }, "compact");
        noticeAction.SetHalign(Gtk.Align.Center);
        notice.SetHalign(Gtk.Align.Center); notice.SetValign(Gtk.Align.Center);
        noticeIcon.SetPixelSize(36); noticeIcon.SetHalign(Gtk.Align.Center);
        notice.Append(noticeIcon); notice.Append(playerNotice); notice.Append(noticeAction);
        picture.AddOverlay(notice); viewer.Append(picture);
        var controls = Box(Gtk.Orientation.Horizontal, 10); controls.AddCssClass("player-controls");
        playerTime.RemoveCssClass("mono"); playerTime.AddCssClass("time-now"); playerTime.SetWrap(false); playerTime.SetValign(Gtk.Align.Center); controls.Append(playerTime);
        controls.Append(IconButton("media-skip-backward-symbolic", "Go to start · ← → to step, Shift for 5 s", () => session.SeekPreview(0)));
        play = IconButton("media-playback-start-symbolic", "Play or pause · Space", session.TogglePlayback); controls.Append(play);
        seek.SetDrawValue(false); seek.SetHexpand(true); seek.SetValign(Gtk.Align.Center);
        seek.OnValueChanged += (_, _) => { if (!updatingSeek) session.SeekPreview(seek.GetValue()); };
        controls.Append(seek);
        var fps = Label("30 fps", "mono"); fps.SetWrap(false); fps.SetValign(Gtk.Align.Center); controls.Append(fps);
        expand = IconButton("view-fullscreen-symbolic", "Expand preview · Esc to exit", () => session.IsPlayerExpanded = !session.IsPlayerExpanded); controls.Append(expand);
        viewer.Append(controls);
        middle.SetStartChild(viewer); middle.SetEndChild(rightPanel); middle.SetResizeStartChild(true); middle.SetResizeEndChild(false); middle.SetShrinkEndChild(false); middle.SetWideHandle(false);
        rightPanel.SetSizeRequest(248, -1); rightPanel.AddCssClass("panel");
        rightTabs.SetVexpand(true);
        rightTabs.AppendPage(Scroll(inspector), Label("Edit Short"));
        rightTabs.AppendPage(BuildChat(), Label("AI assistant"));
        rightPanel.Append(rightTabs);

        timeline = new LinuxTimeline(session); timeline.Widget.SetVexpand(true); timelineSection.Append(timeline.Widget);
        vertical.SetStartChild(outer); vertical.SetEndChild(timelineSection); vertical.SetResizeStartChild(true); vertical.SetResizeEndChild(false); vertical.SetShrinkEndChild(false); vertical.SetWideHandle(true); vertical.SetVexpand(true);
        root.Append(vertical);
        var footer = Box(Gtk.Orientation.Horizontal, 8); footer.AddCssClass("statusbar");
        status.SetHexpand(true); status.SetEllipsize(Pango.EllipsizeMode.End); status.SetValign(Gtk.Align.Center); status.AddCssClass("t11"); footer.Append(status);
        var format = Label("1080 × 1920 · 30 fps · MP4", "mono"); format.SetValign(Gtk.Align.Center); footer.Append(format);
        root.Append(footer);
        keys.SetPropagationPhase(Gtk.PropagationPhase.Capture); keys.OnKeyPressed += OnKeyPressed; window.AddController(keys);
        ticker = new System.Threading.Timer(_ => context?.Post(_ => Tick(), null), null, 100, 100);
        Refresh();
    }

    public void Refresh()
    {
        if (disposed) return;
        if (session.Screen != Screen.Editor) { video.GetMediaStream()?.Pause(); return; }
        if (!ReferenceEquals(session.Player, player)) session.Player = player;
        title.SetText(session.Project?.DisplayTitle ?? "Editor");
        saved.SetText(session.LastSavedAt is { } time ? "✓ Saved " + time.ToString("t", CultureInfo.CurrentCulture) : "");
        engine.SetText(session.IsBusy && session.GenerationStage.Length > 0 ? session.GenerationStage : "☁ Gemini cloud");
        exports.SetSensitive(!session.IsBusy); export.SetSensitive(session.Project?.Media.Count > 0 && !session.IsBusy);
        status.SetText(session.Message);
        undo.SetSensitive(session.CanUndo && !session.IsBusy);
        ((Gtk.Image)expand.GetChild()!).SetFromIconName(session.IsPlayerExpanded ? "view-restore-symbolic" : "view-fullscreen-symbolic");
        leftPanel.SetVisible(!session.IsPlayerExpanded); rightPanel.SetVisible(!session.IsPlayerExpanded); timelineSection.SetVisible(!session.IsPlayerExpanded);
        var number = session.ActiveSegment is { } active ? (session.Project?.Segments.FindIndex(s => s.Id == active.Id) ?? 0) + 1 : 0;
        sourceName.SetText(session.ActiveSegment is null ? "Source video" : string.IsNullOrEmpty(session.ActiveSegment.SuggestedTitle) ? $"Short {number} preview" : $"Short {number} · {session.ActiveSegment.SuggestedTitle}");
        ratio.SetText(session.ActiveSegment is null ? "Original" : "Vertical · 9:16");
        SyncPlayer();
        var currentMedia = session.Project is null ? "" : session.Project.Id + "|" + string.Join("|", session.Project.Media.Select(m => $"{m.Id}:{m.Thumbnail}:{m.Path}"))
            + string.Join("|", session.Project.Segments.Select(s => $"{s.Id}:{s.Start}:{s.Duration}:{s.SuggestedTitle}")) + session.PreviewShortId + "|" + session.Selection + "|" + session.IsBusy;
        if (mediaSignature != currentMedia) { mediaSignature = currentMedia; BuildMedia(); }
        var selected = session.ActiveSegment;
        var signature = selected is null ? "source" : PrismJson.Serialize(selected);
        if (inspectorId != selected?.Id || inspectorSignature != signature && !TextEditingInside(inspector))
        { inspectorId = selected?.Id; inspectorSignature = signature; BuildInspector(); }
        if (captionSignature != signature && !TextEditingInside(captions)) { captionSignature = signature; BuildCaptions(); }
        if (chatCount != session.ChatMessages.Count) { chatCount = session.ChatMessages.Count; BuildChatHistory(); }
        if (!FocusInside(chatInput) && chatInput.GetText() != session.ChatInput) chatInput.SetText(session.ChatInput);
        timeline.Refresh();
    }

    void SyncPlayer()
    {
        var identity = session.PreviewShortId?.ToString() ?? "source:" + session.Selection;
        if (session.PreviewPath is null)
        {
            if (loadedPath is not null && !previewSuspended)
            {
                pendingSeek = loadedIdentity == identity ? player.CurrentTime : 0;
                resumePlayback = loadedIdentity == identity && video.GetMediaStream()?.GetPlaying() == true;
                pendingSeekReady = false;
                video.GetMediaStream()?.Pause();
                previewSuspended = true;
            }
            notice.SetVisible(true);
            var failed = !session.IsPreviewLoading && session.PreviewError is not null;
            playerNotice.SetText(session.IsPreviewLoading ? "Rendering preview…" : session.PreviewError ?? "Your video goes here");
            noticeIcon.SetFromIconName(session.IsPreviewLoading ? "content-loading-symbolic" : failed ? "dialog-warning-symbolic" : "video-x-generic-symbolic");
            noticeAction.SetVisible(!session.IsPreviewLoading); noticeAction.SetLabel(failed ? "Retry preview" : "Import video"); noticeAction.SetSensitive(!session.IsBusy);
            noticeRetry = failed;
            return;
        }
        notice.SetVisible(false);
        var wasSuspended = previewSuspended;
        previewSuspended = false;
        if (loadedPath == session.PreviewPath)
        {
            if (wasSuspended) pendingSeekReady = true;
            return;
        }
        if (loadedIdentity != identity) { pendingSeek = 0; resumePlayback = false; }
        else if (!wasSuspended)
        { pendingSeek = player.CurrentTime; resumePlayback = video.GetMediaStream()?.GetPlaying() == true; }
        loadedIdentity = identity; loadedPath = session.PreviewPath;
        video.SetFilename(loadedPath); pendingSeekReady = true;
        seek.SetRange(0, Math.Max(0.01, session.PreviewLength));
    }

    void ClearPlayback()
    {
        video.GetMediaStream()?.Pause();
        video.SetMediaStream(null!);
        loadedPath = loadedIdentity = null;
        pendingSeek = 0;
        pendingSeekReady = resumePlayback = previewSuspended = false;
    }

    void Tick()
    {
        if (disposed || session.Screen != Screen.Editor) return;
        if (chatNeedsScroll && chatScroll is not null)
        {
            chatNeedsScroll = false;
            var adjustment = chatScroll.GetVadjustment();
            adjustment.SetValue(Math.Max(0, adjustment.GetUpper() - adjustment.GetPageSize()));
        }
        var stream = video.GetMediaStream();
        if (stream is not null)
        {
            if (pendingSeekReady && stream.IsPrepared())
            {
                pendingSeekReady = false;
                stream.Seek((long)(Math.Clamp(pendingSeek, 0, Math.Max(0, session.PreviewLength)) * 1_000_000));
                if (resumePlayback) stream.Play();
                pendingSeek = 0; resumePlayback = false;
            }
            updatingSeek = true; seek.SetValue(player.CurrentTime); updatingSeek = false;
            playerTime.SetText(Format.Clock(player.CurrentTime) + " / " + Format.Clock(session.PreviewLength));
            ((Gtk.Image)play.GetChild()!).SetFromIconName(stream.GetPlaying() ? "media-playback-pause-symbolic" : "media-playback-start-symbolic");
            if (stream.GetError() is { } error) { notice.SetVisible(true); playerNotice.SetText("Could not play this video. Check the GStreamer MP4 plugins. " + error.Message); }
        }
        if (!panesInitialized && vertical.GetHeight() > 300 && middle.GetWidth() > 400)
        {
            panesInitialized = true;
            outer.SetPosition((int)session.Settings.LeftSidebarWidth);
            middle.SetPosition(Math.Max(180, middle.GetWidth() - (int)session.Settings.RightSidebarWidth));
            vertical.SetPosition(Math.Max(160, vertical.GetHeight() - (int)session.Settings.TimelineHeight));
        }
        if (++clockTicks % 10 == 0 && panesInitialized && !session.IsPlayerExpanded)
        {
            double left = Math.Clamp(outer.GetPosition(), 200, 700), right = Math.Clamp(middle.GetWidth() - middle.GetPosition(), 248, 700), bottom = Math.Clamp(vertical.GetHeight() - vertical.GetPosition(), 150, 700);
            // Written only when a divider moved, not every second.
            if (left != session.Settings.LeftSidebarWidth || right != session.Settings.RightSidebarWidth || bottom != session.Settings.TimelineHeight)
            {
                session.Settings.LeftSidebarWidth = left; session.Settings.RightSidebarWidth = right; session.Settings.TimelineHeight = bottom;
                session.Settings.Save();
            }
        }
    }

    void BuildMedia()
    {
        Clear(media);
        var project = session.Project;
        if (project is { Segments.Count: > 0 })
        {
            var head = Box(Gtk.Orientation.Horizontal, 6);
            head.Append(Label("Shorts", "t14", "medium"));
            var count = Label($"{project.Segments.Count}", "muted", "t11", "medium"); count.SetHexpand(true); count.SetValign(Gtk.Align.Center); head.Append(count);
            var more = Button("✦ Create more", () => _ = session.MakeConfiguredShorts(), "link accent"); more.SetTooltipText("Analyze this video's unused moments for more Shorts"); more.SetSensitive(!session.IsBusy);
            head.Append(more); media.Append(head);
            var grid = Grid();
            for (var index = 0; index < project.Segments.Count; index++) grid.Append(ShortCard(project, project.Segments[index], index + 1));
            media.Append(grid);
            media.Append(Rule());
        }
        var mainHead = Box(Gtk.Orientation.Horizontal, 6);
        var mainTitle = Label("Main video", "t14", "medium"); mainTitle.SetHexpand(true); mainHead.Append(mainTitle);
        var add = IconButton("list-add-symbolic", "Import video", () => _ = ImportVideo()); add.SetSensitive(!session.IsBusy); mainHead.Append(add);
        media.Append(mainHead);
        var import = Button("Import", () => _ = ImportVideo(), "wide inset-tile tile"); import.SetSensitive(!session.IsBusy); media.Append(import);
        if (project is null || project.Media.Count == 0) { var empty = Label("Import a video to begin editing.", "muted"); empty.SetMarginTop(24); media.Append(empty); return; }
        var sources = Grid();
        foreach (var item in project.Media) sources.Append(MediaCard(item));
        media.Append(sources);
        var clip = Button("+ Add clip to timeline", session.AddManualClip, "link accent"); clip.SetHalign(Gtk.Align.Start); clip.SetSensitive(!session.IsBusy); media.Append(clip);
    }

    Gtk.Widget ShortCard(ProjectData project, EditSegment clip, int number)
    {
        var selected = clip.Id == session.PreviewShortId;
        var image = Gtk.Picture.New(); image.SetSizeRequest(100, 82); image.SetCanShrink(true); image.SetContentFit(Gtk.ContentFit.Cover);
        var source = project.Media.FirstOrDefault(m => m.Id == clip.MediaId);
        if (source is not null)
        {
            var at = Math.Min(Math.Max(0.1, clip.Start + clip.Duration * 0.45), Math.Max(0.1, source.Duration - 0.1));
            var key = source.Id + ":" + at.ToString("R", CultureInfo.InvariantCulture);
            if (thumbnailCache.TryGetValue(key, out var bytes)) SetImage(image, bytes);
            else if (source.Thumbnail is { } poster && File.Exists(poster)) SetImage(image, PrismWindow.Scaled(File.ReadAllBytes(poster), 112, 82, false));
            if (!thumbnailCache.ContainsKey(key) && loadingThumbnails.Add(key)) _ = LoadThumbnail(key, source.Path, at, image);
        }
        var posterBox = Gtk.Overlay.New(); posterBox.SetChild(image); posterBox.SetOverflow(Gtk.Overflow.Hidden); posterBox.AddCssClass("poster");
        var shade = Box(Gtk.Orientation.Horizontal, 4); shade.AddCssClass("shade"); shade.SetValign(Gtk.Align.Fill); shade.SetHalign(Gtk.Align.Fill);
        var line = Box(Gtk.Orientation.Horizontal, 4); line.SetValign(Gtk.Align.End); line.SetHexpand(true); Pad(line, 5);
        var name = Label($"▶ Short {number}"); name.SetWrap(false); name.SetHexpand(true); line.Append(name);
        if (clip.SplitScreen == true) { var split = Label("⊟"); split.SetTooltipText("Split screen"); line.Append(split); }
        if (clip.SelectionReason?.StartsWith("Weaker pick", StringComparison.Ordinal) == true) { var weak = Label("⚠", "warning"); weak.SetTooltipText("Weaker pick: check this one before exporting"); line.Append(weak); }
        line.Append(Label(Format.Clock(clip.Duration)));
        shade.Append(line); posterBox.AddOverlay(shade);
        var body = Box(Gtk.Orientation.Vertical, 3); body.Append(posterBox);
        if (!string.IsNullOrEmpty(clip.SuggestedTitle)) { var title = Label(clip.SuggestedTitle, "t11", "medium"); title.SetLines(2); title.SetEllipsize(Pango.EllipsizeMode.End); title.SetMarginTop(4); body.Append(title); }
        var starts = Label("Starts at " + Format.Clock(clip.Start), "muted", "t11"); starts.SetWrap(false); body.Append(starts);
        var card = Button("", () => { session.Selection = clip.MediaId; session.SelectPreview(clip.Id); }, selected ? "tile inset-tile selected" : "tile inset-tile");
        card.SetChild(body); card.SetTooltipText("Preview Short " + number + " · right-click for more");
        var menu = Gtk.GestureClick.New(); menu.SetButton(3);
        menu.OnPressed += (_, _) =>
        {
            var popup = Gtk.Popover.New(); popup.SetParent(card); popup.SetHasArrow(false); var options = Box(Gtk.Orientation.Vertical, 0);
            options.Append(Button("Preview", () => { popup.Popdown(); session.Selection = clip.MediaId; session.SelectPreview(clip.Id); }));
            options.Append(Button("Export this Short…", () => { popup.Popdown(); session.ChooseExport(clip.Id); }));
            options.Append(Button("Remove Short", () => { popup.Popdown(); session.RemoveShort(clip.Id); }, "danger"));
            popup.SetChild(options); popup.OnClosed += (_, _) => popup.Unparent(); popup.Popup();
        };
        card.AddController(menu);
        var remove = Button("✕", () => session.RemoveShort(clip.Id), "remove"); remove.SetHalign(Gtk.Align.End); remove.SetValign(Gtk.Align.Start); Pad(remove, 9);
        remove.SetTooltipText("Remove Short · Undo available"); remove.SetSensitive(!session.IsBusy);
        var host = Gtk.Overlay.New(); host.SetChild(card); host.AddOverlay(remove);
        return host;
    }

    Gtk.Widget MediaCard(MediaItem item)
    {
        var selected = session.PreviewShortId is null && session.Selection == item.Id;
        var image = Gtk.Picture.New(); image.SetSizeRequest(100, 70); image.SetCanShrink(true); image.SetContentFit(Gtk.ContentFit.Cover);
        if (item.Thumbnail is { } path && File.Exists(path)) SetImage(image, PrismWindow.Scaled(File.ReadAllBytes(path), 112, 70, false));
        var poster = Gtk.Overlay.New(); poster.SetChild(image); poster.SetOverflow(Gtk.Overflow.Hidden); poster.AddCssClass("poster");
        var badge = Box(Gtk.Orientation.Horizontal, 0); badge.AddCssClass("badge"); badge.Append(Label(Format.Clock(item.Duration)));
        badge.SetHalign(Gtk.Align.End); badge.SetValign(Gtk.Align.End); Pad(badge, 4); poster.AddOverlay(badge);
        var name = Label(item.Name, "t11"); name.SetWrap(false); name.SetEllipsize(Pango.EllipsizeMode.End); name.SetMarginTop(4);
        var body = Box(Gtk.Orientation.Vertical, 2); body.Append(poster); body.Append(name); body.Append(Label($"{item.Width} × {item.Height}", "muted", "t11"));
        var card = Button("", () => { session.Selection = item.Id; session.SelectPreview(null); }, selected ? "tile inset-tile selected" : "tile inset-tile");
        card.SetChild(body); card.SetTooltipText("Source video " + item.Name);
        return card;
    }

    async Task LoadThumbnail(string key, string path, double at, Gtk.Picture image)
    {
        try
        {
            var bytes = await FFmpeg.FrameJpeg(path, at, 360);
            if (disposed || bytes is null) return;
            // Cached at card size: GTK sizes a picture by its pixels, and a full frame would widen the card.
            thumbnailCache[key] = bytes = PrismWindow.Scaled(bytes, 112, 82, false);
            SetImage(image, bytes);
        }
        catch (Exception) { }
        finally { loadingThumbnails.Remove(key); }
    }

    async Task ImportVideo()
    {
        try
        {
            var dialog = Gtk.FileDialog.New(); dialog.SetTitle("Import video");
            var file = await dialog.OpenAsync(window);
            if (file?.GetPath() is { } path) await session.ImportSource(path);
        }
        catch (Exception) { }
    }

    void BuildInspector()
    {
        Clear(inspector);
        if (session.ActiveSegment is not { } clip)
        {
            var mark = Gtk.Image.NewFromIconName("preferences-other-symbolic"); mark.SetPixelSize(25); mark.AddCssClass("muted"); mark.SetHalign(Gtk.Align.Start); mark.SetMarginTop(30); inspector.Append(mark);
            inspector.Append(Label("Select a clip to edit", "t14", "medium"));
            inspector.Append(Label("Choose a Short from the media bin, or add a clip to the timeline.", "muted"));
            if (session.Selection is not null) { var add = Button("Add clip to timeline", session.AddManualClip); add.SetHalign(Gtk.Align.Start); inspector.Append(add); }
            return;
        }
        var source = session.Project?.Media.FirstOrDefault(m => m.Id == clip.MediaId);
        inspector.Append(Label(clip.SuggestedTitle ?? "Video", "t14", "medium"));
        if (clip.SelectionReason is { Length: > 0 } reason)
        {
            inspector.Append(Caption("Why suggested", false));
            inspector.Append(Label(reason, reason.StartsWith("Weaker pick", StringComparison.Ordinal) ? "warning" : "muted", "t11"));
        }
        if (clip.CaptionNotice is { Length: > 0 } notice) inspector.Append(Label("ⓘ " + notice, "warning", "t11"));
        inspector.Append(Caption("Clip range"));
        var start = Spin(clip.Start, 0, source?.Duration ?? clip.Start + clip.Duration);
        var duration = Spin(clip.Duration, 0.05, source?.Duration ?? clip.Duration);
        var timed = clip.SpeechWords is { Count: > 0 };
        inspector.Append(NumberRow("Start (seconds)", start));
        inspector.Append(NumberRow(timed ? "Target duration (seconds)" : "Duration (seconds)", duration));
        var span = Label("", "mono");
        void Span() => span.SetText($"{Format.Clock(start.GetValue())} → {Format.Clock(start.GetValue() + duration.GetValue())} in the source video");
        start.OnValueChanged += (_, _) => Span(); duration.OnValueChanged += (_, _) => Span(); Span();
        inspector.Append(span);
        if (timed) inspector.Append(Label("Cuts move slightly to keep the first and last spoken words whole.", "muted", "t11"));
        inspector.Append(Rule());
        inspector.Append(Caption("Video layout"));
        var layout = clip.SplitScreen == true ? 2 : clip.FitToFrame == true ? 0 : 1;
        inspector.Append(Segmented(["Fit", "Fill", "Split"], layout, index => { if (index == 2) _ = session.SetSplitScreen(); else session.SetFraming(index == 0); }));
        var position = Gtk.Scale.NewWithRange(Gtk.Orientation.Horizontal, 0, 1, 0.01); position.SetDrawValue(false); position.SetValue(Math.Clamp(clip.CropPosition ?? 0.5, 0, 1));
        var zoom = Gtk.Scale.NewWithRange(Gtk.Orientation.Horizontal, 1, 1.5, 0.05); zoom.SetDrawValue(false); zoom.SetValue(Math.Clamp(clip.CropZoom ?? 1.08, 1, 1.5));
        if (clip.SplitScreen == true) inspector.Append(Label("Two people: the left side of the video shows on top, the right side on the bottom. Captions sit in the middle.", "muted", "t11"));
        else
        {
            if (clip.FitToFrame != true)
            {
                var where = Label("", "mono"); where.SetWrap(false);
                void Where() => where.SetText(position.GetValue() < 0.34 ? "Left" : position.GetValue() > 0.66 ? "Right" : "Center");
                position.OnValueChanged += (_, _) => Where(); Where();
                inspector.Append(Heading(Label(clip.CropKeyframes is null ? "Horizontal framing" : "Tracking offset", "muted", "t11"), where));
                inspector.Append(position);
                var ends = Gtk.CenterBox.New();
                ends.SetStartWidget(Label("Left", "muted", "t11")); ends.SetCenterWidget(Label("Center", "muted", "t11")); ends.SetEndWidget(Label("Right", "muted", "t11"));
                inspector.Append(ends);
                var percent = Label("", "mono"); percent.SetWrap(false);
                void Percent() => percent.SetText($"{(int)Math.Round(zoom.GetValue() * 100)}%");
                zoom.OnValueChanged += (_, _) => Percent(); Percent();
                inspector.Append(Heading(Label("Crop zoom", "muted", "t11"), percent));
                inspector.Append(zoom);
            }
            inspector.Append(Label(clip.FitToFrame == true ? "Show the complete source over a blurred background."
                : clip.CropKeyframes is null ? "Manually added clips glide across wide footage. Zoom trims source edges."
                : clip.CropKeyframes.Count > 0 ? "Auto framing follows the main subject, holds steady while it is framed, and resets on scene cuts. Adjust tracking offset here. Zoom trims source edges."
                : "No clear subject was detected in this Short, so its crop holds steady. Adjust the framing offset here.", "muted", "t11"));
            if (clip.FitToFrame != true)
            {
                var actions = Box(Gtk.Orientation.Horizontal, 6);
                var hold = Button("Center & hold", session.HoldFramingAtCenter, "link accent"); var retrack = Button("Re-track", session.RetrackSelectedSubject, "link accent");
                hold.SetSensitive(!session.IsBusy); retrack.SetSensitive(!session.IsBusy);
                actions.Append(hold); actions.Append(retrack); inspector.Append(actions);
            }
        }
        inspector.Append(Rule());
        inspector.Append(Caption("On-screen text"));
        var overlay = Gtk.TextView.New(); overlay.SetWrapMode(Gtk.WrapMode.WordChar); overlay.GetBuffer().SetText(clip.Caption, -1); overlay.AddCssClass("overlay-text");
        overlay.SetTopMargin(6); overlay.SetBottomMargin(6); overlay.SetLeftMargin(6); overlay.SetRightMargin(6);
        var overlayScroll = Gtk.ScrolledWindow.New(); overlayScroll.SetChild(overlay); overlayScroll.SetSizeRequest(-1, 70); overlayScroll.SetPolicy(Gtk.PolicyType.Never, Gtk.PolicyType.Automatic);
        inspector.Append(overlayScroll);
        inspector.Append(Label("Speech captions are edited in the Captions tab.", "muted", "t11"));
        var textStart = Spin(clip.CaptionStart ?? 0, 0, clip.Duration);
        var textDuration = Spin(Math.Min(clip.CaptionDuration ?? clip.Duration, clip.Duration - (clip.CaptionStart ?? 0)), 0.05, clip.Duration);
        inspector.Append(NumberRow("Text starts at", textStart)); inspector.Append(NumberRow("Text duration", textDuration));
        inspector.Append(Label("Times are relative to this Short.", "muted", "t11"));
        void Apply()
        {
            var buffer = overlay.GetBuffer(); buffer.GetBounds(out var from, out var to);
            var length = duration.GetValue(); var textAt = textStart.GetValue();
            session.UpdateSelectedEdit(start.GetValue(), length, buffer.GetText(from, to, false), textAt, Math.Min(textDuration.GetValue(), Math.Max(0, length - textAt)), zoom.GetValue(), position.GetValue());
        }
        foreach (var box in new[] { start, duration, textStart, textDuration }) box.OnActivate += (_, _) => { try { Apply(); } catch (Exception error) { session.Message = error.Message; Error?.Invoke(error.Message); } };
        var apply = Button("Apply changes", Apply, "primary wide"); apply.SetMarginTop(6); inspector.Append(apply);
        inspector.Append(Rule());
        var mute = Gtk.CheckButton.NewWithLabel("Mute source audio"); mute.SetActive(clip.IsMuted == true);
        mute.OnToggled += (_, _) => { if (mute.GetActive() != (session.ActiveSegment?.IsMuted == true)) session.ToggleSelectedAudio(); };
        inspector.Append(mute);
        var export = Button("Export this Short", () => session.ChooseExport(clip.Id), "wide"); export.SetTooltipText("Choose quality and where this Short goes"); export.SetMarginTop(6); inspector.Append(export);
        inspector.SetSensitive(!session.IsBusy);
    }

    void BuildCaptions()
    {
        Clear(captions);
        if (session.ActiveSegment is not { } clip) { var empty = Label("Select a Short to change its captions.", "muted"); empty.SetMarginTop(28); captions.Append(empty); return; }
        var chosen = clip.CaptionStyle ?? CaptionStyle.Classic;
        var current = chosen.Resolved(clip.VideoType, clip.SplitScreen == true);
        var hasAudio = session.Project?.Media.FirstOrDefault(m => m.Id == clip.MediaId)?.HasAudio == true;
        captions.Append(Label("Caption style", "t14", "medium"));
        foreach (var style in CaptionStyles.Choices)
        {
            var selected = chosen == style || chosen == CaptionStyle.Clean && style == CaptionStyle.Classic;
            var chip = Gtk.CenterBox.New(); chip.AddCssClass("preview-chip"); chip.SetSizeRequest(112, 34); chip.SetValign(Gtk.Align.Center);
            try
            {
                if (!stylePreviews.TryGetValue(style, out var preview)) stylePreviews[style] = preview = PrismWindow.Scaled(CaptionRenderer.StylePreview(style), 104, 34, true);
                var image = Gtk.Picture.New(); image.SetCanShrink(true); image.SetContentFit(Gtk.ContentFit.Contain); image.SetSizeRequest(104, 34); SetImage(image, preview); chip.SetCenterWidget(image);
            }
            catch (Exception) { }
            var words = Box(Gtk.Orientation.Vertical, 2); words.SetHexpand(true); words.SetValign(Gtk.Align.Center);
            words.Append(Label(style.Title(), "t12", "medium")); words.Append(Label(style.Detail(), "muted", "t11"));
            var check = Label(selected ? "●" : "○", selected ? "accent" : "muted"); check.SetValign(Gtk.Align.Center); check.SetWrap(false);
            var row = Box(Gtk.Orientation.Horizontal, 10); row.Append(chip); row.Append(words); row.Append(check);
            var button = Button("", () => session.SetSelectedCaptionStyle(style), selected ? "tile inset-tile selected" : "tile inset-tile");
            button.SetChild(row); button.SetSensitive(!session.IsBusy && !selected);
            captions.Append(button);
        }
        if (current.UsesWordTiming() && clip.SpeechWords is not { Count: > 0 })
            captions.Append(Label(session.IsBusy ? "Gemini is timing the words so captions follow the speech…" : $"{current.Title()} follows each spoken word, which needs word timing this Short doesn't have. Transcribe it to add timing; until then captions show as whole phrases.", "warning", "t11"));
        captions.Append(Caption("Position", false));
        var positions = Enum.GetValues<CaptionPosition>();
        captions.Append(Segmented(positions.Select(p => p.Title()).ToArray(), Array.IndexOf(positions, clip.CaptionPosition ?? CaptionPosition.Bottom), index => session.SetSelectedCaptionLayout(position: positions[index])));
        captions.Append(Caption("Size", false));
        var sizes = Enum.GetValues<CaptionSize>();
        captions.Append(Segmented(sizes.Select(s => s.Title()).ToArray(), Array.IndexOf(sizes, clip.CaptionSize ?? CaptionSize.Medium), index => session.SetSelectedCaptionLayout(size: sizes[index])));
        var animated = Gtk.CheckButton.NewWithLabel("Pop-in animation"); animated.SetActive(clip.CaptionAnimated == true); animated.SetMarginTop(6);
        animated.OnToggled += (_, _) => session.SetSelectedCaptionLayout(animated: animated.GetActive());
        captions.Append(animated);
        captions.Append(Rule());
        var transcribe = Button("Transcribe", () => _ = session.RegenerateSelectedSubtitles(), "link accent");
        transcribe.SetSensitive(!session.IsBusy && hasAudio);
        transcribe.SetTooltipText(hasAudio ? "Transcribe with Gemini in the cloud. Google API usage may incur charges." : "This source video has no audio track.");
        var textTitle = Label("Caption text", "t14", "medium"); textTitle.SetHexpand(true);
        captions.Append(Heading(textTitle, transcribe));
        var cues = clip.Captions ?? [];
        if (cues.Count == 0) { captions.Append(Label(hasAudio ? "No captions yet. Transcribe this Short to create them." : "This source has no audio, so there is no speech to caption.", "muted")); return; }
        var editors = new List<Gtk.Entry>();
        var save = Button("Save captions", () => session.UpdateSelectedCaptionTexts(editors.Select(e => e.GetText()).ToArray()), "primary wide");
        save.SetSensitive(false);
        foreach (var cue in cues)
        {
            var jump = Button("▶ " + Format.Clock(cue.Start), () => session.SeekPreview(cue.Start), "link"); jump.SetHalign(Gtk.Align.Start); jump.SetTooltipText("Jump to this line in the preview");
            captions.Append(jump);
            var entry = Gtk.Entry.New(); entry.SetText(cue.Text);
            entry.OnChanged += (_, _) => save.SetSensitive(!session.IsBusy && !editors.Select(e => e.GetText()).SequenceEqual(cues.Select(c => c.Text)));
            captions.Append(entry); editors.Add(entry);
        }
        captions.Append(Label("Clear a line to remove it. Changing a line's words turns off its yellow highlight.", "muted", "t11"));
        captions.Append(save);
    }

    Gtk.Widget BuildChat()
    {
        var chat = Box(Gtk.Orientation.Vertical, 0);
        chatScroll = Scroll(chatHistory); chatScroll.SetVexpand(true); chat.Append(chatScroll);
        var composer = Box(Gtk.Orientation.Vertical, 6); Pad(composer, 12);
        var suggestions = Gtk.FlowBox.New(); suggestions.SetSelectionMode(Gtk.SelectionMode.None); suggestions.SetColumnSpacing(6); suggestions.SetRowSpacing(6);
        foreach (var suggestion in new[] { "Make a 30 second Short", "Add subtitles", "Make it 20 seconds" })
            suggestions.Append(Button(suggestion, () => _ = session.SendChat(suggestion), "compact"));
        composer.Append(suggestions);
        chatInput.SetPlaceholderText("Describe an edit…"); chatInput.AddCssClass("plain"); chatInput.SetHexpand(true);
        chatInput.OnChanged += (_, _) => session.ChatInput = chatInput.GetText();
        chatInput.OnActivate += (_, _) => _ = session.SendChat();
        var send = IconButton("mail-send-symbolic", "Send editing instruction", () => _ = session.SendChat()); send.AddCssClass("accent");
        var inputRow = Box(Gtk.Orientation.Horizontal, 6); inputRow.AddCssClass("inset"); inputRow.Append(chatInput); inputRow.Append(send);
        composer.Append(inputRow);
        chat.Append(composer);
        return chat;
    }

    void BuildChatHistory()
    {
        Clear(chatHistory);
        chatNeedsScroll = true;
        chatHistory.SetSpacing(10);
        chatHistory.Append(Label("Gemini · Cloud", "accent", "t11"));
        foreach (var item in session.ChatMessages)
        {
            var bubble = Box(Gtk.Orientation.Vertical, 0); bubble.AddCssClass("bubble"); if (item.IsUser) bubble.AddCssClass("user");
            var text = Label(item.Text, "t12"); text.SetSelectable(true); bubble.Append(text); chatHistory.Append(bubble);
        }
    }

    bool OnKeyPressed(Gtk.EventControllerKey sender, Gtk.EventControllerKey.KeyPressedSignalArgs args)
    {
        if (disposed || session.Screen != Screen.Editor || !root.IsSensitive() || !session.IsGeminiKeySaved || session.IsBusy
            || session.ExportChoice is not null || session.ExportSummary is not null || session.GenerationError is not null || Typing()) return false;
        var control = (args.State & Gdk.ModifierType.ControlMask) != 0;
        var shift = (args.State & Gdk.ModifierType.ShiftMask) != 0;
        switch (args.Keyval)
        {
            case 32: session.TogglePlayback(); return true;
            case 0xff51: session.SeekPreviewBy(shift ? -5 : -1); return true;
            case 0xff53: session.SeekPreviewBy(shift ? 5 : 1); return true;
            case 0xffff: if (session.PreviewShortId is { } id) session.RemoveShort(id); return true;
            case 0x7a or 0x5a when control: session.UndoFromEditor(); return true;
            case 0xff1b when session.IsPlayerExpanded: session.IsPlayerExpanded = false; return true;
            default: return false;
        }
    }

    bool Typing()
    {
        for (var focused = window.GetFocus(); focused is not null; focused = focused.GetParent())
            if (focused is Gtk.Entry or Gtk.TextView or Gtk.SpinButton || focused is Gtk.Editable) return true;
        return false;
    }

    bool FocusInside(Gtk.Widget ancestor)
    {
        for (var focused = window.GetFocus(); focused is not null; focused = focused.GetParent())
            if (ReferenceEquals(focused, ancestor) || focused.Handle.DangerousGetHandle() == ancestor.Handle.DangerousGetHandle()) return true;
        return false;
    }

    bool TextEditingInside(Gtk.Widget ancestor) => FocusInside(ancestor) && Typing();

    Gtk.Button IconButton(string icon, string title, Action action)
    {
        var button = Button("", action, "icon link"); var image = Gtk.Image.NewFromIconName(icon); image.SetPixelSize(16); button.SetChild(image); button.SetTooltipText(title); button.SetValign(Gtk.Align.Center); return button;
    }
    static Gtk.Widget ToolHeader(string icon, string title)
    {
        var box = Box(Gtk.Orientation.Vertical, 6); var image = Gtk.Image.NewFromIconName(icon); image.SetPixelSize(17); box.Append(image);
        var label = Gtk.Label.New(title); box.Append(label); return box;
    }
    static Gtk.Label Caption(string title, bool muted = true) { var label = muted ? Label(title, "muted", "t11", "medium") : Label(title, "t11", "medium"); label.SetMarginTop(10); return label; }
    static Gtk.Box Heading(Gtk.Widget left, Gtk.Widget right)
    {
        var row = Box(Gtk.Orientation.Horizontal, 6); left.SetHexpand(true); row.Append(left); row.Append(right); return row;
    }
    static Gtk.Widget Rule() { var line = Box(Gtk.Orientation.Vertical, 0); line.AddCssClass("divider"); line.SetMarginTop(10); line.SetMarginBottom(4); return line; }
    static Gtk.Box NumberRow(string title, Gtk.SpinButton spin)
    {
        spin.AddCssClass("number"); spin.SetTooltipText("Press Enter to apply"); spin.SetValign(Gtk.Align.Center);
        var label = Label(title, "muted", "t11"); label.SetHexpand(true); label.SetValign(Gtk.Align.Center);
        var row = Box(Gtk.Orientation.Horizontal, 8); row.Append(label); row.Append(spin); return row;
    }
    /// A segmented picker: equal buttons, the chosen one tinted with the accent.
    Gtk.Box Segmented(string[] titles, int selected, Action<int> chosen)
    {
        var row = Box(Gtk.Orientation.Horizontal, 6); row.SetHomogeneous(true);
        for (var index = 0; index < titles.Length; index++)
        {
            var choice = index;
            row.Append(Button(titles[index], () => { if (choice != selected) chosen(choice); }, index == selected ? "seg selected" : "seg"));
        }
        return row;
    }
    /// An adaptive grid like SwiftUI's: each card's minimum width sets how many fit in a row.
    static Gtk.FlowBox Grid()
    {
        var flow = Gtk.FlowBox.New(); flow.SetSelectionMode(Gtk.SelectionMode.None); flow.SetHomogeneous(true); flow.SetColumnSpacing(10); flow.SetRowSpacing(10);
        flow.SetMinChildrenPerLine(1); flow.SetMaxChildrenPerLine(8); flow.SetValign(Gtk.Align.Start); return flow;
    }
    static Gtk.Box Box(Gtk.Orientation orientation, int spacing) => Gtk.Box.New(orientation, spacing);
    static Gtk.Label Label(string text, params string[] css)
    {
        var label = Gtk.Label.New(text); label.SetXalign(0); label.SetWrap(true); label.SetWrapMode(Pango.WrapMode.WordChar);
        foreach (var name in css) label.AddCssClass(name);
        return label;
    }
    Gtk.Button Button(string text, Action action, string? css = null)
    {
        var button = Gtk.Button.NewWithLabel(text);
        foreach (var name in (css ?? "").Split(' ', StringSplitOptions.RemoveEmptyEntries)) button.AddCssClass(name);
        button.OnClicked += (_, _) =>
        {
            try { action(); }
            catch (Exception error) { session.Message = error.Message; Error?.Invoke(error.Message); }
        };
        return button;
    }
    static Gtk.ScrolledWindow Scroll(Gtk.Widget child)
    {
        var scroll = Gtk.ScrolledWindow.New(); scroll.SetPolicy(Gtk.PolicyType.Never, Gtk.PolicyType.Automatic); scroll.SetChild(child); scroll.SetVexpand(true); return scroll;
    }
    static Gtk.Widget Field(string title, Gtk.Widget editor)
    {
        var box = Box(Gtk.Orientation.Vertical, 4); box.Append(Label(title, "muted")); box.Append(editor); return box;
    }
    static Gtk.SpinButton Spin(double value, double min, double max, double step = 0.1)
    {
        var spin = Gtk.SpinButton.NewWithRange(min, Math.Max(min, max), step); spin.SetDigits(2); spin.SetValue(value); spin.SetNumeric(true); return spin;
    }
    static Gtk.ComboBoxText Combo(string[] values, int selected)
    {
        var combo = Gtk.ComboBoxText.New(); foreach (var value in values) combo.AppendText(value); combo.SetActive(selected); return combo;
    }
    static void SetImage(Gtk.Picture image, byte[] bytes)
    {
        using var data = GLib.Bytes.New(bytes.AsSpan()); image.SetPaintable(Gdk.Texture.NewFromBytes(data));
    }
    static void Pad(Gtk.Widget widget, int value)
    { widget.SetMarginTop(value); widget.SetMarginBottom(value); widget.SetMarginStart(value); widget.SetMarginEnd(value); }
    static void Clear(Gtk.Box box)
    { while (box.GetFirstChild() is { } child) box.Remove(child); }

    public void Dispose()
    {
        if (disposed) return; disposed = true; ticker.Dispose(); ClearPlayback();
        if (ReferenceEquals(session.Player, player)) session.Player = null;
        window.RemoveController(keys); timeline.Dispose();
    }

    sealed class PreviewPlayer(Gtk.Video video, Action clear) : IPreviewPlayer
    {
        public double CurrentTime => (video.GetMediaStream()?.GetTimestamp() ?? 0) / 1_000_000.0;
        public void Seek(double seconds) { if (double.IsFinite(seconds)) video.GetMediaStream()?.Seek((long)(Math.Max(0, seconds) * 1_000_000)); }
        public void Clear() => clear();
        public void TogglePlayback()
        {
            if (video.GetMediaStream() is not { } stream) return;
            if (stream.GetPlaying()) stream.Pause(); else stream.Play();
        }
    }
}
