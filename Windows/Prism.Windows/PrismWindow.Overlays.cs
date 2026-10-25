using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Media;
using Prism.Core;

namespace Prism.Windows;

public sealed partial class PrismWindow
{
    void RefreshModal()
    {
        var desired = localCard is not null ? "local:" + localRevision
            : !session.IsGeminiKeySaved ? "key"
            : session.GenerationProgress is not null ? "progress"
            : session.IsBusy ? "working" : session.IsTestingGemini ? "testing"
            : session.GenerationError is { } failure ? "error:" + failure.GetHashCode()
            : session.ExportSummary is { } summary ? "done:" + summary
            : session.ExportChoice is not null ? "export" : "";
        var blocked = desired.Length > 0;
        layout.IsEnabled = !blocked;
        editor.Widget.IsEnabled = !blocked;
        if (desired == modalKind) { updateModal?.Invoke(); return; }
        overlayHost.Children.Clear(); updateModal = null; modalKind = desired;
        overlayHost.Visibility = blocked ? Visibility.Visible : Visibility.Collapsed;
        if (!blocked) return;
        var card = desired switch
        {
            "key" => KeyGate(), "progress" => ProgressCard(), "working" => WorkingCard(false), "testing" => WorkingCard(true), "export" => ExportCard(),
            _ when desired.StartsWith("error:", StringComparison.Ordinal) => ErrorCard(session.GenerationError!),
            _ when desired.StartsWith("done:", StringComparison.Ordinal) => ExportDoneCard(session.ExportSummary!), _ => localCard!,
        };
        KeyboardNavigation.SetTabNavigation(card, KeyboardNavigationMode.Cycle);
        var scroll = Scroll(card); scroll.Width = desired == "key" ? 520 : 490; scroll.MaxHeight = Math.Max(300, ActualHeight - 90);
        scroll.HorizontalAlignment = HorizontalAlignment.Center; scroll.VerticalAlignment = VerticalAlignment.Center;
        var dim = new Border { Background = new SolidColorBrush(Color.FromArgb(desired == "key" ? (byte)184 : (byte)140, 0, 0, 0)), Child = scroll };
        card.RenderTransformOrigin = new Point(0.5, 0.5); card.RenderTransform = new ScaleTransform(0.97, 0.97);
        dim.BeginAnimation(OpacityProperty, new System.Windows.Media.Animation.DoubleAnimation(0, 1, TimeSpan.FromMilliseconds(140)));
        var grow = new System.Windows.Media.Animation.DoubleAnimation(0.97, 1, TimeSpan.FromMilliseconds(160)) { EasingFunction = new System.Windows.Media.Animation.CubicEase() };
        card.RenderTransform.BeginAnimation(ScaleTransform.ScaleXProperty, grow); card.RenderTransform.BeginAnimation(ScaleTransform.ScaleYProperty, grow);
        overlayHost.Children.Add(dim); updateModal?.Invoke();
    }

    /// The Mac app's popup card: a 16 pt title with an optional tinted icon, on Surface1 with a hairline.
    static Border ModalCard(string title, string? glyph = null, string tint = "Ink")
    {
        var heading = Text(title, 16); heading.FontWeight = FontWeights.Medium; heading.SetResourceReference(TextBlock.ForegroundProperty, tint);
        UIElement top = heading;
        if (glyph is not null) { var mark = Glyph(glyph, 16, tint); mark.Margin = new Thickness(0, 0, 10, 0); top = Row(mark, heading); }
        var card = Card(top);
        card.Padding = new Thickness(24); card.Margin = new Thickness(0); return card;
    }

    /// Secondary action left, the rest right: the Mac popups' footer.
    static Grid Footer(Button left, params Button[] right)
    {
        var actions = Row(right); foreach (var button in right) button.Margin = new Thickness(8, 4, 0, 4);
        left.Margin = new Thickness(0, 4, 0, 4);
        var footer = SplitRow(left, actions); footer.Margin = new Thickness(0, 14, 0, 0); return footer;
    }

    Border KeyGate()
    {
        var card = ModalCard("Welcome to Prism"); var body = (StackPanel)card.Child;
        body.Children.RemoveAt(0); var welcome = Text("Welcome to Prism", 22, display: true);
        var mark = Mark(26); mark.Margin = new Thickness(0, 0, 10, 0); body.Children.Insert(0, Row(mark, welcome));
        body.Children.Add(Text("Prism uses Google Gemini to find, cut, caption and frame your Shorts, so it needs your own Gemini API key before it can work. Google bills your AI Studio account for what Prism uses; the free tier works too.", muted: true));
        body.Children.Add(Text("1. Create a key"));
        body.Children.Add(Button("Open Google AI Studio › API keys", () => WindowsPlatform.OpenExternal("https://aistudio.google.com/apikey")));
        body.Children.Add(Text("2. Paste it here"));
        var key = new PasswordBox { Password = session.GeminiKey, Padding = new Thickness(10), Margin = new Thickness(0, 4, 0, 4), ToolTip = "Paste your API key" };
        key.PasswordChanged += (_, _) => session.GeminiKey = key.Password;
        key.KeyDown += async (_, args) =>
        {
            if (args.Key != Key.Enter || session.IsTestingGemini || string.IsNullOrWhiteSpace(session.GeminiKey)) return;
            args.Handled = true;
            try { await session.VerifyAndSaveGeminiKey(); } catch (Exception error) { ShowNotice("Could not check key", error.Message); }
        };
        body.Children.Add(key);
        var feedback = Text(session.GeminiKeyStatus, muted: true); body.Children.Add(feedback);
        body.Children.Add(Text("The key is protected with Windows Data Protection for your Windows account. Audio, transcripts and sampled frames from your videos are sent to Google.", 11, muted: true));
        var save = Button("Save and continue", () => session.VerifyAndSaveGeminiKey(), true); save.HorizontalAlignment = HorizontalAlignment.Right; body.Children.Add(save);
        updateModal = () =>
        {
            feedback.Text = session.GeminiKeyStatus;
            feedback.SetResourceReference(TextBlock.ForegroundProperty, session.GeminiKeyRejected ? "Amber" : "Muted");
            key.IsEnabled = !session.IsTestingGemini;
            save.IsEnabled = !session.IsTestingGemini && !string.IsNullOrWhiteSpace(session.GeminiKey);
        };
        Dispatcher.BeginInvoke(new Action(() => { if (!disposed && modalKind == "key") key.Focus(); }));
        return card;
    }

    Border ProgressCard()
    {
        var card = ModalCard(session.IsExporting ? "Exporting" : "Creating Shorts"); var body = (StackPanel)card.Child; body.Children.Clear();
        var stage = Text(session.GenerationStage, 14); stage.FontWeight = FontWeights.Medium; stage.TextWrapping = TextWrapping.NoWrap; stage.TextTrimming = TextTrimming.CharacterEllipsis;
        var percent = Text("", 12, muted: true, mono: true); percent.Margin = new Thickness(12, 0, 0, 0);
        var progress = new ProgressBar { Minimum = 0, Maximum = 1, Height = 4, Margin = new Thickness(0, 10, 0, 8) };
        var detail = Text("", 11, muted: true, mono: true);
        var cancel = Button("Cancel", session.CancelGeneration); cancel.HorizontalAlignment = HorizontalAlignment.Right;
        body.Children.Add(SplitRow(stage, percent)); body.Children.Add(progress);
        body.Children.Add(Text(session.IsExporting ? "Your files are being prepared for export." : "Gemini finds complete moments, aligns speech and follows the subject.", 12, muted: true));
        cancel.Margin = new Thickness(0); body.Children.Add(SplitRow(detail, cancel));
        updateModal = () =>
        {
            stage.Text = session.GenerationStage; progress.Value = Math.Clamp(session.GenerationProgress ?? 0, 0, 1);
            percent.Text = $"{progress.Value * 100:0}%";
            detail.Text = $"Elapsed {Format.Clock((DateTime.Now - session.GenerationStartedAt).TotalSeconds)}";
            cancel.IsEnabled = session.GenerationStage != "Cancelling…";
        };
        return card;
    }

    Border WorkingCard(bool testing)
    {
        var card = ModalCard(testing ? "Checking Gemini…" : "Working…"); var body = (StackPanel)card.Child;
        body.Children.Add(new ProgressBar { IsIndeterminate = true, Height = 6, Margin = new Thickness(0, 14, 0, 14) });
        var message = Text(""); body.Children.Add(message);
        updateModal = () => message.Text = testing ? session.GeminiKeyStatus : session.Message;
        return card;
    }

    Border ErrorCard(GenerationFailure failure)
    {
        var title = failure.IsExport ? "Export failed" : failure.Kind switch
        {
            GenerationFailureKind.NoMoments => "No Shorts found", GenerationFailureKind.Settings => "Check your Gemini settings",
            GenerationFailureKind.Temporary => "Gemini is unavailable right now", _ => "Couldn’t make Shorts",
        };
        var card = ModalCard(title, "\uE7BA", "Amber"); var body = (StackPanel)card.Child;
        body.Children.Add(Text(failure.Message));
        if (!failure.IsExport && failure.Kind == GenerationFailureKind.NoMoments) body.Children.Add(Text("Change the clip length or which part of the video Prism looks in, then try again.", 12, muted: true));
        if (!failure.IsExport && failure.Kind == GenerationFailureKind.Temporary) body.Children.Add(Text("This is a temporary problem on Google’s side, not with your video or its range. Prism already retried for about a minute and tried the other Gemini models too. Wait a little, then try again.", 12, muted: true));
        var buttons = new List<Button>();
        if (failure.IsExport) buttons.Add(Button("Export options", () => { session.GenerationError = null; session.ChooseExport(); }, true));
        else
        {
            if (failure.Kind == GenerationFailureKind.Temporary) buttons.Add(Button("Change model", () => { session.GenerationError = null; Navigate(Screen.Settings); }));
            buttons.Add(Button("Try again", async () => { session.GenerationError = null; await session.MakeConfiguredShorts(); }, failure.Kind is GenerationFailureKind.Temporary or GenerationFailureKind.Other));
            if (failure.Kind is GenerationFailureKind.Settings or GenerationFailureKind.NoMoments)
                buttons.Add(Button(failure.Kind == GenerationFailureKind.Settings ? "Open Settings" : "Change clip length or range", () =>
                { session.GenerationError = null; Navigate(failure.Kind == GenerationFailureKind.Settings ? Screen.Settings : Screen.ImportSource); }, true));
        }
        body.Children.Add(Footer(Button("Close", () => session.GenerationError = null), buttons.ToArray())); return card;
    }

    Border ExportDoneCard(string summary)
    {
        var cancelled = summary.StartsWith("Export cancelled", StringComparison.Ordinal);
        var card = cancelled ? ModalCard("Export cancelled") : ModalCard("Export finished", "\uE930", "Accent"); var body = (StackPanel)card.Child;
        body.Children.Add(Text(summary));
        if (session.LastExportShortCount > 0) body.Children.Add(Text($"Shorts: {session.LastExportQuality.Resolution()} · 30 fps · {session.LastExportQuality.Codec()} MP4, ready to upload.", 12, muted: true));
        body.Children.Add(Footer(Button("Done", () => session.ExportSummary = null), Button("Show in Explorer", () => { session.ExportSummary = null; session.RevealExports(); }, true)));
        return card;
    }

    Border ExportCard()
    {
        var initial = session.ExportChoice!; var card = ModalCard("Export", "\uE72D"); var body = (StackPanel)card.Child;
        var clips = session.Project?.Segments ?? []; var selected = initial.ShortIds.ToHashSet();
        var checks = new Dictionary<Guid, CheckBox>();
        var all = Link(Button("Select all", () => { var active = checks.Values.Any(check => check.IsChecked != true); foreach (var check in checks.Values) check.IsChecked = active; }));
        all.SetResourceReference(ForegroundProperty, "Accent"); all.HorizontalAlignment = HorizontalAlignment.Right; all.Margin = new Thickness(0);
        body.Children.Add(SplitRow(Label12("Shorts"), all));
        var rows = Column();
        if (clips.Count == 0) rows.Children.Add(Text("No Shorts yet. You can still export the main video.", 12, muted: true));
        foreach (var (clip, index) in clips.Select((clip, index) => (clip, index)))
        {
            var line = new DockPanel { LastChildFill = true };
            var length = Text(Format.Clock(clip.Duration), 11, muted: true, mono: true); length.Margin = new Thickness(8, 0, 0, 0); DockPanel.SetDock(length, Dock.Right); line.Children.Add(length);
            var number = Text($"Short {index + 1}", 12); number.FontWeight = FontWeights.Medium; number.Margin = new Thickness(0, 0, 8, 0); DockPanel.SetDock(number, Dock.Left); line.Children.Add(number);
            var name = Text(clip.SuggestedTitle ?? "", 12, muted: true); name.TextWrapping = TextWrapping.NoWrap; name.TextTrimming = TextTrimming.CharacterEllipsis; line.Children.Add(name);
            var check = new CheckBox { Content = line, IsChecked = selected.Contains(clip.Id), HorizontalContentAlignment = HorizontalAlignment.Stretch, Margin = new Thickness(0, 3, 0, 3) };
            void Toggled()
            {
                if (check.IsChecked == true) selected.Add(clip.Id); else selected.Remove(clip.Id);
                if (session.ExportChoice is { } choice) session.ExportChoice = choice with { ShortIds = selected.ToHashSet(), Error = null };
            }
            check.Checked += (_, _) => Toggled(); check.Unchecked += (_, _) => Toggled();
            rows.Children.Add(check); checks[clip.Id] = check;
        }
        var list = Scroll(rows); list.MaxHeight = 220; body.Children.Add(list);
        body.Children.Add(Divider(new Thickness(0, 12, 0, 12)));
        var videos = session.Project?.Media.Count(media => media.Kind == "video") ?? 0;
        var main = Text(videos > 1 ? $"Main videos ({videos})" : "Main video", 12); main.FontWeight = FontWeights.Medium; main.Margin = new Thickness(0);
        var source = new CheckBox { Content = Column(main, Text("The original long video, copied as is.", 11, muted: true)), IsChecked = initial.IncludeSource };
        void SourceToggled() { if (session.ExportChoice is { } choice) session.ExportChoice = choice with { IncludeSource = source.IsChecked == true, Error = null }; }
        source.Checked += (_, _) => SourceToggled(); source.Unchecked += (_, _) => SourceToggled(); body.Children.Add(source);
        body.Children.Add(Divider(new Thickness(0, 12, 0, 12)));
        body.Children.Add(Label12("Quality"));
        var qualities = Enum.GetValues<ExportQuality>();
        var segments = new System.Windows.Controls.Primitives.UniformGrid { Rows = 1, Margin = new Thickness(0, 4, 0, 4) };
        var qualityButtons = new List<Button>();
        foreach (var quality in qualities)
        {
            var option = Button(quality.Title(), () => { if (session.ExportChoice is { } choice) session.ExportChoice = choice with { Quality = quality, Error = null }; });
            option.FontSize = 12; option.MinHeight = 32; option.Padding = new Thickness(6, 0, 6, 0); option.Margin = new Thickness(0, 0, quality == qualities[^1] ? 0 : 6, 0); option.HorizontalAlignment = HorizontalAlignment.Stretch;
            segments.Children.Add(option); qualityButtons.Add(option);
        }
        body.Children.Add(segments);
        var qualityDetail = Text("", 11, muted: true); body.Children.Add(qualityDetail);
        body.Children.Add(Divider(new Thickness(0, 12, 0, 12)));
        body.Children.Add(Label12("Save to"));
        var path = Text(initial.Folder, 12); path.TextWrapping = TextWrapping.NoWrap; path.TextTrimming = TextTrimming.CharacterEllipsis; path.Margin = new Thickness(0);
        var change = Button("Change…", () => { if (ChooseFolder("Export here") is { } folder && session.ExportChoice is { } choice) session.ExportChoice = choice with { Folder = folder, Error = null }; });
        change.MinHeight = 30; change.FontSize = 12; change.Padding = new Thickness(12, 0, 12, 0); change.Margin = new Thickness(8, 0, 0, 0);
        var folderMark = Glyph("\uE8B7", 13, "Muted"); folderMark.Margin = new Thickness(0, 0, 8, 0);
        var where = new DockPanel(); DockPanel.SetDock(folderMark, Dock.Left); DockPanel.SetDock(change, Dock.Right); where.Children.Add(folderMark); where.Children.Add(change); where.Children.Add(path);
        var whereBox = new Border { Child = where, CornerRadius = new CornerRadius(8), Padding = new Thickness(10, 6, 6, 6), Margin = new Thickness(0, 4, 0, 0) };
        whereBox.SetResourceReference(Border.BackgroundProperty, "Surface2"); body.Children.Add(whereBox);
        var error = Text("", 12); error.SetResourceReference(TextBlock.ForegroundProperty, "Amber"); body.Children.Add(error);
        var export = Button("Export", async () => { if (session.ExportChoice is { } choice) await session.Export(choice); }, true);
        body.Children.Add(Footer(Button("Cancel", () => session.ExportChoice = null), export));
        updateModal = () =>
        {
            if (session.ExportChoice is not { } choice) return;
            error.Text = choice.Error is null ? "" : "⚠ " + choice.Error; error.Visibility = choice.Error is null ? Visibility.Collapsed : Visibility.Visible;
            var count = choice.ShortIds.Count + (choice.IncludeSource ? videos : 0);
            export.Content = count == 1 ? "Export 1 file" : $"Export {count} files";
            export.IsEnabled = count > 0 && !string.IsNullOrWhiteSpace(choice.Folder);
            all.Content = checks.Values.All(check => check.IsChecked == true) ? "Select none" : "Select all"; all.Visibility = checks.Count > 0 ? Visibility.Visible : Visibility.Collapsed;
            path.Text = choice.Folder; path.ToolTip = choice.Folder;
            for (var index = 0; index < qualities.Length; index++)
            {
                var on = qualities[index] == choice.Quality; var option = qualityButtons[index];
                option.SetResourceReference(BackgroundProperty, on ? "AccentWash" : "Surface2"); option.SetResourceReference(BorderBrushProperty, on ? "Accent" : "Surface2");
                option.SetResourceReference(ForegroundProperty, on ? "Accent" : "Ink");
            }
            qualityDetail.Text = choice.Quality.Detail() + " Applies to Shorts; the main video keeps its original quality.";
        };
        return card;
    }

    static TextBlock Label12(string title) { var label = Text(title, 12, muted: true); label.FontWeight = FontWeights.Medium; return label; }

    /// Escape closes the popup that offers a way out, as Cancel or Close would; progress, the key gate and work in flight stay.
    bool Dismiss()
    {
        if (localCard is not null) { CloseLocal(); return true; }
        if (modalKind.StartsWith("error:", StringComparison.Ordinal)) { session.GenerationError = null; return true; }
        if (modalKind.StartsWith("done:", StringComparison.Ordinal)) { session.ExportSummary = null; return true; }
        if (modalKind == "export") { session.ExportChoice = null; return true; }
        return false;
    }

    void ShowLocal(Border card) { localCard = card; localRevision++; RefreshModal(); }
    void CloseLocal() { localCard = null; RefreshModal(); }
    void ShowNotice(string title, string message)
    {
        var card = ModalCard(title); var body = (StackPanel)card.Child;
        var close = Button("Close", CloseLocal, true); close.HorizontalAlignment = HorizontalAlignment.Right;
        body.Children.Add(Text(message)); body.Children.Add(close); ShowLocal(card);
    }
    void Prompt(string title, string placeholder, string initial, Action<string> accepted)
    {
        var card = ModalCard(title); var body = (StackPanel)card.Child; var entry = Entry(initial, placeholder);
        void Submit() { var value = entry.Text.Trim(); if (value.Length == 0) return; CloseLocal(); accepted(value); }
        entry.KeyDown += (_, args) => { if (args.Key == Key.Enter) { args.Handled = true; try { Submit(); } catch (Exception error) { ShowNotice("Could not complete action", error.Message); } } };
        body.Children.Add(entry); body.Children.Add(Footer(Button("Cancel", CloseLocal), Button("Save", Submit, true)));
        ShowLocal(card); entry.Focus(); entry.SelectAll();
    }
    void Confirm(string title, string message, string confirm, Action action)
    {
        var card = ModalCard(title); var body = (StackPanel)card.Child;
        body.Children.Add(Text(message)); body.Children.Add(Footer(Button("Cancel", CloseLocal), Button(confirm, () => { CloseLocal(); action(); }, danger: true))); ShowLocal(card);
    }
}
