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
        tiles.Append(CategoryTile(0, "avatar-default-symbolic", "Account", session.Account.Email ?? "Sign in to track your stats"));
        tiles.Append(CategoryTile(1, "computer-symbolic", "System resources", "RAM and storage updates"));
        page.Append(tiles);
        page.Append(settingsCategory switch { 0 => AccountSettings(), _ => ResourceSettings() });
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

    /// The Prism account, as on the Mac: sign in, and each export adds to your stats on the website.
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
