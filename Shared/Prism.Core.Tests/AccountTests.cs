using Prism.Core;

namespace Prism.Core.Tests;

/// The account's local behaviour; nothing here reaches the network.
public class AccountTests
{
    sealed class MemoryKeys : IKeyStore
    {
        public string Value = "";
        public bool RejectSave;
        public string Read() => Value;
        public void Save(string key) { if (RejectSave) throw new IOException("Credential store unavailable"); Value = key; }
    }

    sealed class DelayedAccount : HttpMessageHandler
    {
        public readonly TaskCompletionSource Started = new(TaskCreationOptions.RunContinuationsAsynchronously);
        public readonly TaskCompletionSource Release = new(TaskCreationOptions.RunContinuationsAsynchronously);
        public readonly List<string> Paths = [];
        public string Reply = """{"refresh_token":"new-refresh","access_token":"access"}""";
        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            Paths.Add(request.RequestUri!.PathAndQuery);
            Started.TrySetResult();
            await Release.Task.WaitAsync(cancellationToken);
            return new HttpResponseMessage(System.Net.HttpStatusCode.OK) { Content = new StringContent(Reply) };
        }
    }

    [Fact]
    public async Task SignUpReturnsToTheProductionWebsiteAndWaitsForEmailConfirmation()
    {
        var keys = new MemoryKeys();
        using var handler = new DelayedAccount { Reply = """{"id":"pending-user"}""" };
        handler.Release.SetResult();
        using var client = new HttpClient(handler);
        var account = new Account(keys, client);
        await account.SignUp("me@example.com", "password");

        var request = new Uri(Account.ProjectUrl, Assert.Single(handler.Paths));
        Assert.Equal("/auth/v1/signup", request.AbsolutePath);
        Assert.Equal("?redirect_to=https://prismclips.vercel.app/login", Uri.UnescapeDataString(request.Query));
        Assert.False(account.IsSignedIn);
        Assert.Equal("", keys.Value);
        Assert.Contains("Check your inbox", account.Status);
    }

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public async Task LateAuthenticationCannotReverseSignOut(bool refresh)
    {
        var keys = new MemoryKeys { Value = refresh ? """{"Email":"me@example.com","RefreshToken":"old"}""" : "" };
        using var handler = new DelayedAccount();
        using var client = new HttpClient(handler);
        var account = new Account(keys, client);
        var pending = refresh ? account.RecordExport(1, 10, "full") : account.SignIn("me@example.com", "password");
        await handler.Started.Task;
        account.SignOut();
        handler.Release.SetResult();
        await pending;
        Assert.False(account.IsSignedIn);
        Assert.False(account.IsWorking);
        Assert.Equal("", keys.Value);
        Assert.Single(handler.Paths);
        Assert.StartsWith("Signed out.", account.Status);
    }

    [Fact]
    public async Task ExportsQueuedDuringAnAccountSwitchAreNotAttributedToTheNewAccount()
    {
        var keys = new MemoryKeys { Value = """{"Email":"old@example.com","RefreshToken":"old"}""" };
        using var handler = new DelayedAccount();
        using var client = new HttpClient(handler);
        var account = new Account(keys, client);
        var signIn = account.SignIn("new@example.com", "password");
        await handler.Started.Task;
        var export = account.RecordExport(1, 10, "full");
        handler.Release.SetResult();
        await Task.WhenAll(signIn, export);
        Assert.Equal("new@example.com", account.Email);
        Assert.Single(handler.Paths);
    }

    [Fact]
    public void FailedSignOutIsReportedAndKeepsTheSavedAccountVisible()
    {
        var keys = new MemoryKeys { Value = """{"Email":"me@example.com","RefreshToken":"old"}""", RejectSave = true };
        var account = new Account(keys);
        account.SignOut();
        Assert.True(account.IsSignedIn);
        Assert.StartsWith("Could not sign out:", account.Status);
        Assert.Contains("old", keys.Value);
    }

    [Theory]
    [InlineData("{}")]
    [InlineData("{\"Email\":\"me@example.com\"}")]
    [InlineData("{\"Email\":\" \u0020\",\"RefreshToken\":\"token\"}")]
    public void IncompleteSavedSessionsAreSignedOut(string json)
    {
        Assert.False(new Account(new MemoryKeys { Value = json }).IsSignedIn);
    }

    [Fact]
    public async Task IncompleteAuthRepliesAreNotSaved()
    {
        var keys = new MemoryKeys();
        using var handler = new DelayedAccount { Reply = """{"refresh_token":"refresh"}""" };
        handler.Release.SetResult();
        using var client = new HttpClient(handler);
        var account = new Account(keys, client);
        await account.SignIn("me@example.com", "password");
        Assert.False(account.IsSignedIn);
        Assert.Equal("", keys.Value);
        Assert.Contains("incomplete", account.Status);
    }

    [Fact]
    public void ASavedSignInIsRestoredAndSigningOutForgetsIt()
    {
        var keys = new MemoryKeys { Value = """{"Email":"me@example.com","RefreshToken":"token"}""" };
        var account = new Account(keys);
        Assert.True(account.IsSignedIn);
        Assert.Equal("me@example.com", account.Email);
        account.SignOut();
        Assert.False(account.IsSignedIn);
        Assert.Equal("", keys.Value);
    }

    [Fact]
    public void ABrokenSavedSignInCountsAsSignedOut()
    {
        Assert.False(new Account(new MemoryKeys { Value = "not json" }).IsSignedIn);
    }

    [Fact]
    public async Task AShortPasswordIsRejectedBeforeAnythingIsSent()
    {
        var account = new Account(new MemoryKeys());
        await account.SignIn("me@example.com", "12345");
        Assert.False(account.IsSignedIn);
        Assert.False(account.IsWorking);
        Assert.Equal("Enter your email and a password of at least 6 characters.", account.Status);
    }

    [Fact]
    public async Task SignedOutExportsAreNotRecorded()
    {
        var account = new Account(new MemoryKeys());
        await account.RecordExport(3, 90, "full");
        Assert.Equal("", account.Status);
    }

    [Fact]
    public async Task OneRefreshServesManyRequestsAndUsageIsRead()
    {
        var keys = new MemoryKeys { Value = """{"Email":"me@example.com","RefreshToken":"old"}""" };
        using var handler = new DelayedAccount { Reply = """{"refresh_token":"new","access_token":"access","expires_in":3600}""" };
        handler.Release.SetResult();
        using var client = new HttpClient(handler);
        var account = new Account(keys, client);
        Assert.Equal("access", await account.CurrentAccessToken());
        Assert.Equal("access", await account.CurrentAccessToken());
        Assert.Single(handler.Paths);
        handler.Reply = """[{"used":12.5,"allowance":60}]""";
        Assert.Equal((12.5, 60.0), await account.UsageStatus());
        handler.Reply = "true";
        Assert.True(await account.UsageAllowed(new string('a', 64), 2, new DateTime(2026, 10, 30)));
        Assert.Equal(["/rest/v1/rpc/my_usage", "/rest/v1/rpc/usage_allowed"], handler.Paths.Skip(1));
        account.SignOut();
        Assert.Null(await account.CurrentAccessToken());
    }
}
