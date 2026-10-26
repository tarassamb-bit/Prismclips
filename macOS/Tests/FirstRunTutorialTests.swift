import Foundation

@main struct FirstRunTutorialTests {
    @MainActor static func main() {
        let suite = "PrismTutorialTests-\(UUID())"
        let defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }
        let tutorial = FirstRunTutorial(defaults: defaults)
        tutorial.connect(email: nil)
        precondition(!tutorial.isActive, "The sign-in screen must not start a tutorial")
        tutorial.connect(email: " FIRST@example.com ")
        precondition(tutorial.step == .start)
        for (flow, expected) in [(FirstRunTutorial.Flow.upload, FirstRunTutorial.Step.upload),
                                 (.settings, .settings), (.captions, .captions), (.contentType, .contentType),
                                 (.captions, .captions), (.settings, .settings), (.editor, .retry)] {
            tutorial.follow(flow)
            precondition(tutorial.step == expected, "The guide must follow real forward and backward navigation")
        }
        let beforeSuccess = FirstRunTutorial(defaults: defaults)
        beforeSuccess.connect(email: "first@example.com")
        precondition(beforeSuccess.step == .start, "An editor opened after a failure is not a completed tutorial")
        tutorial.dismiss()
        tutorial.connect(email: "first@example.com")
        precondition(!tutorial.isActive, "Finish later must remain dismissed during this session")
        tutorial.connect(email: nil)
        tutorial.connect(email: "first@example.com")
        precondition(tutorial.step == .start, "An unfinished guide returns on the next sign-in")
        tutorial.follow(.contentType)
        tutorial.didCreateVideo()
        precondition(tutorial.step == .created)
        tutorial.follow(.editor)
        precondition(tutorial.step == .created, "Navigation must not dismiss the success message")
        let afterSuccess = FirstRunTutorial(defaults: defaults)
        afterSuccess.connect(email: "FIRST@example.com")
        precondition(!afterSuccess.isActive, "A completed tutorial must not return after relaunch")
        afterSuccess.connect(email: "second@example.com")
        precondition(afterSuccess.step == .start, "A different account gets its own tutorial")
        tutorial.exploreEditor()
        for expected in [FirstRunTutorial.Step.shorts, .preview, .editing, .timeline, .export] {
            precondition(tutorial.step == expected)
            tutorial.follow(.editor)
            precondition(tutorial.step == expected, "Editor navigation must not reset an optional tour")
            tutorial.next()
        }
        precondition(!tutorial.isActive)
        afterSuccess.restart(email: "first@example.com")
        precondition(afterSuccess.step == .start, "Completed tutorials can be replayed")
        afterSuccess.connect(email: nil)
        precondition(!afterSuccess.isActive, "Signing out must hide the guide")
        print("PASS first-login tutorial: real navigation, retry, dismissal, per-account persistence, replay and editor tour")
    }
}
