using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Threading;
using Prism.Core;

namespace Prism.Windows;

/// Updates as on the Mac: checked on launch and every few hours, downloaded in the background, then a calm banner offers
/// "Restart to update". Settings › Updates shows the version, the last check and what changed.
public sealed partial class PrismWindow
{
    readonly AppUpdater updater;
    readonly Border updateBanner = new() { Visibility = Visibility.Collapsed, MaxWidth = 560, Margin = new Thickness(0, 0, 0, 24), Padding = new Thickness(16),
        CornerRadius = new CornerRadius(14), BorderThickness = new Thickness(1), HorizontalAlignment = HorizontalAlignment.Center, VerticalAlignment = VerticalAlignment.Bottom };
    readonly DispatcherTimer updateTimer = new() { Interval = AppUpdater.CheckInterval };
    string bannerKey = "";

    static string CurrentVersion()
    {
        var version = Assembly.GetExecutingAssembly().GetCustomAttribute<AssemblyInformationalVersionAttribute>()?.InformationalVersion ?? "0.0.0";
        return version.Split('+')[0];
    }

    // Only the installed app updates: Inno Setup leaves its uninstaller beside Prism.exe, a development build has none.
    AppUpdater CreateUpdater() => new(session.Settings, CurrentVersion(), File.Exists(Path.Combine(AppContext.BaseDirectory, "unins000.exe")), "Prism-Windows-Setup.exe");

    void StartUpdates()
    {
        updateBanner.SetResourceReference(Border.BackgroundProperty, "Surface1");
        updateBanner.SetResourceReference(Border.BorderBrushProperty, "Line");
        updater.PropertyChanged += (_, _) => SessionChanged(this, new System.ComponentModel.PropertyChangedEventArgs(null));
        updateTimer.Tick += (_, _) => _ = updater.CheckForUpdates();
        updateTimer.Start();
        Dispatcher.BeginInvoke(DispatcherPriority.ApplicationIdle, new Action(() => { if (!disposed) _ = updater.CheckForUpdates(); }));
    }

    /// Installs the downloaded update and reopens Prism. Waits while an export or AI task runs.
    void RestartToUpdate()
    {
        if (session.IsBusy || updater.PrepareInstall() is not { } installer) return;
        try { Process.Start(new ProcessStartInfo(installer, "/VERYSILENT /SUPPRESSMSGBOXES /NORESTART") { UseShellExecute = true }); }
        catch (Exception error) { ShowNotice("Could not start the update", error.Message); return; }
        Close();
    }

    /// A downloaded update, or the first launch after one: small and calm, at the bottom, never over a popup.
    void RefreshBanner()
    {
        var updated = updater.UpdatedVersion is not null;
        var ready = !updated && updater.ReadyVersion is not null && !updater.IsBannerDismissed;
        var show = (updated || ready) && modalKind.Length == 0 && !session.IsPlayerExpanded;
        updateBanner.Visibility = show ? Visibility.Visible : Visibility.Collapsed;
        var key = $"{show}:{updated}:{updater.ReadyVersion}:{session.IsBusy}";
        if (!show || key == bannerKey) return;
        bannerKey = key;
        var lines = Column();
        var heading = Text(updated ? $"Updated to Prism {updater.UpdatedVersion}" : "New version ready — Restart to update", 13); heading.FontWeight = FontWeights.Medium;
        lines.Children.Add(heading);
        if (ready) lines.Children.Add(Text($"Prism {updater.ReadyVersion}", 11, muted: true, mono: true));
        var notes = updated ? updater.UpdatedNotes : updater.ReleaseNotes;
        if (updated && notes.Count == 0) lines.Children.Add(Text("You're on the latest version.", 12, muted: true));
        if (updated && notes.Count > 0) lines.Children.Add(Text("What's new", 11, muted: true));
        foreach (var line in notes) lines.Children.Add(Text("• " + line, 12, muted: true));
        if (ready && session.IsBusy) lines.Children.Add(Text("Available when the current export or AI task finishes.", 11, muted: true));
        var icon = Glyph(updated ? "" : "", 18, "Accent"); icon.Margin = new Thickness(0, 0, 14, 0); icon.VerticalAlignment = VerticalAlignment.Top;
        var actions = updated
            ? Row(Button("Got it", () => updater.UpdatedVersion = null, true))
            : Row(Link(Button("Later", () => updater.IsBannerDismissed = true)), Button("Restart to update", RestartToUpdate, true));
        foreach (var button in actions.Children.OfType<Button>()) { button.Margin = new Thickness(8, 0, 0, 0); button.VerticalAlignment = VerticalAlignment.Top; }
        if (!updated) ((Button)actions.Children[1]).IsEnabled = !session.IsBusy;
        var row = new DockPanel(); DockPanel.SetDock(icon, Dock.Left); row.Children.Add(icon); DockPanel.SetDock(actions, Dock.Right); row.Children.Add(actions);
        lines.Margin = new Thickness(0, 0, 12, 0); row.Children.Add(lines);
        updateBanner.Child = row;
        System.Windows.Automation.AutomationProperties.SetName(updateBanner, updated ? "Prism was updated" : "New version ready");
    }

    UIElement UpdateSettings()
    {
        var section = Column(SectionTitle("", "Updates"),
            Text("Prism checks for updates when it opens and every few hours, downloads them in the background and asks you to restart when one is ready. Every download is checked against its published checksum, and Prism refuses any that doesn't match.", muted: true),
            Divider(new Thickness(0, 14, 0, 14)));
        var current = Text("Current version", 14); current.FontWeight = FontWeights.Medium; current.Margin = new Thickness(0, 0, 0, 5);
        var version = new TextBox { Text = $"Prism {updater.Version}", IsReadOnly = true, BorderThickness = new Thickness(0), Background = System.Windows.Media.Brushes.Transparent, Padding = new Thickness(0) };
        version.SetResourceReference(FontFamilyProperty, "MonoFont"); version.SetResourceReference(ForegroundProperty, "Muted");
        var check = Button("Check for updates…", async () => { await updater.CheckForUpdates(); InvalidateScreen(); });
        check.IsEnabled = updater.IsEnabled && !session.IsBusy;
        section.Children.Add(SplitRow(Column(current, version), check));
        if (updater.ReadyVersion is { } ready)
        {
            var label = Text($"Prism {ready} is downloaded and ready.", 13); label.FontWeight = FontWeights.Medium; label.SetResourceReference(TextBlock.ForegroundProperty, "Accent");
            section.Children.Add(label);
            foreach (var line in updater.ReleaseNotes) section.Children.Add(Text("• " + line, 12, muted: true));
            var restart = Button("Restart to update", RestartToUpdate, true); restart.IsEnabled = !session.IsBusy; restart.HorizontalAlignment = HorizontalAlignment.Left;
            section.Children.Add(restart);
            if (session.IsBusy) section.Children.Add(Text("Available when the current export or AI task finishes.", 11, muted: true));
        }
        else if (updater.AvailableVersion is { } available)
        {
            var label = Text($"Prism {available} is available. It is downloading.", 13); label.FontWeight = FontWeights.Medium; label.SetResourceReference(TextBlock.ForegroundProperty, "Accent");
            section.Children.Add(label);
            foreach (var line in updater.AvailableNotes) section.Children.Add(Text("• " + line, 12, muted: true));
        }
        else if (updater.CheckResult is { } result)
        {
            var label = Text(result, 13, muted: true); label.FontWeight = FontWeights.Medium; section.Children.Add(label);
        }
        if (updater.LastCheck is { } last) section.Children.Add(Text($"Last checked {last:d MMM yyyy, HH:mm}", 12, muted: true));
        if (!updater.IsEnabled) section.Children.Add(Text("Updates are off in this build. Install Prism from prismclips.app to get updates.", 12, muted: true));
        section.Children.Add(Divider(new Thickness(0, 14, 0, 14)));
        var changes = Text("What changed", 14); changes.FontWeight = FontWeights.Medium; section.Children.Add(changes);
        if (updater.History.Count == 0) section.Children.Add(Text("Versions you run will be listed here with their changes.", 12, muted: true));
        foreach (var release in updater.History.Reverse())
        {
            var name = Text(release.Version == updater.Version ? $"Prism {release.Version} · current" : $"Prism {release.Version}", 13); name.FontWeight = FontWeights.Medium; name.Margin = new Thickness(0, 8, 0, 4);
            section.Children.Add(name);
            if (release.Notes.Count == 0) section.Children.Add(Text("No notes were published for this version.", 12, muted: true));
            foreach (var line in release.Notes) section.Children.Add(Text("• " + line, 12, muted: true));
        }
        return Surface(section, padding: 24);
    }
}
