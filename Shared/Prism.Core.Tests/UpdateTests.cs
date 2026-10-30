using System.Net;
using System.Security.Cryptography;
using System.Text;
using Prism.Core;

namespace Prism.Core.Tests;

/// The updater and the first-video tutorial; GitHub is a fake that serves one release.
public class UpdateTests
{
    sealed class FakeGitHub(string version, byte[] installer, string sum) : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            var path = request.RequestUri!.AbsolutePath;
            HttpContent body = path switch
            {
                "/repos/tarassamb-bit/Prismclips/releases/latest" => new StringContent($$"""
                    {"tag_name":"v{{version}}","body":"## What's Changed\n* Faster **exports** by @me\n* Sign-in card\n","assets":[
                    {"name":"Prism-Windows-Setup.exe","browser_download_url":"https://example.test/setup.exe"},
                    {"name":"SHA256SUMS.txt","browser_download_url":"https://example.test/sums.txt"}]}
                    """),
                "/sums.txt" => new StringContent($"{sum}  Prism-Windows-Setup.exe\n"),
                "/setup.exe" => new ByteArrayContent(installer),
                _ => throw new InvalidOperationException(path),
            };
            return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK) { Content = body });
        }
    }

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public async Task OnlyAVerifiedNewerInstallerIsOffered(bool matches)
    {
        var installer = Encoding.UTF8.GetBytes("installer " + Guid.NewGuid());
        var sum = matches ? Convert.ToHexStringLower(SHA256.HashData(installer)) : new string('0', 64);
        var settings = new AppSettings();
        using var github = new FakeGitHub("0.3.0", installer, sum);
        var updater = new AppUpdater(settings, "0.2.0", true, "Prism-Windows-Setup.exe", github);
        await updater.CheckForUpdates();
        Assert.Equal(matches ? "0.3.0" : null, updater.ReadyVersion);
        Assert.Equal(matches, updater.ReadyInstaller is { } path && File.Exists(path));
        if (!matches) { Assert.Contains("checksum", updater.CheckResult); return; }
        Assert.Equal(["Faster exports by @me", "Sign-in card"], updater.ReleaseNotes);
        Assert.NotNull(updater.PrepareInstall());

        // The relaunched version says what changed once, then remembers it in its history.
        var relaunched = new AppUpdater(settings, "0.3.0", true, "Prism-Windows-Setup.exe", github);
        Assert.Equal("0.3.0", relaunched.UpdatedVersion);
        Assert.Equal(["Faster exports by @me", "Sign-in card"], relaunched.UpdatedNotes);
        Assert.Equal(["0.2.0", "0.3.0"], settings.UpdateHistory.Select(r => r.Version));
        Assert.Null(new AppUpdater(settings, "0.3.0", true, "Prism-Windows-Setup.exe", github).UpdatedVersion);
    }

    [Fact]
    public async Task UpToDateAndDevelopmentBuildsDoNotDownload()
    {
        using var github = new FakeGitHub("0.2.0", [], "");
        var current = new AppUpdater(new AppSettings(), "0.2.0", true, "Prism-Windows-Setup.exe", github);
        await current.CheckForUpdates();
        Assert.Equal("You're up to date.", current.CheckResult);
        var development = new AppUpdater(new AppSettings(), "0.0.0", false, "Prism-Windows-Setup.exe", github);
        await development.CheckForUpdates();
        Assert.Null(development.CheckResult);
        Assert.True(AppUpdater.IsNewer("0.10.0", "0.9.1"));
        Assert.False(AppUpdater.IsNewer("1.0.0-beta", "1.0.0"));
    }

    [Fact]
    public void TutorialFollowsTheFlowAndIsKeptPerAccount()
    {
        var settings = new AppSettings();
        var tutorial = new FirstRunTutorial(settings);
        tutorial.Connect(" Me@Example.com ");
        Assert.Equal(FirstRunTutorial.Step.Start, tutorial.Current);
        tutorial.Follow(FirstRunTutorial.Flow.Upload);
        tutorial.Follow(FirstRunTutorial.Flow.Editor);
        Assert.Equal(FirstRunTutorial.Step.Retry, tutorial.Current);
        tutorial.DidCreateVideo();
        Assert.Equal(["me@example.com"], settings.TutorialCompletedAccounts);
        tutorial.ExploreEditor();
        foreach (var _ in Enumerable.Range(0, 5)) tutorial.Next();
        Assert.False(tutorial.IsActive);

        var again = new FirstRunTutorial(settings);
        again.Connect("me@example.com");
        Assert.False(again.IsActive);
        again.Connect("new@example.com");
        Assert.Equal(FirstRunTutorial.Step.Start, again.Current);
        again.Dismiss();
        Assert.DoesNotContain("new@example.com", settings.TutorialCompletedAccounts);
    }
}
