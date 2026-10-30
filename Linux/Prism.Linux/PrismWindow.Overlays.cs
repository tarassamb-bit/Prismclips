using Prism.Core;

namespace Prism.Linux;

public sealed partial class PrismWindow
{
    int localRevision;

    void RefreshModal()
    {
        var desired = localCard is not null ? "local:" + localRevision
            : !session.Account.IsSignedIn ? "signin"
            : session.GenerationProgress is not null ? "progress"
            : session.IsBusy ? "working"
            : session.PendingPaidRun is { } paid ? "paid:" + paid.GetHashCode()
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
            "signin" => SignInGate(), "progress" => ProgressCard(), "working" => WorkingCard(), "export" => ExportCard(),
            _ when desired.StartsWith("paid:", StringComparison.Ordinal) => PaidRunCard(session.PendingPaidRun!),
            _ when desired.StartsWith("error:", StringComparison.Ordinal) => ErrorCard(session.GenerationError!),
            _ when desired.StartsWith("done:", StringComparison.Ordinal) => ExportDoneCard(session.ExportSummary!),
            _ => localCard!,
        };
        var dim = Column(0);
        dim.AddCssClass("scrim");
        if (desired == "signin") dim.AddCssClass("gate");
        dim.Hexpand = true;
        dim.Vexpand = true;
        var above = Column(0); above.Vexpand = true;
        var below = Column(0); below.Vexpand = true;
        card.SetSizeRequest(460, -1);
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

    /// Until someone signs in, Prism's AI can't run, so this card covers the app. It signs in or creates the account in place.
    Gtk.Box SignInGate()
    {
        var card = Column(14);
        card.AddCssClass("modal");
        card.Append(BrandMark());
        card.Append(Label("Sign in to Prism", "d20"));
        card.Append(Text("Sign in or create a free account to start. Prism's AI runs on our server, so you don't need an API key.", "muted"));
        var account = session.Account;
        var address = Entry("", "Email");
        var password = Entry("", "Password (at least 6 characters)");
        password.Visibility = false;
        var status = Text("", "muted");
        async Task SignIn() { await account.SignIn(address.GetText(), password.GetText()); if (account.IsSignedIn) password.SetText(""); }
        var signIn = Button("Sign in", SignIn, "primary");
        var create = Button("Create account", async () => { await account.SignUp(address.GetText(), password.GetText()); password.SetText(""); });
        password.OnActivate += async (_, _) => { if (signIn.Sensitive) await SignIn(); };
        card.Append(address); card.Append(password); card.Append(status);
        card.Append(Footer(create, signIn));
        updateModal = () =>
        {
            status.SetText(account.Status); status.Visible = account.Status.Length > 0;
            signIn.Label = account.IsWorking ? "Signing in…" : "Sign in";
            signIn.Sensitive = create.Sensitive = !account.IsWorking && address.GetText().Trim().Length > 0 && password.GetText().Length > 0;
        };
        address.OnChanged += (_, _) => updateModal?.Invoke(); password.OnChanged += (_, _) => updateModal?.Invoke();
        OnUI(() => { if (!disposed && modalKind == "signin") address.GrabFocus(); });
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
        card.Append(Text(session.IsExporting ? "Your files are being prepared for export." : "Prism AI finds complete moments, aligns speech and follows the subject.", "muted"));
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

    Gtk.Box WorkingCard()
    {
        var card = ModalCard("Working…");
        var spinner = Gtk.Spinner.New();
        spinner.Start();
        spinner.Halign = Gtk.Align.Center;
        card.Append(spinner);
        var message = Text(session.Message);
        card.Append(message);
        updateModal = () => message.SetText(session.Message);
        return card;
    }

    /// A re-analysis charges part of the video's minutes, so it waits for a yes.
    Gtk.Box PaidRunCard(AppSession.PaidRun run)
    {
        var minutes = Math.Max(1, (int)Math.Ceiling(run.Minutes));
        var card = ModalCard("Use your minutes?");
        card.Append(Text($"This re-analysis will use {minutes} {(minutes == 1 ? "minute" : "minutes")} of your plan."));
        card.Append(Text("Re-analyzing a video uses part of its length: half on Trial, a third on Creator and Studio.", "muted"));
        card.Append(Footer(Button("Cancel", () => session.PendingPaidRun = null), Button("Re-analyze", () => session.ConfirmPaidRun(), "primary")));
        return card;
    }

    Gtk.Box ErrorCard(GenerationFailure failure)
    {
        var (title, advice) = failure.IsExport ? ("Export failed", null) : failure.Kind switch
        {
            GenerationFailureKind.NoMoments => ("No Shorts found", "Change the clip length or which part of the video Prism looks in, then try again."),
            GenerationFailureKind.Settings => ("Check your Prism AI settings", null),
            GenerationFailureKind.Temporary => ("Prism AI is unavailable right now",
                "This is a temporary problem with the AI service, not with your video or its range. Prism already retried for about a minute and tried the other Prism AI models too. Wait a little, then try again."),
            GenerationFailureKind.Limit => ("Usage limit reached", "Shorts you already made stay available, and you can keep editing and exporting them."),
            _ => ("Couldn’t make Shorts", (string?)null),
        };
        var card = ModalCard(title, "dialog-warning-symbolic", "warning");
        card.Append(Text(failure.Message));
        if (advice is not null) card.Append(Text(advice, "muted"));
        var buttons = new List<Gtk.Widget>();
        if (failure.IsExport)
            buttons.Add(Button("Export options", () => { session.GenerationError = null; session.ChooseExport(); }, "primary"));
        else if (failure.Kind != GenerationFailureKind.Limit)
        {
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
