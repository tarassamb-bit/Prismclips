import Foundation
import Sparkle
@main struct UpdaterCheck {
    @MainActor static func main() {
        let updater = AppUpdater()
        precondition(updater.responds(to: #selector(SPUUpdaterDelegate.updater(_:willInstallUpdateOnQuit:immediateInstallationBlock:))), "Sparkle must see the ready-to-install handler")
        precondition(updater.responds(to: #selector(SPUUpdaterDelegate.allowedChannels(for:))), "Sparkle must see the beta channel handler")
        precondition(updater.responds(to: #selector(SPUStandardUserDriverDelegate.standardUserDriverShouldHandleShowingScheduledUpdate(_:andInImmediateFocus:))))
        precondition(!updater.isEnabled, "Outside an app bundle the updater stays off")
        let notes = AppUpdater.noteLines("<ul><li>Faster Shorts</li><li>Calmer <b>banner</b></li><li>Fix &amp; polish</li><li>Fourth</li></ul>")
        precondition(notes == ["Faster Shorts", "Calmer banner", "Fix & polish"], "\(notes)")
        precondition(AppUpdater.noteLines("Line one\n\nLine two") == ["Line one", "Line two"])
        precondition(AppUpdater.noteLines(nil).isEmpty)
        UserDefaults.standard.set(true, forKey: AppUpdater.betaKey)
        precondition(updater.allowedChannels(for: SPUUpdater(hostBundle: .main, applicationBundle: .main, userDriver: SPUStandardUserDriver(hostBundle: .main, delegate: nil), delegate: nil)) == ["beta"])
        UserDefaults.standard.removeObject(forKey: AppUpdater.betaKey)
        // The relaunch after an update says what changed, once; a version that did not install keeps its notes waiting.
        let defaults = UserDefaults.standard
        defaults.set(updater.version, forKey: AppUpdater.pendingVersionKey)
        defaults.set(["Faster Shorts", "Calmer banner"], forKey: AppUpdater.pendingNotesKey)
        let relaunched = AppUpdater()
        precondition(relaunched.updatedVersion == updater.version && relaunched.updatedNotes == ["Faster Shorts", "Calmer banner"])
        precondition(defaults.string(forKey: AppUpdater.pendingVersionKey) == nil, "What's new shows only once")
        precondition(AppUpdater().updatedVersion == nil)
        defaults.set("99.0", forKey: AppUpdater.pendingVersionKey)
        precondition(AppUpdater().updatedVersion == nil && defaults.string(forKey: AppUpdater.pendingVersionKey) == "99.0",
                     "Notes for a version that is not running must wait")
        defaults.removeObject(forKey: AppUpdater.pendingVersionKey); defaults.removeObject(forKey: AppUpdater.pendingNotesKey)
        print("PASS updater: Sparkle sees the handlers, release notes become three lines, beta channel follows the setting, relaunch says what changed once")
    }
}
