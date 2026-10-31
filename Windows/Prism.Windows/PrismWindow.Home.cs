using System.Globalization;
using System.IO;
using System.Windows;
using System.Windows.Automation;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Media;
using Prism.Core;

namespace Prism.Windows;

public sealed partial class PrismWindow
{
    /// A video dropped from Explorer anywhere on Home starts a new Shorts project with it, as on the Mac.
    UIElement HomeDropTarget(UIElement page)
    {
        var home = new Grid { AllowDrop = true, Background = Brushes.Transparent };
        home.Children.Add(page);
        var outline = new System.Windows.Shapes.Rectangle { RadiusX = 16, RadiusY = 16, StrokeThickness = 2, StrokeDashArray = [5, 4] };
        outline.SetResourceReference(System.Windows.Shapes.Shape.StrokeProperty, "Accent"); outline.SetResourceReference(System.Windows.Shapes.Shape.FillProperty, "AccentWash");
        var title = Text("Drop to create Shorts", 22, display: true); var formats = Text("MOV, MP4, M4V, AVI, MKV or WebM", 12, muted: true);
        var arrow = Glyph("\uE74B", 44, "Accent"); arrow.Margin = new Thickness(0, 0, 0, 12);
        foreach (var line in new FrameworkElement[] { arrow, title, formats }) line.HorizontalAlignment = HorizontalAlignment.Center;
        var words = Column(arrow, title, formats); words.VerticalAlignment = VerticalAlignment.Center;
        var target = new Grid { Margin = new Thickness(16), IsHitTestVisible = false, Visibility = Visibility.Collapsed };
        target.Children.Add(outline); target.Children.Add(words);
        home.Children.Add(target);
        string? Video(DragEventArgs args) => !session.IsBusy && args.Data.GetData(DataFormats.FileDrop) is string[] { Length: > 0 } files
            && AppSession.VideoExtensions.Contains(Path.GetExtension(files[0]).TrimStart('.').ToLowerInvariant()) ? files[0] : null;
        void Over(object sender, DragEventArgs args)
        {
            if (Video(args) is null) return;
            args.Effects = DragDropEffects.Copy; args.Handled = true; target.Visibility = Visibility.Visible;
        }
        home.DragEnter += Over; home.DragOver += Over;
        home.DragLeave += (_, _) => target.Visibility = Visibility.Collapsed;
        home.Drop += async (_, args) =>
        {
            target.Visibility = Visibility.Collapsed;
            if (Video(args) is not { } path) return;
            args.Handled = true;
            StartCreate();
            try { await ImportTyped(path); } catch (Exception error) { ShowNotice("Could not import video", error.Message); }
        };
        return home;
    }

    UIElement Home()
    {
        var page = Column(); page.Margin = new Thickness(24); page.MaxWidth = 1800;
        page.Children.Add(StartCreatingButton());

        // Uploads that never got Shorts are kept but tucked away.
        var folder = session.ProjectFolders.FirstOrDefault(item => item.Id == openFolder);
        var paths = session.RecentProjectPaths.Where(path => folder is null
            ? !session.ProjectFolders.Any(item => item.ProjectPaths.Contains(path))
            : folder.ProjectPaths.Contains(path)).ToList();
        var counts = ProjectInfo.ShortCounts(paths);
        var finished = paths.Where(path => counts.GetValueOrDefault(path) > 0).ToList();
        var unfinished = paths.Where(path => counts.GetValueOrDefault(path) == 0).ToList();

        var title = Row();
        if (folder is not null)
        {
            var back = Ghost(Button("Projects", () => { openFolder = null; InvalidateScreen(); }, icon: ""));
            back.ToolTip = "Back to all projects · drop a project here to take it out of the folder";
            AcceptProjectDrop(back, null); title.Children.Add(back);
            title.Children.Add(Text(folder.Name, 22, display: true));
        }
        else title.Children.Add(Text("Projects", 22, display: true));
        var actions = Row();
        if (folder is null)
        {
            var add = Ghost(Button("New folder", () => Prompt("New folder", "Folder name", "", name => { session.CreateFolder(name); InvalidateScreen(); }), icon: ""));
            add.ToolTip = "Make a folder and drag projects into it"; actions.Children.Add(add);
        }
        actions.Children.Add(Ghost(Button("Open project…", () => { if (ChooseFolder("Open a Prism project (.relio)") is { } path) session.Open(path); }, icon: "")));
        if (unfinished.Count > 0)
        {
            var toggle = Ghost(Button("", () => { showUnfinished = !showUnfinished; InvalidateScreen(); }));
            toggle.Content = Disclosure(showUnfinished ? "Hide unfinished" : $"Show {unfinished.Count} unfinished", showUnfinished);
            toggle.ToolTip = "Projects where a video was uploaded but no Shorts were made"; actions.Children.Add(toggle);
        }
        var header = SplitRow(title, actions); header.Margin = new Thickness(0, 30, 0, 14);
        page.Children.Add(header);

        if (folder is null && session.ProjectFolders.Count > 0)
        {
            var folders = AdaptiveGrid(160, session.ProjectFolders.Select(FolderTile)); folders.Margin = new Thickness(0, 0, 0, 18);
            page.Children.Add(folders);
        }
        if (folder is not null && paths.Count == 0)
            page.Children.Add(EmptyState("", $"{folder.Name} is empty", "Go back to Projects and drag a project onto this folder, or right-click a project › Move to folder."));
        else if (session.RecentProjectPaths.Count == 0)
            page.Children.Add(EmptyState("", "Your projects will appear here", "Create a Short to start your first project."));
        else
        {
            // Newest first; two rows keep Home calm, the rest are one click away.
            page.Children.Add(AdaptiveGrid(160, finished.Take(showAll ? int.MaxValue : 12).Select(path => ProjectTile(path, counts.GetValueOrDefault(path)))));
            if (finished.Count > 12)
            {
                var more = Button("", () => { showAll = !showAll; InvalidateScreen(); });
                more.Content = Disclosure(showAll ? "Show fewer" : $"Show all {finished.Count} projects", showAll); more.HorizontalAlignment = HorizontalAlignment.Left;
                page.Children.Add(more);
            }
            if (showUnfinished && unfinished.Count > 0)
            {
                var heading = Text("Unfinished", 18, display: true); heading.Margin = new Thickness(0, 16, 0, 0);
                page.Children.Add(heading);
                page.Children.Add(Text("A video was uploaded, but no Shorts were made yet.", 12, muted: true));
                var grid = AdaptiveGrid(160, unfinished.Select(path => ProjectTile(path, 0))); grid.Margin = new Thickness(0, 8, 0, 0);
                page.Children.Add(grid);
            }
        }
        return HomeDropTarget(Scroll(page));
    }

    Button StartCreatingButton()
    {
        var hero = Button("", StartCreate);
        hero.SetResourceReference(StyleProperty, "Hero"); hero.SetResourceReference(BackgroundProperty, "Action");
        hero.Foreground = OnAction; hero.BorderThickness = new Thickness(0); hero.MinHeight = 86; hero.Padding = new Thickness(22, 16, 26, 16); hero.Margin = new Thickness(0);
        hero.ToolTip = "Start creating · Ctrl+N"; hero.HorizontalAlignment = HorizontalAlignment.Stretch; AutomationProperties.SetName(hero, "Start creating");
        TutorialTarget(FirstRunTutorial.Step.Start, hero);
        var body = new Grid();
        foreach (var width in new[] { GridLength.Auto, new GridLength(1, GridUnitType.Star), GridLength.Auto }) body.ColumnDefinitions.Add(new ColumnDefinition { Width = width });
        var plus = PlusTile(30, 15); plus.Margin = new Thickness(0, 0, 18, 0); body.Children.Add(plus);
        var title = Label("Start creating", 22); title.SetResourceReference(TextBlock.FontFamilyProperty, "DisplayFont"); title.FontWeight = FontWeights.Medium;
        var detail = Label("One in. Many out. Choose a video and Prism finds the moments worth sharing.", 13);
        detail.Opacity = 0.82; detail.FontWeight = FontWeights.Medium; detail.TextWrapping = TextWrapping.Wrap; detail.Margin = new Thickness(0, 5, 0, 0);
        var words = Column(title, detail); words.VerticalAlignment = VerticalAlignment.Center; Grid.SetColumn(words, 1); body.Children.Add(words);
        var arrow = new TextBlock { Text = "↗", FontFamily = new FontFamily("Segoe UI Symbol"), FontSize = 20, VerticalAlignment = VerticalAlignment.Center, Margin = new Thickness(12, 0, 0, 0) }; Grid.SetColumn(arrow, 2); body.Children.Add(arrow);
        hero.Content = body;
        return hero;
    }

    static StackPanel Disclosure(string title, bool open)
    {
        var chevron = Glyph(open ? "" : "", 10); chevron.Margin = new Thickness(6, 0, 0, 0);
        return Row(Label(title), chevron);
    }

    static Border EmptyState(string glyph, string title, string detail)
    {
        var heading = Text(title, 14); heading.FontWeight = FontWeights.Medium; heading.HorizontalAlignment = HorizontalAlignment.Center;
        var note = Text(detail, muted: true); note.TextAlignment = TextAlignment.Center; note.HorizontalAlignment = HorizontalAlignment.Center;
        var mark = Glyph(glyph, 34, "Muted"); mark.Margin = new Thickness(0, 0, 0, 6);
        return Surface(Column(mark, heading, note), padding: 48);
    }

    UIElement FolderTile(ProjectFolder folder)
    {
        var count = folder.ProjectPaths.Count(path => session.RecentProjectPaths.Contains(path));
        var tile = Button("", () => { openFolder = folder.Id; InvalidateScreen(); });
        tile.SetResourceReference(StyleProperty, "Tile"); tile.SetResourceReference(BackgroundProperty, "Surface1");
        tile.BorderBrush = Brushes.Transparent; tile.BorderThickness = new Thickness(2); tile.HorizontalAlignment = HorizontalAlignment.Stretch; tile.Padding = new Thickness(14); tile.MinHeight = 64;
        var mark = Glyph("", 26, "Accent"); mark.Margin = new Thickness(0, 0, 12, 0);
        var name = Text(folder.Name, 13); name.FontWeight = FontWeights.Medium; name.TextWrapping = TextWrapping.NoWrap; name.TextTrimming = TextTrimming.CharacterEllipsis; name.Margin = new Thickness(0, 0, 0, 3);
        var detail = Text(count == 1 ? "1 project" : $"{count} projects", 11, muted: true); detail.Margin = new Thickness(0);
        var words = Column(name, detail); words.VerticalAlignment = VerticalAlignment.Center;
        var body = new DockPanel(); DockPanel.SetDock(mark, Dock.Left); body.Children.Add(mark); body.Children.Add(words);
        tile.Content = body; tile.ToolTip = "Open folder · drop projects here";
        AutomationProperties.SetName(tile, $"Folder {folder.Name}, {count} projects");
        tile.ContextMenu = Menu(
            ("Rename…", () => Prompt("Rename folder", "Folder name", folder.Name, name => { session.RenameFolder(folder.Id, name); InvalidateScreen(); })),
            ("Delete folder (keeps projects)", () => { session.DeleteFolder(folder.Id); openFolder = null; InvalidateScreen(); }));
        AcceptProjectDrop(tile, folder.Id);
        return tile;
    }

    UIElement ProjectTile(string path, int count)
    {
        var project = ProjectStore.ReadProject(path);
        var name = project?.DisplayTitle ?? Path.GetFileNameWithoutExtension(path);
        var poster = new Grid { ClipToBounds = true };
        poster.SetResourceReference(Panel.BackgroundProperty, "Surface2");
        poster.Children.Add(Glyph("", 30, "Muted"));
        poster.SizeChanged += (_, args) =>
        {
            if (args.WidthChanged) poster.Height = args.NewSize.Width * 9 / 16;
            poster.Clip = new RectangleGeometry(new Rect(args.NewSize), 12, 12);
        };
        var clock = Text("", 10, display: true); clock.Margin = new Thickness(0); clock.Foreground = Frozen(Color.FromRgb(246, 243, 236));
        var badge = new Border { Child = clock, Background = Frozen(Color.FromArgb(199, 0, 0, 0)), CornerRadius = new CornerRadius(8), Padding = new Thickness(6, 3, 6, 3), Margin = new Thickness(6),
            HorizontalAlignment = HorizontalAlignment.Right, VerticalAlignment = VerticalAlignment.Bottom, Visibility = Visibility.Collapsed };
        poster.Children.Add(badge);
        var title = Text(name, 12); title.FontWeight = FontWeights.Medium; title.MinHeight = 30; title.MaxHeight = 34; title.TextTrimming = TextTrimming.CharacterEllipsis; title.Margin = new Thickness(0, 9, 0, 4);
        var details = Text(Details(count, project?.Created), 9, muted: true); details.FontWeight = FontWeights.Medium; details.TextWrapping = TextWrapping.NoWrap; details.Margin = new Thickness(0);
        var open = Button("", () => session.Open(path));
        open.SetResourceReference(StyleProperty, "Tile"); open.SetResourceReference(BackgroundProperty, "Surface1");
        open.BorderThickness = new Thickness(0); open.Padding = new Thickness(8); open.Margin = new Thickness(0); open.HorizontalAlignment = HorizontalAlignment.Stretch;
        open.Content = Column(poster, title, details);
        AutomationProperties.SetName(open, $"Open {name}");
        var actions = new List<(string, Action)>
        {
            ("Rename…", () => Prompt("Rename project", "Project name", name, value => { session.RenameProject(path, value); InvalidateScreen(); })),
            ("Move to folder…", () => MoveProjectCard(path)), ("Show stats", () => ShowStats(path)),
            ("Move to Recycle Bin", () => Confirm("Move this project to the Recycle Bin?", "Its Shorts, exports and imported video go to the Recycle Bin. You can restore the project from there.", "Move to Recycle Bin", () => { session.DeleteProject(path); InvalidateScreen(); })),
        };
        if (session.ProjectFolders.Any(folder => folder.ProjectPaths.Contains(path))) actions.Insert(2, ("Remove from folder", () => { session.MoveProject(path, null); InvalidateScreen(); }));
        open.ContextMenu = Menu(actions.ToArray());
        var host = new Border { Child = open };
        Point down = default;
        var armed = false;
        // Only a press that began on this card can drag it.
        host.PreviewMouseLeftButtonDown += (_, args) => { down = args.GetPosition(host); armed = true; };
        host.PreviewMouseLeftButtonUp += (_, _) => armed = false;
        host.PreviewMouseMove += (_, args) =>
        {
            if (!armed || args.LeftButton != MouseButtonState.Pressed || session.IsBusy) { armed &= args.LeftButton == MouseButtonState.Pressed; return; }
            var here = args.GetPosition(host);
            if (Math.Abs(here.X - down.X) < SystemParameters.MinimumHorizontalDragDistance && Math.Abs(here.Y - down.Y) < SystemParameters.MinimumVerticalDragDistance) return;
            armed = false;
            open.ReleaseMouseCapture();
            DragDrop.DoDragDrop(host, new DataObject("PrismProject", path), DragDropEffects.Move);
        };
        _ = LoadPoster(path, poster, badge, clock, title, details);
        return host;
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

    async Task LoadPoster(string path, Grid picture, Border badge, TextBlock clock, TextBlock title, TextBlock details)
    {
        var revision = homeRevision;
        try
        {
            var summary = summaries.GetValueOrDefault(path) ?? await Task.Run(() => ProjectInfo.Summary(path));
            if (disposed || revision != homeRevision) return;
            summaries[path] = summary; title.Text = summary.Title;
            details.Text = Details(summary.ShortCount, summary.Created);
            if (summary.Duration is { } duration) { clock.Text = ShortClock(duration); badge.Visibility = Visibility.Visible; }
            if (summary.Poster is not null) picture.Children.Insert(1, Picture(summary.Poster, double.NaN, double.NaN));
        }
        catch (Exception) { }
    }

    ContextMenu Menu(params (string Title, Action Action)[] actions)
    {
        var menu = new ContextMenu();
        foreach (var (title, action) in actions)
        {
            var item = new MenuItem { Header = title };
            item.Click += (_, _) => { try { action(); } catch (Exception error) { ShowNotice("Could not complete action", error.Message); } };
            menu.Items.Add(item);
        }
        return menu;
    }

    void AcceptProjectDrop(Control widget, Guid? folderId)
    {
        widget.AllowDrop = true;
        Brush? background = null, outline = null;
        void Highlight(bool on)
        {
            if (on && background is null) { background = widget.Background; outline = widget.BorderBrush; widget.SetResourceReference(BackgroundProperty, "AccentWash"); widget.SetResourceReference(BorderBrushProperty, "Accent"); }
            else if (!on && background is not null) { widget.Background = background; widget.BorderBrush = outline; background = outline = null; }
        }
        widget.DragEnter += (_, args) => Highlight(!session.IsBusy && args.Data.GetDataPresent("PrismProject"));
        widget.DragLeave += (_, _) => Highlight(false);
        widget.DragOver += (_, args) => { args.Effects = !session.IsBusy && args.Data.GetDataPresent("PrismProject") ? DragDropEffects.Move : DragDropEffects.None; args.Handled = true; };
        widget.Drop += (_, args) =>
        {
            Highlight(false);
            if (session.IsBusy || args.Data.GetData("PrismProject") is not string path || !session.RecentProjectPaths.Contains(path)) return;
            session.MoveProject(path, folderId); InvalidateScreen(); args.Handled = true;
        };
    }

    void MoveProjectCard(string path)
    {
        var card = ModalCard("Move to folder"); var body = (StackPanel)card.Child;
        foreach (var folder in session.ProjectFolders.Where(folder => !folder.ProjectPaths.Contains(path)))
        {
            var choice = Button(folder.Name, () => { session.MoveProject(path, folder.Id); CloseLocal(); InvalidateScreen(); }, icon: "");
            choice.HorizontalContentAlignment = HorizontalAlignment.Left; choice.HorizontalAlignment = HorizontalAlignment.Stretch; body.Children.Add(choice);
        }
        body.Children.Add(Ghost(Button("New folder…", () => Prompt("New folder", "Folder name", "", name =>
        { if (session.CreateFolder(name) is { } id) session.MoveProject(path, id); InvalidateScreen(); }), icon: "")));
        var cancel = Button("Cancel", CloseLocal); cancel.HorizontalAlignment = HorizontalAlignment.Right;
        body.Children.Add(cancel); ShowLocal(card);
    }

    void ShowStats(string path)
    {
        if (ProjectInfo.Stats(path) is not { } stats) { ShowNotice("Project stats", "Could not read this project."); return; }
        var card = ModalCard(stats.Title); var body = (StackPanel)card.Child;
        var grid = new Grid { Margin = new Thickness(0, 8, 0, 8) };
        grid.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto }); grid.ColumnDefinitions.Add(new ColumnDefinition());
        void Line(string label, string value, bool mono = false)
        {
            var row = grid.RowDefinitions.Count; grid.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
            var name = Text(label, muted: true); name.Margin = new Thickness(0, 5, 24, 5); Grid.SetRow(name, row); grid.Children.Add(name);
            var text = Text(value, mono: mono); text.FontWeight = mono ? FontWeights.Normal : FontWeights.Medium; text.TextWrapping = TextWrapping.NoWrap; text.TextTrimming = TextTrimming.CharacterEllipsis;
            Grid.SetRow(text, row); Grid.SetColumn(text, 1); grid.Children.Add(text);
        }
        Line("Shorts", $"{stats.ShortCount}");
        Line("Total length of Shorts", ShortClock(stats.ShortsSeconds), true);
        Line("Exported videos", $"{stats.ExportCount}");
        if (stats.SourceName is not null) Line("Source video", stats.SourceName);
        if (stats.SourceSeconds is { } seconds) Line("Source length", ShortClock(seconds), true);
        if (!string.IsNullOrEmpty(stats.Resolution)) Line("Resolution", stats.Resolution);
        Line("Created", stats.Created.ToLocalTime().ToString("g", CultureInfo.CurrentCulture));
        Line("Size on disk", Format.Bytes(stats.Bytes));
        body.Children.Add(grid);
        body.Children.Add(SplitRow(Button("Show in Explorer", () => WindowsPlatform.OpenExternal(path)), Button("Done", CloseLocal, true)));
        ShowLocal(card);
    }
}
