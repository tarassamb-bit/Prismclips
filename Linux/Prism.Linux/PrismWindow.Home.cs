using System.Globalization;
using Prism.Core;

namespace Prism.Linux;

public sealed partial class PrismWindow
{
    Gtk.Widget Home()
    {
        var page = Column(0);
        page.AddCssClass("section");
        page.Append(StartCreatingButton());

        // Uploads that never got Shorts are kept but tucked away.
        var folder = session.ProjectFolders.FirstOrDefault(item => item.Id == openFolder);
        var paths = session.RecentProjectPaths.Where(path => folder is null
            ? !session.ProjectFolders.Any(item => item.ProjectPaths.Contains(path))
            : folder.ProjectPaths.Contains(path)).ToList();
        var counts = ProjectInfo.ShortCounts(paths);
        var finished = paths.Where(path => counts.GetValueOrDefault(path) > 0).ToList();
        var unfinished = paths.Where(path => counts.GetValueOrDefault(path) == 0).ToList();

        var header = Row(8);
        header.MarginTop = 30;
        header.MarginBottom = 14;
        if (folder is not null)
        {
            var back = IconText("go-previous-symbolic", "Projects", () => { openFolder = null; InvalidateScreen(); }, "ghost");
            back.TooltipText = "Back to all projects · drop a project here to take it out of the folder";
            AcceptProjectDrop(back, null);
            header.Append(back);
        }
        var title = Label(folder?.Name ?? "Projects", "d22");
        title.Hexpand = true;
        header.Append(title);
        if (folder is null)
        {
            var add = IconText("folder-new-symbolic", "New folder", () => Prompt("New folder", "Folder name", "", name => { session.CreateFolder(name); InvalidateScreen(); }), "ghost");
            add.TooltipText = "Make a folder and drag projects into it";
            header.Append(add);
        }
        header.Append(IconText("document-open-symbolic", "Open project…", async () =>
        {
            var path = await ChooseFolder("Open a Prism project (.relio)");
            if (path is not null) session.Open(path);
        }, "ghost"));
        if (unfinished.Count > 0)
            header.Append(Disclosure(showUnfinished ? "Hide unfinished" : $"Show {unfinished.Count} unfinished", showUnfinished, () => { showUnfinished = !showUnfinished; InvalidateScreen(); }, "ghost"));
        page.Append(header);

        if (folder is null && session.ProjectFolders.Count > 0)
        {
            var folders = Grid();
            folders.MarginBottom = 18;
            foreach (var item in session.ProjectFolders) folders.Append(FolderTile(item));
            page.Append(folders);
        }
        if (folder is not null && paths.Count == 0)
            page.Append(EmptyState("folder-symbolic", $"{folder.Name} is empty", "Go back to Projects and drag a project onto this folder, or right-click a project › Move to folder."));
        else if (session.RecentProjectPaths.Count == 0)
            page.Append(EmptyState("view-grid-symbolic", "Your projects will appear here", "Create a Short to start your first project."));
        else
        {
            // Newest first; two rows keep Home calm, the rest are one click away.
            var grid = Grid();
            foreach (var path in finished.Take(showAll ? int.MaxValue : 12)) grid.Append(ProjectTile(path, counts.GetValueOrDefault(path)));
            page.Append(grid);
            if (finished.Count > 12)
            {
                var more = Disclosure(showAll ? "Show fewer" : $"Show all {finished.Count} projects", showAll, () => { showAll = !showAll; InvalidateScreen(); });
                more.MarginTop = 12;
                page.Append(more);
            }
            if (showUnfinished && unfinished.Count > 0)
            {
                var heading = Label("Unfinished", "d18");
                heading.MarginTop = 24;
                page.Append(heading);
                var note = Label("A video was uploaded, but no Shorts were made yet.", "muted");
                note.MarginBottom = 10;
                page.Append(note);
                var rest = Grid();
                foreach (var path in unfinished) rest.Append(ProjectTile(path, 0));
                page.Append(rest);
            }
        }
        return Scroll(page);
    }

    Gtk.Button StartCreatingButton()
    {
        var hero = Gtk.Button.New();
        hero.AddCssClass("hero");
        hero.TooltipText = "Start creating · Ctrl+N";
        var body = Row(18);
        body.Append(PlusTile(30));
        var words = Column(4);
        words.Hexpand = true;
        words.Valign = Gtk.Align.Center;
        words.Append(Label("Start creating", "d22"));
        var detail = Text("One in. Many out. Choose a video and Prism finds the moments worth sharing.", "medium");
        detail.Opacity = 0.82;
        words.Append(detail);
        body.Append(words);
        var arrow = Label("↗", "t16");
        arrow.Valign = Gtk.Align.Center;
        body.Append(arrow);
        hero.Child = body;
        hero.OnClicked += (_, _) => StartCreate();
        return hero;
    }

    Gtk.Button Disclosure(string title, bool open, Action action, string? cssClass = null)
    {
        var button = Button("", action, cssClass);
        var row = Row(6);
        row.Append(Label(title));
        row.Append(Icon(open ? "pan-up-symbolic" : "pan-down-symbolic", 12));
        button.Child = row;
        return button;
    }

    static Gtk.Box EmptyState(string icon, string title, string detail)
    {
        var mark = Icon(icon, 34);
        mark.AddCssClass("muted");
        var heading = Label(title, "t14", "medium");
        heading.Halign = Gtk.Align.Center;
        var note = Text(detail, "muted");
        note.Halign = Gtk.Align.Center;
        note.Justify = Gtk.Justification.Center;
        note.Xalign = 0.5f;
        var panel = Surface(10, mark, heading, note);
        panel.MarginTop = 0;
        mark.MarginTop = 30;
        note.MarginBottom = 30;
        return panel;
    }

    /// An adaptive grid like SwiftUI's: each child's minimum width sets how many fit in a row.
    static Gtk.FlowBox Grid()
    {
        var flow = Gtk.FlowBox.New();
        flow.SelectionMode = Gtk.SelectionMode.None;
        flow.MinChildrenPerLine = 1;
        flow.MaxChildrenPerLine = 12;
        flow.ColumnSpacing = 12;
        flow.RowSpacing = 14;
        flow.Homogeneous = true;
        flow.Hexpand = true;
        flow.Valign = Gtk.Align.Start;
        return flow;
    }

    Gtk.Widget FolderTile(ProjectFolder folder)
    {
        var count = folder.ProjectPaths.Count(path => session.RecentProjectPaths.Contains(path));
        var tile = Button("", () => { openFolder = folder.Id; InvalidateScreen(); }, "tile");
        tile.Halign = Gtk.Align.Fill;
        tile.SetSizeRequest(170, 64);
        tile.TooltipText = "Open folder · drop projects here";
        var row = Row(12);
        var mark = Icon("folder-symbolic", 26);
        mark.AddCssClass("accent");
        row.Append(mark);
        var words = Column(3);
        words.Valign = Gtk.Align.Center;
        var name = Label(folder.Name, "medium");
        name.Ellipsize = Pango.EllipsizeMode.End;
        words.Append(name);
        words.Append(Label(count == 1 ? "1 project" : $"{count} projects", "muted", "t11"));
        row.Append(words);
        row.MarginStart = row.MarginEnd = row.MarginTop = row.MarginBottom = 6;
        tile.Child = row;
        AttachMenu(tile, [
            ("Rename…", () => Prompt("Rename folder", "Folder name", folder.Name, name => { session.RenameFolder(folder.Id, name); InvalidateScreen(); })),
            ("Delete folder (keeps projects)", () => { session.DeleteFolder(folder.Id); openFolder = null; InvalidateScreen(); })]);
        AcceptProjectDrop(tile, folder.Id);
        return tile;
    }

    Gtk.Widget ProjectTile(string path, int count)
    {
        var project = ProjectStore.ReadProject(path);
        var name = project?.DisplayTitle ?? Path.GetFileNameWithoutExtension(path);
        var poster = Gtk.Overlay.New();
        var frame = Gtk.CenterBox.New();
        frame.AddCssClass("poster");
        frame.SetSizeRequest(150, 96);
        frame.Overflow = Gtk.Overflow.Hidden;
        var placeholder = Icon("video-x-generic-symbolic", 30);
        placeholder.AddCssClass("muted");
        frame.CenterWidget = placeholder;
        poster.Child = frame;
        var badge = Gtk.Box.New(Gtk.Orientation.Horizontal, 0);
        badge.AddCssClass("badge");
        var clock = Label("");
        badge.Append(clock);
        badge.Halign = Gtk.Align.End;
        badge.Valign = Gtk.Align.End;
        badge.MarginEnd = badge.MarginBottom = 6;
        badge.Visible = false;
        poster.AddOverlay(badge);
        var title = Text(name, "t12", "medium");
        title.Lines = 2;
        title.Ellipsize = Pango.EllipsizeMode.End;
        title.MaxWidthChars = 22;
        title.MarginTop = 9;
        title.SetSizeRequest(-1, 32);
        title.Valign = Gtk.Align.Start;
        var details = Label(Details(count, project?.Created), "muted", "t9", "medium");
        details.Ellipsize = Pango.EllipsizeMode.End;
        details.MarginTop = 4;
        var body = Column(0);
        body.Append(poster);
        body.Append(title);
        body.Append(details);
        var open = Button("", () => session.Open(path), "tile");
        open.Halign = Gtk.Align.Fill;
        open.Child = body;
        open.TooltipText = "Open " + name + " · right-click for more";
        var actions = new List<(string, Action)>
        {
            ("Rename…", () => Prompt("Rename project", "Project name", name, value => { session.RenameProject(path, value); InvalidateScreen(); })),
            ("Move to folder…", () => MoveProjectCard(path)),
            ("Show stats", () => ShowStats(path)),
            ("Move to Trash", () => Confirm("Move this project to the Trash?", "Its Shorts, exports and imported video go to the Trash. You can restore the project from there.", "Move to Trash", () => { session.DeleteProject(path); InvalidateScreen(); })),
        };
        if (session.ProjectFolders.Any(item => item.ProjectPaths.Contains(path)))
            actions.Insert(2, ("Remove from folder", () => { session.MoveProject(path, null); InvalidateScreen(); }));
        AttachMenu(open, actions.ToArray());
        var drag = Gtk.DragSource.New();
        drag.Actions = Gdk.DragAction.Move;
        drag.OnPrepare += (_, _) =>
        {
            using var value = new GObject.Value();
            value.Init(GObject.Type.String);
            value.SetString(path);
            return Gdk.ContentProvider.NewForValue(value);
        };
        open.AddController(drag);
        _ = LoadPoster(path, frame, badge, clock, title, details);
        return open;
    }

    static string Details(int shorts, DateTime? created)
    {
        var count = shorts == 0 ? "No Shorts yet" : shorts == 1 ? "1 Short" : $"{shorts} Shorts";
        return created is { } date ? count + " · " + date.ToLocalTime().ToString("d MMM, HH:mm", CultureInfo.CurrentCulture) : count;
    }

    static string ShortClock(double seconds)
    {
        var total = Math.Max(0, (int)Math.Round(seconds));
        return total >= 3600 ? $"{total / 3600}:{total / 60 % 60:00}:{total % 60:00}" : $"{total / 60}:{total % 60:00}";
    }

    async Task LoadPoster(string path, Gtk.CenterBox frame, Gtk.Box badge, Gtk.Label clock, Gtk.Label title, Gtk.Label details)
    {
        var revision = homeRevision;
        try
        {
            var summary = summaries.GetValueOrDefault(path) ?? await Task.Run(() => ProjectInfo.Summary(path));
            OnUI(() =>
            {
                if (disposed || revision != homeRevision || frame.GetParent() is null) return;
                summaries[path] = summary;
                title.SetText(summary.Title);
                details.SetText(Details(summary.ShortCount, summary.Created));
                if (summary.Duration is { } duration) { clock.SetText(ShortClock(duration)); badge.Visible = true; }
                if (summary.Poster is not null)
                {
                    frame.CenterWidget = Thumbnail(summary.Poster, 170, 96);
                }
            });
        }
        catch (Exception) { }
    }

    /// Right-click opens the actions, like the Mac app's context menus.
    void AttachMenu(Gtk.Widget target, (string Title, Action Action)[] actions)
    {
        var click = Gtk.GestureClick.New();
        click.Button = 3;
        click.OnPressed += (_, args) =>
        {
            // Made on demand and unparented on close: a popover still parented to a card would outlive the page and leak.
            var popover = Gtk.Popover.New();
            popover.SetParent(target);
            popover.HasArrow = false;
            var entries = Column(0);
            foreach (var (title, action) in actions)
            {
                var item = Button(title, () => { popover.Popdown(); action(); }, title.Contains("Trash") ? "danger" : null);
                item.Halign = Gtk.Align.Fill;
                if (item.Child is Gtk.Label label) label.Xalign = 0;
                entries.Append(item);
            }
            popover.Child = entries;
            popover.OnClosed += (_, _) => popover.Unparent();
            popover.SetPointingTo(new Gdk.Rectangle { X = (int)args.X, Y = (int)args.Y, Width = 1, Height = 1 });
            popover.Popup();
        };
        target.AddController(click);
    }

    void AcceptProjectDrop(Gtk.Widget widget, Guid? folderId)
    {
        var drop = Gtk.DropTarget.New(GObject.Type.String, Gdk.DragAction.Move);
        drop.OnEnter += (_, _) => { widget.AddCssClass("target"); return Gdk.DragAction.Move; };
        drop.OnLeave += (_, _) => widget.RemoveCssClass("target");
        drop.OnDrop += (_, args) =>
        {
            widget.RemoveCssClass("target");
            var path = args.Value.GetString();
            if (session.IsBusy || path is null || !session.RecentProjectPaths.Contains(path)) return false;
            session.MoveProject(path, folderId);
            InvalidateScreen();
            return true;
        };
        widget.AddController(drop);
    }

    void MoveProjectCard(string path)
    {
        var card = ModalCard("Move to folder");
        foreach (var folder in session.ProjectFolders.Where(folder => !folder.ProjectPaths.Contains(path)))
        {
            var choice = IconText("folder-symbolic", folder.Name, () => { session.MoveProject(path, folder.Id); CloseLocal(); InvalidateScreen(); });
            choice.Halign = Gtk.Align.Fill;
            card.Append(choice);
        }
        card.Append(IconText("folder-new-symbolic", "New folder…", () => Prompt("New folder", "Folder name", "", name =>
        {
            if (session.CreateFolder(name) is { } id) session.MoveProject(path, id);
            InvalidateScreen();
        }), "ghost"));
        var cancel = Button("Cancel", CloseLocal);
        cancel.Halign = Gtk.Align.End;
        card.Append(cancel);
        ShowLocal(card);
    }

    void ShowStats(string path)
    {
        if (ProjectInfo.Stats(path) is not { } stats) { ShowNotice("Project stats", "Could not read this project."); return; }
        var card = ModalCard(stats.Title);
        var grid = Gtk.Grid.New();
        grid.ColumnSpacing = 24;
        grid.RowSpacing = 10;
        var row = 0;
        void Line(string label, string value, bool mono = false)
        {
            grid.Attach(Label(label, "muted", "t12"), 0, row, 1, 1);
            var text = Label(value, mono ? "mono" : "medium");
            text.Ellipsize = Pango.EllipsizeMode.Middle;
            text.Hexpand = true;
            grid.Attach(text, 1, row++, 1, 1);
        }
        Line("Shorts", $"{stats.ShortCount}");
        Line("Total length of Shorts", ShortClock(stats.ShortsSeconds), true);
        Line("Exported videos", $"{stats.ExportCount}");
        if (stats.SourceName is not null) Line("Source video", stats.SourceName);
        if (stats.SourceSeconds is { } seconds) Line("Source length", ShortClock(seconds), true);
        if (!string.IsNullOrEmpty(stats.Resolution)) Line("Resolution", stats.Resolution);
        Line("Created", stats.Created.ToLocalTime().ToString("g", CultureInfo.CurrentCulture));
        Line("Size on disk", Format.Bytes(stats.Bytes));
        card.Append(grid);
        card.Append(Footer(Button("Show in Files", () => LinuxPlatform.OpenExternal(path)), Button("Done", CloseLocal, "primary")));
        ShowLocal(card);
    }
}
