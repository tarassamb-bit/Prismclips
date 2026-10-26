using System.ComponentModel;
using System.Net.Http.Headers;
using System.Runtime.CompilerServices;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace Prism.Core;

/// The optional Prism account (Supabase email + password), a port of the macOS app's Account. When signed in, each finished
/// export adds one row of stats (date, Shorts, seconds, quality) that the website shows. No video, transcript or file name
/// ever leaves the computer.
public sealed class Account : INotifyPropertyChanged
{
    /// The project's public (publishable) key: safe to ship, because Row Level Security limits every user to their own rows.
    public static readonly Uri ProjectUrl = new("https://isdplhahgggundbohmlr.supabase.co/");
    const string PublishableKey = "sb_publishable_ATTcp2-mrca0swMStHHdYQ_Le851b8l";
    public const string StatsPage = "https://prismclips.vercel.app/login";
    static readonly HttpClient SharedClient = new() { Timeout = TimeSpan.FromSeconds(20) };

    readonly IKeyStore store;
    readonly HttpClient client;
    readonly SemaphoreSlim gate = new(1, 1);
    long sessionRevision, authenticationRequest;
    string? email;
    string status = "";
    bool isWorking;

    public event PropertyChangedEventHandler? PropertyChanged;
    public string? Email { get => email; private set => Set(ref email, value); }
    public string Status { get => status; set => Set(ref status, value); }
    public bool IsWorking { get => isWorking; private set => Set(ref isWorking, value); }
    public bool IsSignedIn => Email is not null;

    public Account(IKeyStore store, HttpClient? client = null)
    {
        this.store = store;
        this.client = client ?? SharedClient;
        email = SavedSession()?.Email;
    }

    public Task SignIn(string email, string password) => Authenticate("auth/v1/token?grant_type=password", email, password);
    public Task SignUp(string email, string password) => Authenticate("auth/v1/signup?redirect_to=" + Uri.EscapeDataString(StatsPage), email, password);

    public void SignOut()
    {
        // Revoke pending sign-ins even when the credential store fails to clear the current session.
        authenticationRequest++;
        IsWorking = false;
        try { store.Save(""); }
        catch (Exception error) { Status = "Could not sign out: " + error.Message; return; }
        sessionRevision++;
        Email = null;
        Status = "Signed out. Exports are no longer counted.";
    }

    /// Adds one export to the account's stats. Failures never affect the export; they only show in Settings.
    public async Task RecordExport(int shortCount, double seconds, string quality)
    {
        if (!IsSignedIn || shortCount <= 0) return;
        var revision = sessionRevision;
        // One at a time: each refresh rotates the saved token, so two overlapping refreshes would spend the same one.
        await gate.WaitAsync();
        try
        {
            if (revision != sessionRevision || await AccessToken(revision) is not { } token) return;
            var body = new JsonObject { ["short_count"] = shortCount, ["seconds"] = seconds, ["quality"] = quality };
            var (ok, _, message, _) = await Send("rest/v1/exports", body, token, minimal: true);
            if (!ok && revision == sessionRevision) Status = $"Could not add this export to your stats: {message}";
        }
        finally { gate.Release(); }
    }

    sealed record Session(string Email, string RefreshToken);

    async Task Authenticate(string path, string address, string password)
    {
        if (IsWorking) return;
        address = address.Trim();
        if (address.Length == 0 || password.Length < 6) { Status = "Enter your email and a password of at least 6 characters."; return; }
        var request = ++authenticationRequest;
        var revision = sessionRevision;
        IsWorking = true;
        await gate.WaitAsync();
        try
        {
            if (request != authenticationRequest || revision != sessionRevision) return;
            revision = ++sessionRevision;
            var (ok, reply, message, _) = await Send(path, new JsonObject { ["email"] = address, ["password"] = password });
            if (request != authenticationRequest || revision != sessionRevision) return;
            if (!ok) { Status = message; return; }
            // Sign-up without a session means Supabase sent a confirmation email first.
            if (Field(reply, "refresh_token") is null) { Status = "Check your inbox to confirm your email, then sign in."; return; }
            if (!Store(reply, address)) return;
            // Exports queued while the old account was still visible belong to that account.
            sessionRevision++;
            Status = "Signed in. Each export now adds to your stats.";
        }
        finally { gate.Release(); if (request == authenticationRequest) IsWorking = false; }
    }

    /// A fresh access token from the saved refresh token. Supabase rotates refresh tokens, so the new one is saved each time.
    async Task<string?> AccessToken(long revision)
    {
        if (SavedSession() is not { } saved) { Email = null; return null; }
        var (ok, reply, message, code) = await Send("auth/v1/token?grant_type=refresh_token", new JsonObject { ["refresh_token"] = saved.RefreshToken });
        if (revision != sessionRevision) return null;
        if (!ok)
        {
            // Only a rejected sign-in ends it; being offline or a server hiccup keeps the account for the next export.
            if (code is 400 or 401 or 403) { Status = $"Your sign-in expired ({message}). Sign in again to keep counting exports."; Forget(); }
            else Status = $"Could not reach your Prism account, so this export was not counted: {message}";
            return null;
        }
        return Store(reply, saved.Email) ? Field(reply, "access_token") : null;
    }

    void Forget()
    {
        try { store.Save(""); } catch (Exception) { }
        Email = null;
    }

    /// Saves the session from an auth response; false when the response has none.
    bool Store(JsonNode? reply, string address)
    {
        if (Field(reply, "refresh_token") is not { Length: > 0 } refresh || string.IsNullOrWhiteSpace(refresh)
            || string.IsNullOrWhiteSpace(Field(reply, "access_token")))
        { Status = "The account service returned an incomplete sign-in. Please try again."; return false; }
        try { store.Save(JsonSerializer.Serialize(new Session(address, refresh))); }
        catch (Exception error) { Status = "Could not save your sign-in: " + error.Message; return false; }
        Email = address;
        return true;
    }

    Session? SavedSession()
    {
        try
        {
            var text = store.Read();
            var session = text.Length == 0 ? null : JsonSerializer.Deserialize<Session>(text);
            return session is not null && !string.IsNullOrWhiteSpace(session.Email) && !string.IsNullOrWhiteSpace(session.RefreshToken) ? session : null;
        }
        catch (Exception) { return null; }
    }

    /// A text field of a JSON reply, or null when it is missing or not text.
    static string? Field(JsonNode? reply, string name) => reply is JsonObject node && node[name] is JsonValue value && value.TryGetValue<string>(out var text) ? text : null;

    /// The reply, or why it failed; Code is the HTTP status, or 0 when the server could not be reached.
    async Task<(bool Ok, JsonNode? Reply, string Message, int Code)> Send(string path, JsonObject body, string? token = null, bool minimal = false)
    {
        try
        {
            using var request = new HttpRequestMessage(HttpMethod.Post, new Uri(ProjectUrl, path))
            {
                Content = new StringContent(body.ToJsonString(), Encoding.UTF8, "application/json"),
            };
            request.Headers.Add("apikey", PublishableKey);
            if (token is not null) request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
            if (minimal) request.Headers.Add("Prefer", "return=minimal");
            using var response = await client.SendAsync(request);
            var text = await response.Content.ReadAsStringAsync();
            JsonNode? reply = null;
            try { reply = text.Length > 0 ? JsonNode.Parse(text) : null; } catch (JsonException) { }
            if (response.IsSuccessStatusCode) return (true, reply, "", (int)response.StatusCode);
            var reason = reply is JsonObject failure
                ? (failure["msg"] ?? failure["error_description"] ?? failure["message"])?.ToString()
                : null;
            return (false, reply, reason ?? $"HTTP {(int)response.StatusCode}", (int)response.StatusCode);
        }
        catch (Exception error) { return (false, null, error.Message, 0); }
    }

    void Set<T>(ref T field, T value, [CallerMemberName] string? name = null)
    {
        if (EqualityComparer<T>.Default.Equals(field, value)) return;
        field = value;
        PropertyChanged?.Invoke(this, new PropertyChangedEventArgs(name));
        if (name == nameof(Email)) PropertyChanged?.Invoke(this, new PropertyChangedEventArgs(nameof(IsSignedIn)));
    }
}
