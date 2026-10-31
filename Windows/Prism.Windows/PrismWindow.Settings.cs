using System.Globalization;
using System.Windows;
using System.Windows.Automation;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Media;
using Prism.Core;

namespace Prism.Windows;

public sealed partial class PrismWindow
{
    UIElement SettingsPage()
    {
        var page = Column(Text("Settings", 32, display: true), Text("Choose a category to configure Prism.", muted: true));
        page.Margin = new Thickness(32); page.MaxWidth = 1064; page.HorizontalAlignment = HorizontalAlignment.Left;
        // Opening Settings shows the account's current minutes, as on the Mac.
        if (session.Account.Email is { } email && usageAccount != email && !usageLoading) { usageLoading = true; Dispatcher.BeginInvoke(new Action(() => _ = RefreshUsage())); }
        var tiles = Row(
            CategoryTile(0, "\uE77B", "Account", session.Account.Email ?? "Sign in to track your stats"),
            CategoryTile(1, "\uEC4A", "Usage", UsageTileDetail()),
            CategoryTile(2, "", "System resources", "RAM and storage updates"));
        tiles.Margin = new Thickness(0, 16, 0, 20); page.Children.Add(tiles);
        tiles.Children.Add(CategoryTile(3, "\uE895", "Updates", $"Prism {updater.Version}"));
        page.Children.Add(settingsCategory switch { 0 => AccountSettings(), 1 => UsageSettings(), 3 => UpdateSettings(), _ => ResourceSettings() });
        return Scroll(page);
    }

    Button CategoryTile(int category, string glyph, string title, string detail)
    {
        var selected = settingsCategory == category;
        var tile = Button("", () => { settingsCategory = category; InvalidateScreen(); });
        tile.SetResourceReference(StyleProperty, "Tile"); tile.Width = 190; tile.Height = 136; tile.Padding = new Thickness(14); tile.Margin = new Thickness(0, 0, 14, 0);
        tile.SetResourceReference(BackgroundProperty, selected ? "AccentWash" : "Surface1");
        tile.SetResourceReference(BorderBrushProperty, selected ? "Accent" : "Surface2"); tile.BorderThickness = new Thickness(selected ? 2 : 1);
        var box = new Border { Width = 38, Height = 38, CornerRadius = new CornerRadius(12), Child = Glyph(glyph, 18, "Accent") };
        box.SetResourceReference(Border.BackgroundProperty, "Surface2");
        var top = new DockPanel { Margin = new Thickness(0, 0, 0, 11) };
        if (selected) { var check = Glyph("", 16, "Accent"); DockPanel.SetDock(check, Dock.Right); top.Children.Add(check); }
        top.Children.Add(WithLeft(box));
        var name = Text(title, 14); name.FontWeight = FontWeights.Medium; name.Margin = new Thickness(0, 0, 0, 4);
        var note = Text(detail, 10, muted: true); note.MaxHeight = 28; note.TextTrimming = TextTrimming.CharacterEllipsis; note.Margin = new Thickness(0);
        tile.Content = Column(top, name, note);
        AutomationProperties.SetName(tile, title);
        return tile;
    }

    static StackPanel SectionTitle(string glyph, string title)
    {
        var mark = Glyph(glyph, 18, "Ink"); mark.Margin = new Thickness(0, 0, 10, 0);
        return Row(mark, Text(title, 20, display: true));
    }

    /// The Prism account, as on the Mac: sign in, and each export adds to your stats on the website.
    UIElement AccountSettings()
    {
        var section = Column(SectionTitle("\uE77B", "Account"),
            Text("Optional. When you're signed in, each export adds its date, number of Shorts, length and quality to your stats on the Prism website. Videos, transcripts and file names stay on your PC.", muted: true),
            Divider(new Thickness(0, 14, 0, 14)));
        var account = session.Account;
        static Button Stretched(Button button) { button.HorizontalAlignment = HorizontalAlignment.Stretch; button.Margin = new Thickness(0, 10, 0, 0); return button; }
        if (account.Email is { } email)
        {
            var check = Glyph("\uE930", 16, "Accent"); check.Margin = new Thickness(0, 0, 10, 0);
            var who = Text($"Signed in as {email}", 13); who.FontWeight = FontWeights.Medium; who.Margin = new Thickness(0);
            section.Children.Add(Surface(Row(check, who), 12, 12));
            section.Children.Add(Stretched(Button("Sign out", account.SignOut, danger: true)));
            section.Children.Add(Stretched(Button("See your stats in the browser", () => WindowsPlatform.OpenExternal(Account.StatsPage))));
            section.Children.Add(Stretched(Button("Replay first-video tutorial", () => { session.Tutorial.Restart(email); Navigate(Screen.Home); })));
        }
        else
        {
            var address = Entry("", "Email"); address.Margin = new Thickness(0, 0, 0, 8);
            var password = new PasswordBox { Padding = new Thickness(10), Margin = new Thickness(0, 0, 0, 8) };
            AutomationProperties.SetName(password, "Password (at least 6 characters)");
            var hint = Text("Password (at least 6 characters)", 12, muted: true); hint.Margin = new Thickness(0, 0, 0, 4);
            var signIn = Button("Sign in", async () => { await account.SignIn(address.Text, password.Password); if (account.IsSignedIn) password.Clear(); }, true);
            var create = Button("Create account", async () => { await account.SignUp(address.Text, password.Password); password.Clear(); });
            void Enable() => signIn.IsEnabled = create.IsEnabled = !account.IsWorking && address.Text.Trim().Length > 0 && password.Password.Length > 0;
            address.TextChanged += (_, _) => Enable(); password.PasswordChanged += (_, _) => Enable();
            password.KeyDown += async (_, args) => { if (args.Key == Key.Enter && signIn.IsEnabled) { args.Handled = true; await account.SignIn(address.Text, password.Password); if (account.IsSignedIn) password.Clear(); } };
            var buttons = new Grid();
            buttons.ColumnDefinitions.Add(new ColumnDefinition()); buttons.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(10) }); buttons.ColumnDefinitions.Add(new ColumnDefinition());
            foreach (var (button, column) in new[] { (signIn, 0), (create, 2) }) { button.HorizontalAlignment = HorizontalAlignment.Stretch; button.Margin = new Thickness(0); Grid.SetColumn(button, column); buttons.Children.Add(button); }
            section.Children.Add(address); section.Children.Add(hint); section.Children.Add(password); section.Children.Add(buttons);
            Enable();
            updateScreen = Enable;
        }
        var status = Text(account.Status, 12, muted: true); status.Margin = new Thickness(0, 10, 0, 0);
        section.Children.Add(status);
        var inner = updateScreen;
        updateScreen = () => { inner?.Invoke(); status.Text = account.Status; status.Visibility = account.Status.Length > 0 ? Visibility.Visible : Visibility.Collapsed; };
        return section;
    }

    (double Used, double Allowance)? serverUsage;
    string? usageAccount;
    bool usageLoading;
    string promoStatus = "";

    static string MinutesText(double value) => $"{(int)Math.Floor(value)} min";

    string UsageTileDetail()
    {
        if (!session.Account.IsSignedIn) return "Sign in to see usage";
        if (usageAccount != session.Account.Email || serverUsage is not { } usage) return usageLoading ? "Checking usage…" : "Usage unavailable";
        return $"{MinutesText(usage.Used)} of {(int)usage.Allowance} min used";
    }

    /// Fetches the account's minutes; a reply for an account that has since signed out is dropped.
    async Task RefreshUsage()
    {
        var email = session.Account.Email;
        serverUsage = null; usageAccount = null;
        if (email is null) { usageLoading = false; return; }
        usageLoading = true;
        var result = await session.Account.UsageStatus();
        if (disposed || session.Account.Email != email) return;
        serverUsage = result; usageAccount = email; usageLoading = false;
        // Settings rebuilds its tiles; the setup page only updates its minutes note.
        if (session.Screen == Screen.Settings) InvalidateScreen(); else Refresh();
    }

    /// The beta allowance: minutes used so far, what is left, and where a promo code goes.
    UIElement UsageSettings()
    {
        var signedIn = session.Account.IsSignedIn;
        var section = Column(SectionTitle("\uEC4A", "Usage"),
            Text($"Beta accounts get {UsageLimit.Allowance} minutes of video to make Shorts from. A video you already used doesn't count again. Need more? Ask me for a promo code, then enter it below.", muted: true),
            Divider(new Thickness(0, 14, 0, 14)));
        if (serverUsage is { } usage && signedIn && usageAccount == session.Account.Email)
        {
            var used = Text("Used", 14); used.FontWeight = FontWeights.Medium; used.Margin = new Thickness(0);
            var amount = Text($"{MinutesText(usage.Used)} of {(int)usage.Allowance} min", 13, muted: true, mono: true); amount.Margin = new Thickness(0);
            if (usage.Used >= usage.Allowance) amount.SetResourceReference(TextBlock.ForegroundProperty, "Amber");
            var bar = new ProgressBar { Height = 4, Maximum = 1, Value = Math.Min(1, usage.Used / Math.Max(1, usage.Allowance)), Margin = new Thickness(0, 6, 0, 6) };
            section.Children.Add(SplitRow(used, amount)); section.Children.Add(bar);
            section.Children.Add(Text(usage.Used >= usage.Allowance ? "All minutes used · ask for a promo code" : $"{MinutesText(usage.Allowance - usage.Used)} left", 12, muted: true));
        }
        else
        {
            section.Children.Add(Text(!signedIn ? "Sign in to see usage." : usageLoading ? "Checking usage…" : "Usage is unavailable. Check your connection and try again.", 12, muted: true));
            if (signedIn && !usageLoading) section.Children.Add(Button("Retry", () => { _ = RefreshUsage(); InvalidateScreen(); }));
        }
        var promoTitle = Text("Promo code", 14); promoTitle.FontWeight = FontWeights.Medium; promoTitle.Margin = new Thickness(0, 18, 0, 8);
        var code = Entry("", "Enter code");
        async Task Redeem()
        {
            var typed = code.Text;
            if (typed.Trim().Length == 0) return;
            promoStatus = await session.Account.RedeemPromo(typed);
            if (disposed) return;
            await RefreshUsage();
            if (session.Screen == Screen.Settings) InvalidateScreen();
        }
        var redeem = Button("Redeem", Redeem, true); redeem.Margin = new Thickness(10, 0, 0, 0);
        void Enable() => redeem.IsEnabled = code.Text.Trim().Length > 0;
        code.TextChanged += (_, _) => Enable();
        code.KeyDown += async (_, args) => { if (args.Key == Key.Enter && redeem.IsEnabled) { args.Handled = true; await Redeem(); } };
        var entry = new DockPanel(); DockPanel.SetDock(redeem, Dock.Right); entry.Children.Add(redeem); entry.Children.Add(code);
        section.Children.Add(promoTitle); section.Children.Add(entry);
        if (promoStatus.Length > 0) { var status = Text(promoStatus, 12, muted: true); status.Margin = new Thickness(0, 8, 0, 0); section.Children.Add(status); }
        Enable();
        return Surface(section, padding: 24);
    }

    UIElement ResourceSettings()
    {
        var profile = MachineProfile.Detect();
        (string Title, double Seconds)[] intervals = [("1 second", 1), ("5 seconds", 5), ("10 seconds", 10), ("30 seconds", 30), ("1 minute", 60), ("5 minutes", 300), ("10 minutes", 600), ("15 minutes", 900), ("30 minutes", 1800), ("45 minutes", 2700), ("60 minutes", 3600)];
        var tiles = new Grid { Margin = new Thickness(0, 18, 0, 0) };
        tiles.ColumnDefinitions.Add(new ColumnDefinition()); tiles.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(14) }); tiles.ColumnDefinitions.Add(new ColumnDefinition());
        tiles.Children.Add(ResourceTile("Memory used", string.Create(CultureInfo.InvariantCulture, $"{profile.MemoryUsedGB:0.0} / {profile.MemoryGB} GB"), profile.MemoryUsage, Color.FromRgb(175, 82, 222)));
        var free = ResourceTile("Storage available", $"{profile.FreeGB} / {profile.StorageGB} GB", profile.FreeStorageRatio, Color.FromRgb(31, 199, 230));
        Grid.SetColumn(free, 2); tiles.Children.Add(free);
        var frequency = Text("Sidebar update frequency", 14); frequency.FontWeight = FontWeights.Medium;
        var interval = Combo(intervals.Select(item => item.Title), Math.Max(0, Array.FindIndex(intervals, item => item.Seconds == session.Settings.ResourceRefreshSeconds)), index =>
        { if (index >= 0) { session.Settings.ResourceRefreshSeconds = intervals[index].Seconds; session.Settings.Save(); RestartResourceTimer(); } });
        interval.Margin = new Thickness(18, 0, 0, 0); interval.VerticalAlignment = VerticalAlignment.Center;
        AutomationProperties.SetName(interval, "System resource refresh interval");
        var machine = Text($"{profile.OS} · {profile.Cores} CPU cores · {profile.MemoryGB} GB RAM", 11, muted: true, mono: true); machine.Margin = new Thickness(0, 14, 0, 0);
        return Surface(Column(SectionTitle("", "System resources"), Text("Monitor this PC and choose how often the sidebar refreshes.", muted: true), tiles,
            Divider(new Thickness(0, 20, 0, 16)), SplitRow(Column(frequency, Text("Choose from 1 second to 60 minutes.", 12, muted: true)), interval), machine), padding: 24);
    }

    static Border ResourceTile(string title, string value, double fraction, Color tint)
    {
        var bar = new ProgressBar { Height = 7, Maximum = 1, Value = Math.Clamp(fraction, 0, 1), Foreground = Frozen(tint), Margin = new Thickness(0, 8, 0, 0) };
        bar.SetResourceReference(BackgroundProperty, "Surface2");
        var tile = new Border { CornerRadius = new CornerRadius(12), Padding = new Thickness(16), Child = Column(Text(title, muted: true), Text(value, 20, display: true), bar) };
        tile.SetResourceReference(Border.BackgroundProperty, "Surface0");
        return tile;
    }
}
