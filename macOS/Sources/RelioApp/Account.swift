import Foundation

/// The optional Prism account (Supabase email + password). When signed in, each finished export adds one row of stats
/// (date, Shorts, seconds, quality) that the website shows. No video, transcript or file name ever leaves the Mac.
@MainActor @Observable
final class Account {
    /// The project's public (publishable) key: safe to ship, because Row Level Security limits every user to their own rows.
    static let projectURL = URL(string: "https://isdplhahgggundbohmlr.supabase.co")!
    nonisolated static let publishableKey = "sb_publishable_ATTcp2-mrca0swMStHHdYQ_Le851b8l"
    static let statsPage = URL(string: "https://prismclips.vercel.app/login")!
    private static let keychainService = "Relio.Account"
    /// Only the email is kept here, so launching Prism never reads the Keychain; the token is read when an export needs it.
    private static let emailKey = "account.email"

    var email: String?
    var status = ""
    private(set) var isWorking = false
    var isSignedIn: Bool { email != nil }

    init() {
        email = UserDefaults.standard.string(forKey: Self.emailKey)
    }

    /// The signed-in session's access token, refreshed as needed; nil when signed out.
    func currentAccessToken() async -> String? {
        guard isSignedIn else { return nil }
        return await accessToken()
    }

    func signIn(email: String, password: String) async {
        await authenticate(path: "auth/v1/token?grant_type=password", email: email, password: password)
    }

    func signUp(email: String, password: String) async {
        var url = URLComponents(string: "auth/v1/signup")!
        url.queryItems = [URLQueryItem(name: "redirect_to", value: Self.statsPage.absoluteString)]
        await authenticate(path: url.string!, email: email, password: password)
    }

    func signOut() {
        signOutKeepingStatus()
        status = "Signed out. Exports are no longer counted."
    }

    /// Adds one export to the account's stats. Failures never affect the export; they only show in Settings.
    func recordExport(shortCount: Int, seconds: Double, quality: String) async {
        guard isSignedIn, shortCount > 0, let token = await accessToken() else { return }
        var request = Self.request("rest/v1/exports")
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.setValue("return=minimal", forHTTPHeaderField: "Prefer")
        request.httpBody = try? JSONSerialization.data(withJSONObject: ["short_count": shortCount, "seconds": seconds, "quality": quality])
        if case .failure(let message, _) = await Self.send(request) { status = "Could not add this export to your stats: \(message)" }
    }

    // MARK: Video limit

    /// How many analysis runs of `video` (its server key) this account has made, and the minutes the next
    /// re-analysis would charge (0 before the first run); nil when it can't be checked.
    func reanalysis(_ video: String) async -> (runs: Int, charge: Double)? {
        guard isSignedIn, let token = await accessToken() else { return nil }
        var request = Self.request("rest/v1/rpc/my_reanalysis")
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.httpBody = try? JSONSerialization.data(withJSONObject: ["p_video": video])
        guard let (data, response) = try? await URLSession.shared.data(for: request) else { return nil }
        // A server without re-analysis charging doesn't have the function yet (HTTP 404), so every run is a first run there.
        if (response as? HTTPURLResponse)?.statusCode == 404 { return (0, 0) }
        guard (response as? HTTPURLResponse)?.statusCode == 200,
              let row = (try? JSONSerialization.jsonObject(with: data) as? [[String: Any]])?.first,
              let runs = (row["runs"] as? NSNumber)?.intValue,
              let charge = (row["charge"] as? NSNumber)?.doubleValue else { return nil }
        return (runs, charge)
    }

    /// Whether this account may start Shorts from `video`, `minutes` long, today. Nil means the preflight is unavailable;
    /// the AI gateway still checks the account's allowance before processing a request.
    func usageAllowed(video: String, minutes: Double, on day: Date) async -> Bool? {
        guard isSignedIn, let token = await accessToken() else { return nil }
        var request = Self.request("rest/v1/rpc/usage_allowed")
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.httpBody = try? JSONSerialization.data(withJSONObject: ["p_video": video, "p_day": Self.dayString(day), "p_minutes": minutes])
        guard let (data, response) = try? await URLSession.shared.data(for: request),
              (response as? HTTPURLResponse)?.statusCode == 200 else { return nil }
        return (try? JSONSerialization.jsonObject(with: data, options: .fragmentsAllowed)) as? Bool
    }

    /// Minutes this account has used and its allowance (60 plus redeemed promo codes); nil when unavailable.
    func usageStatus() async -> (used: Double, allowance: Double)? {
        guard isSignedIn, let token = await accessToken() else { return nil }
        var request = Self.request("rest/v1/rpc/my_usage")
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.httpBody = Data("{}".utf8)
        guard let (data, response) = try? await URLSession.shared.data(for: request),
              (response as? HTTPURLResponse)?.statusCode == 200,
              let row = (try? JSONSerialization.jsonObject(with: data) as? [[String: Any]])?.first,
              let used = (row["used"] as? NSNumber)?.doubleValue,
              let allowance = (row["allowance"] as? NSNumber)?.doubleValue else { return nil }
        return (used, allowance)
    }

    /// Adds a promo code's minutes to this account. Returns what to show the person.
    func redeemPromo(_ code: String) async -> String {
        guard isSignedIn, let token = await accessToken() else { return "Sign in to redeem a promo code." }
        var request = Self.request("rest/v1/rpc/redeem_promo")
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.httpBody = try? JSONSerialization.data(withJSONObject: ["p_code": code.trimmingCharacters(in: .whitespacesAndNewlines)])
        switch await Self.send(request) {
        case .success: return "Promo code added. Your allowance is updated."
        case .failure(let message, _): return message
        }
    }

    /// The local calendar day as the database stores it, yyyy-MM-dd.
    static func dayString(_ date: Date) -> String {
        let parts = Calendar.current.dateComponents([.year, .month, .day], from: date)
        return String(format: "%04d-%02d-%02d", parts.year ?? 0, parts.month ?? 0, parts.day ?? 0)
    }

    // MARK: Supabase

    private struct Session: Codable { var email: String; var refreshToken: String }
    /// The session, read from the Keychain at most once per launch, and the access token until shortly before it expires.
    /// Each Keychain read or write can make macOS ask for the password when the app's signature changed, so they stay rare.
    private var cachedSession: Session?
    private var cachedToken: (value: String, expires: Date)?

    private func authenticate(path: String, email: String, password: String) async {
        let email = email.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !email.isEmpty, password.count >= 6 else { status = "Enter your email and a password of at least 6 characters."; return }
        isWorking = true
        defer { isWorking = false }
        var request = Self.request(path)
        request.httpBody = try? JSONSerialization.data(withJSONObject: ["email": email, "password": password])
        switch await Self.send(request) {
        case .failure(let message, _): status = message
        case .success(let body):
            // Sign-up without a session means Supabase sent a confirmation email first.
            guard store(body, email: email) else { status = "Check your inbox to confirm your email, then sign in."; return }
            status = "Signed in. Each export now adds to your stats."
        }
    }

    /// A fresh access token from the saved refresh token. Supabase rotates refresh tokens, so the new one is saved each time.
    private func accessToken() async -> String? {
        if let cachedToken, cachedToken.expires > .now.addingTimeInterval(60) { return cachedToken.value }
        guard let saved = cachedSession ?? Self.savedSession() else { signOutKeepingStatus(); return nil }
        cachedSession = saved
        var request = Self.request("auth/v1/token?grant_type=refresh_token")
        request.httpBody = try? JSONSerialization.data(withJSONObject: ["refresh_token": saved.refreshToken])
        switch await Self.send(request) {
        case .success(let body):
            guard store(body, email: saved.email), let token = cachedToken?.value else { return nil }
            return token
        case .failure(let message, let code):
            // Only Supabase rejecting the session signs out. A dropped connection or a server hiccup keeps the sign-in for next time.
            if [400, 401, 403].contains(code) {
                status = "Your sign-in expired (\(message)). Sign in again to keep counting exports."
                signOutKeepingStatus()
            }
            return nil
        }
    }

    private func signOutKeepingStatus() {
        try? SecretStore.save("", service: Self.keychainService)
        UserDefaults.standard.removeObject(forKey: Self.emailKey)
        email = nil
        cachedSession = nil
        cachedToken = nil
    }

    /// Saves the session from an auth response; false when the response has none.
    private func store(_ body: [String: Any], email: String) -> Bool {
        guard let refresh = body["refresh_token"] as? String,
              let data = try? JSONEncoder().encode(Session(email: email, refreshToken: refresh)) else { return false }
        do { try SecretStore.save(String(decoding: data, as: UTF8.self), service: Self.keychainService) }
        catch { status = error.localizedDescription; return false }
        UserDefaults.standard.set(email, forKey: Self.emailKey)
        self.email = email
        cachedSession = Session(email: email, refreshToken: refresh)
        if let token = body["access_token"] as? String {
            cachedToken = (token, .now.addingTimeInterval((body["expires_in"] as? Double) ?? 3600))
        }
        return true
    }

    private static func savedSession() -> Session? {
        let text = SecretStore.read(service: keychainService)
        return text.isEmpty ? nil : try? JSONDecoder().decode(Session.self, from: Data(text.utf8))
    }

    private static func request(_ path: String, method: String = "POST") -> URLRequest {
        var request = URLRequest(url: URL(string: path, relativeTo: projectURL)!)
        request.httpMethod = method
        request.timeoutInterval = 20
        request.setValue(publishableKey, forHTTPHeaderField: "apikey")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        return request
    }

    /// The status is 0 when no response arrived at all, such as when the connection dropped.
    private enum Reply { case success([String: Any]), failure(String, status: Int) }

    private static func send(_ request: URLRequest) async -> Reply {
        do {
            let (data, response) = try await URLSession.shared.data(for: request)
            let body = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:]
            guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
                let reason = body["msg"] ?? body["error_description"] ?? body["message"] ?? "HTTP \((response as? HTTPURLResponse)?.statusCode ?? 0)"
                return .failure("\(reason)", status: (response as? HTTPURLResponse)?.statusCode ?? 0)
            }
            return .success(body)
        } catch { return .failure(error.localizedDescription, status: 0) }
    }
}
