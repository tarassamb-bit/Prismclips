import AppKit
import UserNotifications

/// macOS notifications for long tasks that finish while Prism is in the background ("12 Shorts ready").
/// Only the packaged app posts them: a bare `swift run` binary or the test runner has no app bundle for Notification Center.
@MainActor
enum Notifier {
    static var isAvailable: Bool { Bundle.main.bundleURL.pathExtension == "app" && Bundle.main.bundleIdentifier != nil }

    /// Asks once, when a long task starts, so the system prompt appears while the person is looking at Prism.
    static func requestPermission() {
        guard isAvailable else { return }
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound]) { _, _ in }
    }

    /// Posts only when Prism is not the active app; in front, the popup already says it.
    static func notifyIfInBackground(title: String, body: String) {
        guard isAvailable, !NSApplication.shared.isActive else { return }
        let content = UNMutableNotificationContent()
        content.title = title
        content.body = body
        content.sound = .default
        UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: UUID().uuidString, content: content, trigger: nil))
    }
}
