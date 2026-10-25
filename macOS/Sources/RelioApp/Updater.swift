import AppKit
import Sparkle

/// Auto-updates through Sparkle, the standard updater for native macOS apps.
/// Sparkle checks the appcast on launch and every few hours, downloads in the background and verifies each update's
/// EdDSA signature against SUPublicEDKey before installing; Prism only shows a calm banner once an update is ready.
@MainActor @Observable
final class AppUpdater: NSObject, SPUUpdaterDelegate, SPUStandardUserDriverDelegate {
    nonisolated static let betaKey = "updates.beta"
    /// The update waiting to install and its notes, kept so the relaunched app can say what changed.
    nonisolated static let pendingVersionKey = "updates.pendingVersion"
    nonisolated static let pendingNotesKey = "updates.pendingNotes"

    /// The downloaded update waiting for a restart, with up to three lines of what's new.
    private(set) var readyVersion: String?
    private(set) var releaseNotes: [String] = []
    var isBannerDismissed = false
    /// Set on the first launch after an update: the new version and what changed, until the person dismisses it.
    var updatedVersion: String?
    private(set) var updatedNotes: [String] = []
    /// Every version this Mac has run, oldest first, with its release notes. Settings › Updates shows the changes from them.
    private(set) var history: [ReleaseRecord] = []
    /// A newer version the last check found, before it is downloaded; nil when none was found.
    private(set) var availableVersion: String?
    private(set) var availableNotes: [String] = []
    /// What the last check said when no download is pending, e.g. "You're up to date."
    private(set) var checkResult: String?

    struct ReleaseRecord: Codable, Identifiable, Equatable {
        var id: String { version }
        let version: String
        let notes: [String]
    }
    static let historyKey = "updates.history"
    var receivesBetas = UserDefaults.standard.bool(forKey: AppUpdater.betaKey) {
        didSet {
            UserDefaults.standard.set(receivesBetas, forKey: Self.betaKey)
            // A tester who opts in hears about the latest beta without waiting for the next scheduled check.
            if receivesBetas { controller?.updater.checkForUpdatesInBackground() }
        }
    }
    /// Set and called on the main thread only: Sparkle hands it over from its main-thread delegate callback.
    @ObservationIgnored nonisolated(unsafe) private var installNow: (() -> Void)?
    @ObservationIgnored private var controller: SPUStandardUpdaterController?

    let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "development"
    let build = Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "0"

    /// Updates run only in the packaged app with a public signing key; a `swift run` build or one without a key never updates,
    /// so an unsigned feed can never be trusted.
    var isEnabled: Bool { controller != nil }
    var lastCheck: Date? { controller?.updater.lastUpdateCheckDate }

    override init() {
        super.init()
        showWhatChangedIfJustUpdated()
        let key = Bundle.main.object(forInfoDictionaryKey: "SUPublicEDKey") as? String ?? ""
        guard Bundle.main.bundleURL.pathExtension == "app", !key.isEmpty else { return }
        let controller = SPUStandardUpdaterController(startingUpdater: true, updaterDelegate: self, userDriverDelegate: self)
        self.controller = controller
        // Sparkle schedules checks every few hours; this adds one on every launch, in the background.
        controller.updater.checkForUpdatesInBackground()
    }

    /// Prism › Check for Updates…: Sparkle's own window, because the person asked.
    func checkForUpdates() { controller?.checkForUpdates(nil) }

    /// Installs the downloaded update and relaunches. The banner only offers this while no export or AI task is running.
    func restartToUpdate() { installNow?() }

    // MARK: Sparkle

    nonisolated func allowedChannels(for updater: SPUUpdater) -> Set<String> {
        // Stable items have no channel and reach everyone; testers also accept items marked "beta".
        UserDefaults.standard.bool(forKey: AppUpdater.betaKey) ? ["beta"] : []
    }

    /// The update is downloaded and verified; Sparkle would install it on quit. Prism offers "Restart to update" instead of a dialog.
    nonisolated func updater(_ updater: SPUUpdater, willInstallUpdateOnQuit item: SUAppcastItem, immediateInstallationBlock: @escaping () -> Void) -> Bool {
        let version = item.displayVersionString
        let notes = Self.noteLines(item.itemDescription)
        installNow = immediateInstallationBlock
        // Remembered before installing, whether the person restarts now or the update installs on quit.
        UserDefaults.standard.set(version, forKey: Self.pendingVersionKey)
        UserDefaults.standard.set(notes, forKey: Self.pendingNotesKey)
        // Sparkle calls its delegate on the main thread.
        MainActor.assumeIsolated {
            readyVersion = version
            releaseNotes = notes
            isBannerDismissed = false
        }
        return true
    }

    /// A newer version exists: remember it so Settings › Updates can say so.
    nonisolated func updater(_ updater: SPUUpdater, didFindValidUpdate item: SUAppcastItem) {
        let version = item.displayVersionString
        let notes = Self.noteLines(item.itemDescription)
        MainActor.assumeIsolated {
            availableVersion = version
            availableNotes = notes
            checkResult = nil
        }
    }

    /// The check ran and found nothing newer.
    nonisolated func updaterDidNotFindUpdate(_ updater: SPUUpdater) {
        MainActor.assumeIsolated {
            availableVersion = nil
            availableNotes = []
            checkResult = "You're up to date."
        }
    }

    /// Background checks never pop a window over the person's work; only a check they started does.
    nonisolated var supportsGentleScheduledUpdateReminders: Bool { true }
    nonisolated func standardUserDriverShouldHandleShowingScheduledUpdate(_ update: SUAppcastItem, andInImmediateFocus immediateFocus: Bool) -> Bool {
        immediateFocus
    }

    /// After a relaunch into the version that was waiting, shows its notes once and forgets them.
    /// A different running version means the install did not happen, so the notes wait for the next attempt.
    private func showWhatChangedIfJustUpdated() {
        let defaults = UserDefaults.standard
        history = (defaults.data(forKey: Self.historyKey)).flatMap { try? JSONDecoder().decode([ReleaseRecord].self, from: $0) } ?? []
        // The first launch of each version is recorded with the notes it was installed with.
        if history.last?.version != version {
            let pendingNotes = defaults.string(forKey: Self.pendingVersionKey) == version ? defaults.stringArray(forKey: Self.pendingNotesKey) ?? [] : []
            history.append(ReleaseRecord(version: version, notes: pendingNotes))
            history = Array(history.suffix(12))
            defaults.set(try? JSONEncoder().encode(history), forKey: Self.historyKey)
        }
        guard let pending = defaults.string(forKey: Self.pendingVersionKey), pending == version else { return }
        updatedVersion = pending
        updatedNotes = defaults.stringArray(forKey: Self.pendingNotesKey) ?? []
        defaults.removeObject(forKey: Self.pendingVersionKey)
        defaults.removeObject(forKey: Self.pendingNotesKey)
    }

    /// Release notes as at most three short lines: list items, or else lines of text, with any HTML removed.
    nonisolated static func noteLines(_ description: String?) -> [String] {
        guard let description, !description.isEmpty else { return [] }
        let items = description.components(separatedBy: "<li>").dropFirst()
        let pieces = items.isEmpty ? description.components(separatedBy: .newlines) : Array(items)
        return pieces
            .map { $0.replacingOccurrences(of: "<[^>]+>", with: "", options: .regularExpression)
                .replacingOccurrences(of: "&amp;", with: "&").replacingOccurrences(of: "&lt;", with: "<").replacingOccurrences(of: "&gt;", with: ">")
                .trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
            .prefix(3)
            .map { $0 }
    }
}
