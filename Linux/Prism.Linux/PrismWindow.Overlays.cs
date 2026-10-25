using Prism.Core;

namespace Prism.Linux;

public sealed partial class PrismWindow
{
    int localRevision;

    void RefreshModal()
    {
        var desired = localCard is not null ? "local:" + localRevision
            : !session.IsGeminiKeySaved ? "key"
            : session.GenerationProgress is not null ? "progress"
            : session.IsBusy ? "working"
            : session.IsTestingGemini ? "testing"
            : session.GenerationError is { } failure ? "error:" + failure.GetHashCode()
            : session.ExportSummary is { } summary ? "done:" + summary
            : session.ExportChoice is not null ? "export" : "";
        var blocked = desired.Length > 0;
        layout.Sensitive = !blocked;
        editor.Widget.Sensitive = !blocked;
        if (desired == modalKind) { updateModal?.Invoke(); return; }
        if (modal is not null) overlay.RemoveOverlay(modal);
        modal = null;
        updateModal = null;
        modalKind = desired;
        if (!blocked) return;
        var card = desired switch
        {
            "key" => KeyGate(), "progress" => ProgressCard(), "working" => WorkingCard(), "testing" => WorkingCard(true), "export" => ExportCard(),
            _ when desired.StartsWith("error:", StringComparison.Ordinal) => ErrorCard(session.GenerationError!),
            _ when desired.StartsWith("done:", StringComparison.Ordinal) => ExportDoneCard(session.ExportSummary!),
            _ => localCard!,
        };
        var dim = Column(0);
        dim.AddCssClass("scrim");
        if (desired == "key") dim.AddCssClass("gate");
        dim.Hexpand = true;
        dim.Vexpand = true;
        var above = Column(0); above.Vexpand = true;
        var below = Column(0); below.Vexpand = true;
        card.SetSizeRequest(desired == "key" ? 500 : 460, -1);
        var viewport = Scroll(card);
        viewport.Vexpand = false;
        viewport.Hexpand = false;
        viewport.Halign = Gtk.Align.Center;
        viewport.PropagateNaturalHeight = true;
        viewport.PropagateNaturalWidth = true;
        viewport.MaxContentHeight = Math.Max(400, window.GetHeight() - 80);
        viewport.MaxContentWidth = 620;
        dim.Append(above);
        dim.Append(viewport);
        dim.Append(below);
        modal = dim;
        overlay.AddOverlay(dim);
        updateModal?.Invoke();
    }

    /// The Mac app's popup card: a 16 pt title with an optional tinted icon.
    static Gtk.Box ModalCard(string title, string? icon = null, string? tint = null)
    {
        var card = Column(14);
        card.AddCssClass("modal");
        var heading = Row(10);
        if (icon is not null) { var mark = Icon(icon, 16); if (tint is not null) mark.AddCssClass(tint); heading.Append(mark); }
        var label = Text(title, "t16", "medium");
        if (tint is not null) label.AddCssClass(tint);
        heading.Append(label);
        card.Append(heading);
        return card;
    }

    /// Secondary action left, the rest right: the Mac popups' footer.
    static Gtk.Box Footer(Gtk.Widget left, params Gtk.Widget[] right)
    {
        var row = Row(8);
        row.MarginTop = 6;
        row.Append(left);
        row.Append(Gap());
        foreach (var widget in right) row.Append(widget);
        return row;
    }

    Gtk.Box KeyGate()
    {
        var card = Column(14);
        card.AddCssClass("modal");
        card.Append(BrandMark());
        card.Append(Text("Prism uses Google Gemini to find, cut, caption and frame your Shorts, so it needs your own Gemini API key before it can work. Google bills your AI Studio account for what Prism uses; the free tier works too.", "muted"));
        card.Append(Text("1. Create a key"));
        card.Append(Button("Open Google AI Studio › API keys", () => LinuxPlatform.OpenExternal("https://aistudio.google.com/apikey")));
        card.Append(Text("2. Paste it here"));
        var key = Entry(session.GeminiKey, "Paste your API key", value => session.GeminiKey = value);
        key.Visibility = false;
        key.OnActivate += async (_, _) => { if (!session.IsTestingGemini) await session.VerifyAndSaveGeminiKey(); };
        card.Append(key);
        var feedback = Text(session.GeminiKeyStatus, "muted");
        card.Append(feedback);
        card.Append(Text("The key stays in your desktop keyring, or a private configuration file when the keyring is unavailable. Audio, transcripts and sampled frames from your videos are sent to Google.", "muted"));
        var save = Button("Save and continue", async () => await session.VerifyAndSaveGeminiKey(), "primary");
        save.Halign = Gtk.Align.End;
        card.Append(save);
        updateModal = () =>
        {
            feedback.SetText(session.GeminiKeyStatus);
            if (session.GeminiKeyRejected) feedback.AddCssClass("warning"); else feedback.RemoveCssClass("warning");
            save.Sensitive = !session.IsTestingGemini && !string.IsNullOrWhiteSpace(session.GeminiKey);
            key.Sensitive = !session.IsTestingGemini;
        };
        OnUI(() => { if (!disposed && modalKind == "key") key.GrabFocus(); });
        return card;
    }

    Gtk.Box ProgressCard()
    {
        var card = Column(14);
        card.AddCssClass("modal");
        var stage = Label(session.GenerationStage, "t14", "medium");
        stage.Ellipsize = Pango.EllipsizeMode.End;
        stage.Hexpand = true;
        var percent = Label("", "mono");
        var top = Row(8);
        top.Append(stage); top.Append(percent);
        var progress = Gtk.ProgressBar.New();
        var detail = Label("", "mono");
        card.Append(top);
        card.Append(progress);
        card.Append(Text(session.IsExporting ? "Your files are being prepared for export." : "Gemini finds complete moments, aligns speech and follows the subject.", "muted"));
        var cancel = Button("Cancel", session.CancelGeneration);
        card.Append(Footer(detail, cancel));
        updateModal = () =>
        {
            stage.SetText(session.GenerationStage);
            progress.Fraction = Math.Clamp(session.GenerationProgress ?? 0, 0, 1);
            percent.SetText($"{progress.Fraction * 100:0}%");
            detail.SetText($"Elapsed {Format.Clock((DateTime.Now - session.GenerationStartedAt).TotalSeconds)}");
            cancel.Sensitive = session.GenerationStage != "Cancelling…";
        };
        return card;
    }

    Gtk.Box WorkingCard(bool testing = false)
    {
        var card = ModalCard(testing ? "Checking Gemini…" : "Working…");
        var spinner = Gtk.Spinner.New();
        spinner.Start();
        spinner.Halign = Gtk.Align.Center;
        card.Append(spinner);
        var message = Text(session.Message);
        card.Append(message);
        updateModal = () => message.SetText(testing ? session.GeminiKeyStatus : session.Message);
        return card;
    }

    Gtk.Box ErrorCard(GenerationFailure failure)
    {
        var title = failure.IsExport ? "Export failed" : failure.Kind switch
        {
            GenerationFailureKind.NoMoments => "No Shorts found", GenerationFailureKind.Settings => "Check your Gemini settings",
            GenerationFailureKind.Temporary => "Gemini is unavailable right now", _ => "Couldn’t make Shorts",
        };
        var card = ModalCard(title, "dialog-warning-symbolic", "warning");
        card.Append(Text(failure.Message));
        if (!failure.IsExport && failure.Kind == GenerationFailureKind.NoMoments)
            card.Append(Text("Change the clip length or which part of the video Prism looks in, then try again.", "muted"));
        if (!failure.IsExport && failure.Kind == GenerationFailureKind.Temporary)
            card.Append(Text("This is a temporary problem on Google’s side, not with your video or its range. Prism already retried for about a minute and tried the other Gemini models too. Wait a little, then try again.", "muted"));
        var buttons = new List<Gtk.Widget>();
        if (failure.IsExport)
            buttons.Add(Button("Export options", () => { session.GenerationError = null; session.ChooseExport(); }, "primary"));
        else
        {
            if (failure.Kind == GenerationFailureKind.Temporary)
                buttons.Add(Button("Change model", () => { session.GenerationError = null; Navigate(Screen.Settings); }));
            buttons.Add(Button("Try again", async () => { session.GenerationError = null; await session.MakeConfiguredShorts(); },
                failure.Kind is GenerationFailureKind.Temporary or GenerationFailureKind.Other ? "primary" : null));
            if (failure.Kind is GenerationFailureKind.Settings or GenerationFailureKind.NoMoments)
                buttons.Add(Button(failure.Kind == GenerationFailureKind.Settings ? "Open Settings" : "Change clip length or range", () =>
                {
                    session.GenerationError = null;
                    Navigate(failure.Kind == GenerationFailureKind.Settings ? Screen.Settings : Screen.ImportSource);
                }, "primary"));
        }
        card.Append(Footer(Button("Close", () => session.GenerationError = null), buttons.ToArray()));
        return card;
    }

    Gtk.Box ExportDoneCard(string summary)
    {
        var card = summary.StartsWith("Export cancelled", StringComparison.Ordinal) ? ModalCard("Export cancelled") : ModalCard("Export finished", "object-select-symbolic", "accent");
        card.Append(Text(summary));
        if (session.LastExportShortCount > 0)
            card.Append(Text($"Shorts: {session.LastExportQuality.Resolution()} · 30 fps · {session.LastExportQuality.Codec()} MP4, ready to upload.", "muted"));
        card.Append(Footer(Button("Done", () => session.ExportSummary = null), Button("Show in file manager", () =>
        { session.ExportSummary = null; session.RevealExports(); }, "primary")));
        return card;
    }

    Gtk.Box ExportCard()
    {
        var initial = session.ExportChoice!;
        var card = ModalCard("Export", "document-send-symbolic");
        var clips = session.Project?.Segments ?? [];
        var selected = initial.ShortIds.ToHashSet();
        var checks = new Dictionary<Guid, Gtk.CheckButton>();
        var all = Button("Select all", () =>
        {
            var active = checks.Values.Any(check => !check.Active);
            foreach (var check in checks.Values) check.Active = active;
        }, "link accent");
        var shortsLabel = Label("Shorts", "muted", "medium");
        card.Append(Footer(shortsLabel, all));
        var rows = Column(8);
        if (clips.Count == 0) rows.Append(Text("No Shorts yet. You can still export the main video.", "muted"));
        foreach (var (clip, index) in clips.Select((clip, index) => (clip, index)))
        {
            var line = Row(8);
            line.Append(Label($"Short {index + 1}", "t12", "medium"));
            var name = Label(clip.SuggestedTitle ?? "", "muted");
            name.Ellipsize = Pango.EllipsizeMode.End;
            name.Hexpand = true;
            line.Append(name);
            line.Append(Label(Format.Clock(clip.Duration), "mono"));
            var checkbox = Gtk.CheckButton.New();
            checkbox.Child = line;
            checkbox.Active = selected.Contains(clip.Id);
            checkbox.OnToggled += (_, _) =>
            {
                if (checkbox.Active) selected.Add(clip.Id); else selected.Remove(clip.Id);
                if (session.ExportChoice is { } choice) session.ExportChoice = choice with { ShortIds = selected.ToHashSet(), Error = null };
            };
            checks[clip.Id] = checkbox;
            rows.Append(checkbox);
        }
        var list = Scroll(rows);
        list.Vexpand = false;
        list.SetSizeRequest(-1, Math.Min(210, Math.Max(40, clips.Count * 34)));
        card.Append(list);
        var videos = session.Project?.Media.Count(media => media.Kind == "video") ?? 0;
        var source = Gtk.CheckButton.NewWithLabel(videos > 1 ? $"Main videos ({videos})" : "Main video");
        source.Active = initial.IncludeSource;
        source.OnToggled += (_, _) =>
        { if (session.ExportChoice is { } choice) session.ExportChoice = choice with { IncludeSource = source.Active, Error = null }; };
        var sourceWords = Column(2);
        sourceWords.Append(Label(videos > 1 ? $"Main videos ({videos})" : "Main video", "t12", "medium"));
        sourceWords.Append(Label("The original long video, copied as is.", "muted", "t11"));
        source.Child = sourceWords;
        card.Append(Divider());
        card.Append(source);
        card.Append(Divider());
        var qualities = Enum.GetValues<ExportQuality>();
        card.Append(Label("Quality", "muted", "medium"));
        var segments = Gtk.Box.New(Gtk.Orientation.Horizontal, 6);
        segments.Homogeneous = true;
        var qualityButtons = new List<Gtk.Button>();
        foreach (var quality in qualities)
        {
            var option = Button(quality.Title(), () => { if (session.ExportChoice is { } choice) session.ExportChoice = choice with { Quality = quality, Error = null }; }, "compact");
            option.Halign = Gtk.Align.Fill;
            segments.Append(option); qualityButtons.Add(option);
        }
        card.Append(segments);
        var qualityDetail = Text("", "muted");
        card.Append(qualityDetail);
        card.Append(Divider());
        card.Append(Label("Save to", "muted", "medium"));
        var folderMark = Icon("folder-symbolic", 14);
        folderMark.AddCssClass("muted");
        var folder = Label(initial.Folder);
        folder.Ellipsize = Pango.EllipsizeMode.Middle;
        folder.Hexpand = true;
        var folderRow = Row(8);
        folderRow.AddCssClass("inset");
        folderRow.Append(folderMark);
        folderRow.Append(folder);
        folderRow.Append(Button("Change…", async () =>
        {
            var picked = await ChooseFolder("Export here");
            if (picked is not null && session.ExportChoice is { } choice) session.ExportChoice = choice with { Folder = picked, Error = null };
        }, "compact"));
        card.Append(folderRow);
        var error = Text("", "warning");
        card.Append(error);
        var export = Button("Export", async () => { if (session.ExportChoice is { } choice) await session.Export(choice); }, "primary");
        card.Append(Footer(Button("Cancel", () => session.ExportChoice = null), export));
        updateModal = () =>
        {
            if (session.ExportChoice is not { } choice) return;
            error.SetText(choice.Error ?? "");
            error.Visible = choice.Error is not null;
            var count = choice.ShortIds.Count + (choice.IncludeSource ? videos : 0);
            export.Label = count == 1 ? "Export 1 file" : $"Export {count} files";
            export.Sensitive = count > 0 && !string.IsNullOrWhiteSpace(choice.Folder);
            all.Label = checks.Values.All(check => check.Active) ? "Select none" : "Select all";
            all.Visible = checks.Count > 0;
            folder.SetText(choice.Folder); folder.TooltipText = choice.Folder;
            for (var index = 0; index < qualities.Length; index++)
                if (qualities[index] == choice.Quality) { qualityButtons[index].AddCssClass("primary"); } else qualityButtons[index].RemoveCssClass("primary");
            qualityDetail.SetText(choice.Quality.Detail() + " Applies to Shorts; the main video keeps its original quality.");
        };
        return card;
    }

    /// Escape closes the popup that offers a way out, as Cancel or Close would; progress, the key gate and work in flight stay.
    bool Dismiss()
    {
        if (localCard is not null) { CloseLocal(); return true; }
        if (modalKind.StartsWith("error:", StringComparison.Ordinal)) { session.GenerationError = null; return true; }
        if (modalKind.StartsWith("done:", StringComparison.Ordinal)) { session.ExportSummary = null; return true; }
        if (modalKind == "export") { session.ExportChoice = null; return true; }
        return false;
    }

    void ShowLocal(Gtk.Box card) { localCard = card; localRevision++; RefreshModal(); }
    void CloseLocal() { localCard = null; RefreshModal(); }

    void ShowNotice(string title, string message)
    {
        var card = ModalCard(title);
        card.Append(Text(message));
        var close = Button("Close", CloseLocal, "primary");
        close.Halign = Gtk.Align.End;
        card.Append(close);
        ShowLocal(card);
    }

    void Prompt(string title, string placeholder, string initial, Action<string> accepted)
    {
        var card = ModalCard(title);
        var entry = Entry(initial, placeholder);
        void Submit()
        {
            var value = entry.GetText().Trim();
            if (value.Length == 0) return;
            CloseLocal();
            accepted(value);
        }
        entry.OnActivate += (_, _) => Submit();
        card.Append(entry);
        card.Append(Footer(Button("Cancel", CloseLocal), Button("Save", Submit, "primary")));
        ShowLocal(card);
        entry.GrabFocus();
    }

    void Confirm(string title, string message, string confirm, Action action)
    {
        var card = ModalCard(title);
        card.Append(Text(message));
        card.Append(Footer(Button("Cancel", CloseLocal), Button(confirm, () => { CloseLocal(); action(); }, "danger")));
        ShowLocal(card);
    }
}
