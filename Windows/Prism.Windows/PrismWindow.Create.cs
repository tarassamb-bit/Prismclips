using System.Globalization;
using System.IO;
using System.Windows;
using System.Windows.Automation;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Media;
using System.Windows.Shapes;
using Prism.Core;
using Path = System.IO.Path;

namespace Prism.Windows;

public sealed partial class PrismWindow
{
    UIElement CreateFlow()
    {
        var video = session.ShortsSource;
        var step = video is null ? 1 : Math.Clamp(createStep + 2, 2, 4);
        var page = Column(); page.Margin = new Thickness(30); page.MaxWidth = 920;
        var eyebrow = Text(step switch
        {
            1 => "Step 1 of 5 · Choose video", 2 => "Step 2 of 5 · Set up Shorts", 3 => "Step 3 of 5 · Choose captions", _ => "Step 4 of 5 · Choose content type",
        }, 12, muted: true);
        eyebrow.FontWeight = FontWeights.Medium;
        var title = Text(step switch
        {
            1 => "Add your long video", 2 => "Choose your Short settings", 3 => "Choose your captions", _ => "What kind of video is it?",
        }, 36, display: true);
        var subtitle = Text(step switch
        {
            1 => "Upload a video first. Then choose clip lengths and which part to analyze.", 2 => "Your video is ready. Choose how to turn it into Shorts.",
            3 => "Pick how speech appears on your Shorts. You can change it for each Short in the editor.",
            _ => "This tells Prism what to look for, how to lay out each Short and which captions Auto picks.",
        }, 16, muted: true);
        foreach (var line in new[] { eyebrow, title, subtitle }) { line.TextAlignment = TextAlignment.Center; line.HorizontalAlignment = HorizontalAlignment.Center; }
        page.Children.Add(eyebrow); page.Children.Add(title); page.Children.Add(subtitle);
        page.Children.Add(new Border { Height = 20 });
        // Each step's controls, Next button included, are what the first-video tutorial highlights.
        var controls = Column(); page.Children.Add(controls);
        if (video is null) UploadStep(TutorialTarget(FirstRunTutorial.Step.Upload, controls));
        else if (step == 2) SettingsStep(TutorialTarget(FirstRunTutorial.Step.Settings, controls), video);
        else if (step == 3) CaptionStep(TutorialTarget(FirstRunTutorial.Step.Captions, controls));
        else TypeStep(TutorialTarget(FirstRunTutorial.Step.ContentType, controls));
        var home = Link(Button("Back to Home", () => Navigate(Screen.Home), icon: "\uE76B")); home.Margin = new Thickness(0, 20, 0, 0);
        page.Children.Add(home);
        return Scroll(page);
    }

    void UploadStep(StackPanel page)
    {
        var outline = new Rectangle { RadiusX = 16, RadiusY = 16, StrokeThickness = 2, StrokeDashArray = [5, 4] };
        outline.SetResourceReference(Shape.StrokeProperty, "Line"); outline.SetResourceReference(Shape.FillProperty, "Surface1");
        var arrow = Glyph("\uE896", 52, "Ink"); arrow.Margin = new Thickness(0, 0, 0, 14);
        var prompt = Text("Drag and drop your video here", 20, display: true); prompt.HorizontalAlignment = HorizontalAlignment.Center;
        var formats = Text("MOV, MP4, M4V, AVI, MKV or WebM", 12, muted: true); formats.HorizontalAlignment = HorizontalAlignment.Center;
        var browse = Button("Browse files", ChooseVideo, true); browse.HorizontalAlignment = HorizontalAlignment.Center; browse.Margin = new Thickness(0, 14, 0, 0);
        var inner = Column(arrow, prompt, formats, browse); inner.VerticalAlignment = VerticalAlignment.Center; inner.Margin = new Thickness(24);
        var upload = new Grid { MinHeight = 270, AllowDrop = true, Background = Brushes.Transparent };
        upload.Children.Add(outline); upload.Children.Add(inner);
        void Target(bool on)
        {
            outline.SetResourceReference(Shape.StrokeProperty, on ? "Accent" : "Line"); outline.SetResourceReference(Shape.FillProperty, on ? "AccentWash" : "Surface1");
            arrow.Text = on ? "\uE74B" : "\uE896"; prompt.Text = on ? "Drop to import" : "Drag and drop your video here";
        }
        upload.DragEnter += (_, args) => Target(!session.IsBusy && args.Data.GetDataPresent(DataFormats.FileDrop));
        upload.DragLeave += (_, _) => Target(false);
        upload.DragOver += (_, args) => { args.Effects = !session.IsBusy && args.Data.GetDataPresent(DataFormats.FileDrop) ? DragDropEffects.Copy : DragDropEffects.None; args.Handled = true; };
        upload.Drop += async (_, args) =>
        {
            Target(false);
            if (session.IsBusy || args.Data.GetData(DataFormats.FileDrop) is not string[] { Length: > 0 } files) return;
            args.Handled = true;
            try { await ImportTyped(files[0]); } catch (Exception error) { ShowNotice("Could not import video", error.Message); }
        };
        page.Children.Add(upload);
        var label = Text("Or paste a file path", 12, muted: true); label.FontWeight = FontWeights.Medium; label.Margin = new Thickness(0, 20, 0, 6);
        page.Children.Add(label);
        var path = Entry(session.SourcePath, @"C:\Users\you\Videos\my-video.mp4", value => session.SourcePath = value);
        path.Padding = new Thickness(13); path.Margin = new Thickness(0, 0, 10, 0); path.SetResourceReference(FontFamilyProperty, "MonoFont");
        path.KeyDown += async (_, args) => { if (args.Key == Key.Enter) { args.Handled = true; try { await ImportTyped(path.Text); } catch (Exception error) { ShowNotice("Could not import video", error.Message); } } };
        var import = Button("Import path", () => ImportTyped(path.Text), true); import.Margin = new Thickness(0);
        page.Children.Add(SplitRow(path, import));
        page.Children.Add(Text("Prism copies the selected video into your private Prism library.", 12, muted: true));
        updateScreen = () =>
        {
            path.IsEnabled = upload.IsEnabled = !session.IsBusy;
            import.IsEnabled = !session.IsBusy && !string.IsNullOrWhiteSpace(session.SourcePath);
        };
    }

    void SettingsStep(StackPanel page, MediaItem video)
    {
        var name = Row(Glyph("\uE930", 14, "Accent"), Text(video.Name)); ((TextBlock)name.Children[1]).SetResourceReference(TextBlock.ForegroundProperty, "Accent");
        ((TextBlock)name.Children[0]).Margin = new Thickness(0, 0, 8, 0);
        var chosen = Surface(Column(name, Text(string.Create(CultureInfo.InvariantCulture, $"Video duration: {Format.Clock(video.Duration)} · {video.Duration / 60:0.00} minutes"), muted: true),
            WithLeft(Button("Choose a different video", ChooseVideo))));
        chosen.Margin = new Thickness(0, 0, 0, 20); page.Children.Add(chosen);

        var count = Text("", 13); count.FontWeight = FontWeights.Medium; count.Margin = new Thickness(10, 0, 10, 0); count.MinWidth = 70; count.TextAlignment = TextAlignment.Center;
        var fewer = StepButton("\uE738", "Fewer Shorts", () => session.ShortCount = Math.Max(1, session.ShortCount - 1));
        var more = StepButton("\uE710", "More Shorts", () => session.ShortCount = Math.Min(20, session.ShortCount + 1));
        double[] lengths = [15, 30, 45, 60];
        var length = Combo(lengths.Select(seconds => $"{seconds:0} seconds"), Math.Max(0, Array.IndexOf(lengths, session.ShortDuration)), index => { if (index >= 0) session.ShortDuration = lengths[index]; });
        var regions = Enum.GetValues<SourceRegion>();
        var start = Entry(session.CustomStartMinutes, "Start in minutes", value => session.CustomStartMinutes = value);
        var end = Entry(session.CustomEndMinutes, "End in minutes", value => session.CustomEndMinutes = value);
        var range = new Grid();
        range.ColumnDefinitions.Add(new ColumnDefinition()); range.ColumnDefinitions.Add(new ColumnDefinition());
        var startField = Field("Start (minutes)", start); var endField = Field("End (minutes)", end); Grid.SetColumn(endField, 1);
        range.Children.Add(startField); range.Children.Add(endField);
        var rangeNote = Text("", 12, muted: true);
        var custom = Column(range, rangeNote);
        var region = Combo(regions.Select(value => value.Title()), Array.IndexOf(regions, session.ShortSourceRegion), index => { if (index >= 0) session.ShortSourceRegion = regions[index]; });
        var columns = new Grid { Margin = new Thickness(0, 6, 0, 6) };
        for (var index = 0; index < 3; index++) columns.ColumnDefinitions.Add(new ColumnDefinition());
        var stepper = Row(fewer, count, more);
        var fields = new UIElement[] { IconField("\uE8FD", "How many", stepper), IconField("\uE916", "Approx. length", length), IconField("\uE8B2", "Take clips from", region) };
        for (var index = 0; index < 3; index++) { Grid.SetColumn(fields[index], index); ((FrameworkElement)fields[index]).Margin = new Thickness(0, 0, 18, 0); columns.Children.Add(fields[index]); }
        var explanation = Text("", 12, muted: true);
        var heading = Text("Shorts settings", 12, muted: true); heading.FontWeight = FontWeights.Medium;
        var settings = Surface(Column(heading, columns, custom, explanation)); settings.Margin = new Thickness(0, 0, 0, 20);
        page.Children.Add(settings);
        var next = Button("Next: Choose captions", () => { createStep = 1; InvalidateScreen(); }, true, icon: "\uE76C");
        next.HorizontalAlignment = HorizontalAlignment.Center; page.Children.Add(next);
        updateScreen = () =>
        {
            count.Text = $"{session.ShortCount} Shorts";
            fewer.IsEnabled = session.ShortCount > 1; more.IsEnabled = session.ShortCount < 20;
            custom.Visibility = session.ShortSourceRegion == SourceRegion.Custom ? Visibility.Visible : Visibility.Collapsed;
            if (session.CustomRangeError is { } error) { rangeNote.Text = "⚠ " + error; rangeNote.SetResourceReference(TextBlock.ForegroundProperty, "Amber"); }
            else if (session.ShortSourceRegion == SourceRegion.Custom)
            {
                try
                {
                    var (from, to) = session.ShortSourceRegion.Interval(video.Duration, AppSession.MinuteSeconds(session.CustomStartMinutes), AppSession.MinuteSeconds(session.CustomEndMinutes));
                    rangeNote.Text = $"Analyze {Format.Clock(from)} to {Format.Clock(to)} · {Format.Clock(to - from)} selected";
                }
                catch (Exception) { rangeNote.Text = ""; }
                rangeNote.SetResourceReference(TextBlock.ForegroundProperty, "Muted");
            }
            explanation.Text = $"Prism will analyze frames and available speech, then suggest up to {session.ShortCount} distinct moments of about {session.ShortDuration:0} seconds in the {session.ShortSourceRegion.Title().ToLowerInvariant()}. Review every pick before exporting.";
            next.IsEnabled = !session.IsBusy && session.CustomRangeError is null;
        };
    }

    Button StepButton(string glyph, string title, Action action)
    {
        var button = Button("", action); button.Content = Glyph(glyph, 11); button.Width = 34; button.MinHeight = 32; button.Padding = new Thickness(0); button.Margin = new Thickness(0);
        button.ToolTip = title; AutomationProperties.SetName(button, title); return button;
    }

    static StackPanel IconField(string glyph, string title, UIElement control)
    {
        var mark = Glyph(glyph, 12, "Muted"); mark.Margin = new Thickness(0, 0, 6, 0);
        var label = Row(mark, Text(title, 12, muted: true)); label.Margin = new Thickness(0, 0, 0, 4);
        if (control is FrameworkElement element) { element.Margin = new Thickness(0); element.HorizontalAlignment = HorizontalAlignment.Stretch; }
        if (control is StackPanel) ((FrameworkElement)control).HorizontalAlignment = HorizontalAlignment.Left;
        return Column(label, control);
    }

    static T WithLeft<T>(T element) where T : FrameworkElement { element.HorizontalAlignment = HorizontalAlignment.Left; return element; }

    void CaptionStep(StackPanel page)
    {
        var cards = new Dictionary<CaptionStyle, (Button Card, ContentControl Check)>();
        foreach (var style in CaptionStyles.Choices)
        {
            var preview = new Border { Height = 84, CornerRadius = new CornerRadius(12), Padding = new Thickness(10, 0, 10, 0), Background = Frozen(Color.FromRgb(71, 71, 71)) };
            try { var image = Picture(CaptionRenderer.StylePreview(style), double.NaN, double.NaN); image.Stretch = Stretch.Uniform; preview.Child = image; } catch { }
            var check = new ContentControl { Margin = new Thickness(0, 0, 8, 0), Focusable = false };
            var name = Text(style.Title(), 14); name.FontWeight = FontWeights.Medium;
            var label = Row(check, name); label.Margin = new Thickness(0, 12, 0, 4);
            var detail = Text(style.Detail(), 12, muted: true); detail.Height = 36; detail.TextTrimming = TextTrimming.CharacterEllipsis; detail.Margin = new Thickness(0);
            var card = Button("", () => session.ShortCaptionStyle = style);
            card.SetResourceReference(StyleProperty, "Tile"); card.BorderThickness = new Thickness(2); card.Padding = new Thickness(16); card.Margin = new Thickness(0); card.HorizontalAlignment = HorizontalAlignment.Stretch;
            card.Content = Column(preview, label, detail); AutomationProperties.SetName(card, style.Title());
            cards[style] = (card, check);
        }
        page.Children.Add(AdaptiveGrid(190, cards.Values.Select(item => (UIElement)item.Card), 14));
        var note = Text("This style follows each spoken word. Prism AI times the words; if a clip has none, its captions show as whole phrases.", 12, muted: true);
        page.Children.Add(note);
        page.Children.Add(StepFooter("Back to settings", 0, Button("Next: Choose content type", () => { createStep = 2; InvalidateScreen(); }, true, icon: "\uE76C")));
        updateScreen = () =>
        {
            foreach (var (style, (card, check)) in cards) Select(card, check, session.ShortCaptionStyle == style);
            note.Visibility = session.ShortCaptionStyle.UsesWordTiming() ? Visibility.Visible : Visibility.Collapsed;
        };
    }

    void TypeStep(StackPanel page)
    {
        var cards = new Dictionary<VideoType, (Button Card, ContentControl Check, TextBlock Mark)>();
        foreach (var type in VideoTypes.All)
        {
            var mark = Glyph(TypeGlyph(type), 20);
            var check = new ContentControl { Focusable = false };
            var top = new DockPanel(); DockPanel.SetDock(check, Dock.Right); top.Children.Add(check); top.Children.Add(WithLeft(mark));
            var name = Text(type.Title(), 14); name.FontWeight = FontWeights.Medium; name.Margin = new Thickness(0, 10, 0, 4);
            var detail = Text(type.Detail(), 12, muted: true); detail.Height = 54; detail.TextTrimming = TextTrimming.CharacterEllipsis; detail.Margin = new Thickness(0);
            var card = Button("", () => session.ShortVideoType = type);
            card.SetResourceReference(StyleProperty, "Tile"); card.BorderThickness = new Thickness(2); card.Padding = new Thickness(16); card.Margin = new Thickness(0); card.HorizontalAlignment = HorizontalAlignment.Stretch;
            card.Content = Column(top, name, detail); AutomationProperties.SetName(card, type.Title());
            cards[type] = (card, check, mark);
        }
        page.Children.Add(AdaptiveGrid(240, cards.Values.Select(item => (UIElement)item.Card), 14));
        var analyze = Button("Analyze and create Shorts", () => session.ContinueImport(), true);
        page.Children.Add(StepFooter("Back to captions", 1, analyze));
        updateScreen = () =>
        {
            foreach (var (type, (card, check, mark)) in cards)
            {
                var selected = session.ShortVideoType == type;
                Select(card, check, selected); mark.SetResourceReference(TextBlock.ForegroundProperty, selected ? "Accent" : "Muted");
            }
            analyze.IsEnabled = !session.IsBusy && session.CustomRangeError is null;
        };
    }

    static string TypeGlyph(VideoType type) => type switch
    {
        VideoType.Auto => "\uE945", VideoType.Informational => "\uE946", VideoType.Podcast => "\uE720", VideoType.Tutorial => "\uE7BE",
        VideoType.Vlog => "\uE722", VideoType.Gaming => "\uE7FC", _ => "\uE714",
    };

    static void Select(Button card, ContentControl check, bool selected)
    {
        card.SetResourceReference(BackgroundProperty, selected ? "Surface2" : "Surface1");
        if (selected) card.SetResourceReference(BorderBrushProperty, "Accent"); else card.BorderBrush = Brushes.Transparent;
        check.Content = CheckCircle(selected);
    }

    Grid StepFooter(string back, int backStep, Button forward)
    {
        var previous = Button(back, () => { createStep = backStep; InvalidateScreen(); }, icon: "\uE76B");
        forward.Margin = new Thickness(0, 4, 0, 4);
        var footer = SplitRow(WithLeft(previous), forward); footer.Margin = new Thickness(0, 16, 0, 0);
        return footer;
    }

    async Task ImportTyped(string text)
    {
        var path = text.Trim().Trim('"');
        if (path.StartsWith('~')) path = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), path[1..].TrimStart('/', '\\'));
        if (Uri.TryCreate(path, UriKind.Absolute, out var uri) && uri.IsFile) path = uri.LocalPath;
        if (!File.Exists(path)) { ShowNotice("Could not import video", "No file exists at that path."); return; }
        createStep = 0; await session.ImportSource(path); Refresh();
    }
}
