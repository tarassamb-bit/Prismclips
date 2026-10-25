using System.Globalization;
using Prism.Core;

namespace Prism.Linux;

public sealed partial class PrismWindow
{
    Gtk.Widget SettingsPage()
    {
        var page = Column(0);
        page.AddCssClass("section");
        page.MarginStart = page.MarginEnd = 8;
        page.Append(Label("Settings", "d32"));
        var subtitle = Label("Choose a category to configure Prism.", "muted", "t14");
        subtitle.MarginTop = 6;
        page.Append(subtitle);
        var tiles = Row(14);
        tiles.MarginTop = 16; tiles.MarginBottom = 20;
        tiles.Append(CategoryTile(0, "weather-overcast-symbolic", "AI & Cloud", "Provider, key, and model"));
        tiles.Append(CategoryTile(2, "avatar-default-symbolic", "Account", session.Account.Email ?? "Sign in to track your stats"));
        tiles.Append(CategoryTile(1, "computer-symbolic", "System resources", "RAM and storage updates"));
        page.Append(tiles);
        page.Append(settingsCategory switch { 0 => AiSettings(), 2 => AccountSettings(), _ => ResourceSettings() });
        return Scroll(page);
    }

    Gtk.Button CategoryTile(int category, string icon, string title, string detail)
    {
        var selected = settingsCategory == category;
        var tile = Button("", () => { settingsCategory = category; InvalidateScreen(); }, selected ? "category selected" : "category");
        tile.SetSizeRequest(190, 136);
        tile.Hexpand = false; // the spacer inside would otherwise make every tile claim spare width
        var box = Gtk.CenterBox.New();
        box.AddCssClass("icon-box");
        var mark = Icon(icon, 18);
        mark.AddCssClass("accent");
        box.CenterWidget = mark;
        box.Halign = Gtk.Align.Start;
        var top = Row(0);
        top.Append(box);
        top.Append(Gap());
        if (selected) { var check = Icon("object-select-symbolic", 16); check.AddCssClass("accent"); top.Append(check); }
        var name = Label(title, "t14", "medium");
        name.MarginTop = 11;
        var note = Text(detail, "muted", "t10");
        note.Lines = 2;
        note.Ellipsize = Pango.EllipsizeMode.End;
        note.MaxWidthChars = 24;
        var body = Column(4);
        body.Append(top); body.Append(name); body.Append(note);
        body.Valign = Gtk.Align.Start;
        tile.Child = body;
        return tile;
    }

    static Gtk.Box SectionTitle(string icon, string title)
    {
        var row = Row(10);
        row.Append(Icon(icon, 18));
        row.Append(Label(title, "d20"));
        return row;
    }

    Gtk.Widget AiSettings()
    {
        var section = Column(10);
        section.Append(SectionTitle("weather-overcast-symbolic", "AI & Cloud"));
        section.Append(Text("Gemini handles clip selection, transcription, subtitles, framing and editor chat.", "muted"));
        var rule = Divider(); rule.MarginTop = rule.MarginBottom = 6; section.Append(rule);
        section.Append(Label("Google AI Studio API key", "t14", "medium"));
        var stateIcon = Icon("dialog-password-symbolic", 14);
        var stateText = Label("", "medium");
        stateText.Hexpand = true;
        var hidden = Label("Hidden for security", "muted");
        var state = Row(10);
        state.AddCssClass("surface-r12");
        state.Append(stateIcon); state.Append(stateText); state.Append(hidden);
        section.Append(state);
        var keyRow = Row(10);
        keyRow.AddCssClass("inset");
        keyRow.SetSizeRequest(-1, 46);
        section.Append(keyRow);
        var test = Button("Test connection", async () => await session.TestGeminiKey());
        var remove = Button("Remove saved key", () => Confirm("Remove saved key?", "Prism needs your Gemini API key before it can work.", "Remove key", session.RemoveGeminiKey), "danger");
        var actions = Row(8);
        actions.MarginTop = 4;
        actions.Append(test); actions.Append(remove);
        section.Append(actions);
        var feedback = Text(session.GeminiKeyStatus, "muted");
        section.Append(feedback);
        section.Append(Button("Get a key from Google AI Studio", () => LinuxPlatform.OpenExternal("https://aistudio.google.com/apikey"), "link accent"));
        var rule2 = Divider(); rule2.MarginTop = rule2.MarginBottom = 6; section.Append(rule2);
        var models = Gemini.Models;
        var model = Combo(models.Select(item => item.Title), Math.Max(0, Array.FindIndex(models, item => item.Id == session.GeminiModel)), index =>
        { if (index >= 0) session.GeminiModel = models[index].Id; });
        model.Valign = Gtk.Align.Center;
        var modelWords = Column(4);
        modelWords.Hexpand = true;
        modelWords.Append(Label("Gemini model", "t14", "medium"));
        modelWords.Append(Label("The default is recommended. Change it if you prefer.", "muted"));
        var modelRow = Row(18);
        modelRow.Append(modelWords); modelRow.Append(model);
        section.Append(modelRow);
        section.Append(Text("Cloud AI sends audio, transcripts and sampled frames to Google. Chat sends your request, recent conversation and edit summary. Google API charges may apply. Video rendering and subject tracking run on your computer. The key stays in your desktop keyring, or a private configuration file when the keyring is unavailable.", "muted"));

        string structure = "";
        Gtk.Entry? typed = null;
        Gtk.Button? save = null;
        updateScreen = () =>
        {
            var saved = session.IsGeminiKeySaved;
            stateIcon.SetFromIconName(saved ? "security-high-symbolic" : "dialog-password-symbolic");
            if (saved) stateIcon.AddCssClass("accent"); else stateIcon.RemoveCssClass("accent");
            stateText.SetText(saved ? "API key saved securely" : "No API key saved");
            hidden.Visible = remove.Visible = saved;
            feedback.SetText(session.GeminiKeyStatus);
            test.Label = session.IsTestingGemini ? "Testing…" : "Test connection";
            var desired = $"{saved}:{session.IsEditingGeminiKey}:{session.IsShowingGeminiKey}";
            if (structure != desired)
            {
                structure = desired;
                typed = null; save = null;
                Clear(keyRow);
                var lead = Icon(saved && !session.IsEditingGeminiKey ? "system-lock-screen-symbolic" : "dialog-password-symbolic", 14);
                lead.AddCssClass("muted");
                keyRow.Append(lead);
                if (!saved || session.IsEditingGeminiKey)
                {
                    typed = Entry(session.GeminiKey, saved ? "Enter a new API key" : "Paste your API key", value => session.GeminiKey = value);
                    typed.Visibility = false;
                    typed.AddCssClass("plain");
                    typed.OnActivate += async (_, _) => { if (!session.IsTestingGemini && !string.IsNullOrWhiteSpace(session.GeminiKey)) await session.VerifyAndSaveGeminiKey(); };
                    keyRow.Append(typed);
                    if (saved) keyRow.Append(Button("Cancel", session.CancelGeminiKeyEdit, "link"));
                    save = Button(saved ? "Save" : "Save key", async () => await session.VerifyAndSaveGeminiKey(), "primary compact");
                    keyRow.Append(save);
                }
                else
                {
                    var value = Label(session.IsShowingGeminiKey ? session.RevealedGeminiKey : new string('•', 24), "mono");
                    value.Selectable = session.IsShowingGeminiKey;
                    value.Ellipsize = Pango.EllipsizeMode.Middle;
                    value.Hexpand = true;
                    keyRow.Append(value);
                    keyRow.Append(IconButton(session.IsShowingGeminiKey ? "view-conceal-symbolic" : "view-reveal-symbolic", session.IsShowingGeminiKey ? "Hide API key" : "Show API key", session.ToggleGeminiKeyVisibility));
                    keyRow.Append(IconButton("document-edit-symbolic", "Edit API key", session.EditGeminiKey));
                }
            }
            if (typed is not null) typed.Sensitive = !session.IsTestingGemini;
            if (save is not null) save.Sensitive = !session.IsTestingGemini && !string.IsNullOrWhiteSpace(session.GeminiKey);
            test.Sensitive = !session.IsTestingGemini;
            remove.Sensitive = !session.IsTestingGemini && !session.IsEditingGeminiKey;
            section.Sensitive = !session.IsBusy;
        };
        return section;
    }

    /// The optional Prism account, as on the Mac: sign in, and each export adds to your stats on the website.
    Gtk.Widget AccountSettings()
    {
        var section = Column(10);
        section.Append(SectionTitle("avatar-default-symbolic", "Account"));
        section.Append(Text("Optional. When you're signed in, each export adds its date, number of Shorts, length and quality to your stats on the Prism website. Videos, transcripts and file names stay on your computer.", "muted"));
        var rule = Divider(); rule.MarginTop = rule.MarginBottom = 6; section.Append(rule);
        var account = session.Account;
        Action? enable = null;
        if (account.Email is { } email)
        {
            var row = Row(10);
            row.AddCssClass("surface-r12");
            var check = Icon("object-select-symbolic", 16); check.AddCssClass("accent"); row.Append(check);
            var who = Label($"Signed in as {email}", "medium"); who.Hexpand = true; who.Ellipsize = Pango.EllipsizeMode.End; row.Append(who);
            row.Append(Button("Sign out", account.SignOut, "danger compact"));
            section.Append(row);
            section.Append(Button("See your stats in the browser", () => LinuxPlatform.OpenExternal(Account.StatsPage), "link accent"));
        }
        else
        {
            var address = Entry("", "Email");
            var password = Entry("", "Password (at least 6 characters)");
            password.Visibility = false;
            var signIn = Button("Sign in", async () => { await account.SignIn(address.GetText(), password.GetText()); if (account.IsSignedIn) password.SetText(""); }, "primary");
            var create = Button("Create account", async () => { await account.SignUp(address.GetText(), password.GetText()); password.SetText(""); });
            enable = () => signIn.Sensitive = create.Sensitive = !account.IsWorking && address.GetText().Trim().Length > 0 && password.GetText().Length > 0;
            address.OnChanged += (_, _) => enable(); password.OnChanged += (_, _) => enable();
            password.OnActivate += async (_, _) => { if (signIn.Sensitive) { await account.SignIn(address.GetText(), password.GetText()); if (account.IsSignedIn) password.SetText(""); } };
            var buttons = Row(8); buttons.Append(signIn); buttons.Append(create);
            section.Append(address); section.Append(password); section.Append(buttons);
            enable();
        }
        var status = Text(account.Status, "muted");
        section.Append(status);
        updateScreen = () => { enable?.Invoke(); status.SetText(account.Status); status.Visible = account.Status.Length > 0; };
        return section;
    }

    Gtk.Widget ResourceSettings()
    {
        var profile = MachineProfile.Detect();
        (string Title, double Seconds)[] intervals =
        [
            ("1 second", 1), ("5 seconds", 5), ("10 seconds", 10), ("30 seconds", 30), ("1 minute", 60),
            ("5 minutes", 300), ("10 minutes", 600), ("15 minutes", 900), ("30 minutes", 1800), ("45 minutes", 2700), ("60 minutes", 3600),
        ];
        var tiles = Gtk.Box.New(Gtk.Orientation.Horizontal, 14);
        tiles.Homogeneous = true;
        tiles.MarginTop = 18;
        tiles.Append(ResourceTile("Memory used", string.Create(CultureInfo.InvariantCulture, $"{profile.MemoryUsedGB:0.0} / {profile.MemoryGB} GB"), profile.MemoryUsage, "memory"));
        tiles.Append(ResourceTile("Storage available", $"{profile.FreeGB} / {profile.StorageGB} GB", profile.FreeStorageRatio, "storage"));
        var interval = Combo(intervals.Select(item => item.Title), Math.Max(0, Array.FindIndex(intervals, item => item.Seconds == session.Settings.ResourceRefreshSeconds)), index =>
        {
            if (index < 0) return;
            session.Settings.ResourceRefreshSeconds = intervals[index].Seconds;
            session.Settings.Save();
            RestartResourceTimer();
        });
        interval.Valign = Gtk.Align.Center;
        var words = Column(4);
        words.Hexpand = true;
        words.Append(Label("Sidebar update frequency", "t14", "medium"));
        words.Append(Label("Choose from 1 second to 60 minutes.", "muted"));
        var row = Row(18);
        row.Append(words); row.Append(interval);
        var rule = Divider(); rule.MarginTop = 20; rule.MarginBottom = 16;
        var machine = Label($"{profile.OS} · {profile.Cores} CPU cores · {profile.MemoryGB} GB RAM", "mono");
        machine.MarginTop = 14;
        var panel = Surface(8, SectionTitle("computer-symbolic", "System resources"), Text("Monitor this computer and choose how often the sidebar refreshes.", "muted"), tiles, rule, row, machine);
        return panel;
    }

    static Gtk.Box ResourceTile(string title, string value, double fraction, string tint)
    {
        var bar = Gtk.ProgressBar.New();
        bar.Fraction = Math.Clamp(fraction, 0, 1);
        bar.AddCssClass("thick");
        bar.AddCssClass(tint);
        bar.MarginTop = 6;
        var tile = Column(6);
        tile.AddCssClass("page-tile");
        tile.Append(Label(title, "muted", "t13"));
        tile.Append(Label(value, "d20"));
        tile.Append(bar);
        return tile;
    }
}
