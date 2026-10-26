import Foundation
import Observation

/// Progress follows real app events. Merely importing a video or opening the editor never completes the tutorial.
@MainActor @Observable
final class FirstRunTutorial {
    enum Step: Equatable {
        case start, upload, settings, captions, contentType, retry, created
        case shorts, preview, editing, timeline, export

        var isEditorTour: Bool { [.shorts, .preview, .editing, .timeline, .export].contains(self) }
    }
    enum Flow: Equatable { case home, upload, settings, captions, contentType, editor, other }

    private(set) var step: Step?
    private var email: String?
    private let defaults: UserDefaults
    private static let completionKey = "tutorial.firstVideo.completedAccounts.v1"
    var isActive: Bool { step != nil }

    init(defaults: UserDefaults = .standard) { self.defaults = defaults }

    /// Completion is kept separately for each account on this Mac.
    func connect(email: String?) {
        let normalized = email?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard normalized != self.email else { return }
        self.email = normalized
        step = normalized.map { completedAccounts.contains($0) ? nil : .start } ?? nil
    }

    func restart(email: String) {
        self.email = email.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        step = .start
    }

    func follow(_ flow: Flow) {
        guard let step, step != .created, !step.isEditorTour else { return }
        switch flow {
        case .home: self.step = .start
        case .upload: self.step = .upload
        case .settings: self.step = .settings
        case .captions: self.step = .captions
        case .contentType: self.step = .contentType
        case .editor: self.step = .retry
        case .other: break
        }
    }

    /// Called only after a nonempty generated batch has been saved successfully.
    func didCreateVideo() {
        guard isActive, let email else { return }
        if !completedAccounts.contains(email) {
            defaults.set(completedAccounts + [email], forKey: Self.completionKey)
        }
        step = .created
    }

    func exploreEditor() { if step == .created { step = .shorts } }
    func next() {
        switch step {
        case .shorts: step = .preview
        case .preview: step = .editing
        case .editing: step = .timeline
        case .timeline: step = .export
        case .export: step = nil
        default: break
        }
    }

    /// An unfinished guide returns on the next sign-in or launch; it is never marked complete by dismissal.
    func dismiss() { step = nil }
    private var completedAccounts: [String] { defaults.stringArray(forKey: Self.completionKey) ?? [] }
}
