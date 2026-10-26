import SwiftUI

enum TutorialTarget: Hashable { case start, upload, settings, captions, contentType, shorts, preview, editing, timeline, export, sourceViewport }

struct TutorialAnchors: PreferenceKey {
    static let defaultValue: [TutorialTarget: Anchor<CGRect>] = [:]
    static func reduce(value: inout [TutorialTarget: Anchor<CGRect>], nextValue: () -> [TutorialTarget: Anchor<CGRect>]) {
        value.merge(nextValue(), uniquingKeysWith: { _, new in new })
    }
}

extension View {
    func tutorialTarget(_ target: TutorialTarget) -> some View {
        transformAnchorPreference(key: TutorialAnchors.self, value: .bounds) { anchors, bounds in
            anchors[target] = bounds
        }
    }
}

/// The same cutout is used for painting and hit testing: only the highlighted real controls remain clickable.
private struct TutorialShade: Shape {
    let spotlight: CGRect?
    func path(in rect: CGRect) -> Path {
        var path = Path(rect)
        if let spotlight, !spotlight.isNull, !spotlight.isEmpty {
            path.addRoundedRect(in: spotlight, cornerSize: CGSize(width: 14, height: 14))
        }
        return path
    }
}

struct TutorialSpotlight: View {
    let spotlight: CGRect?
    var body: some View {
        GeometryReader { proxy in
            let visible = spotlight?.insetBy(dx: -4, dy: -4).intersection(CGRect(origin: .zero, size: proxy.size))
            let shade = TutorialShade(spotlight: visible)
            shade.fill(.black.opacity(0.67), style: FillStyle(eoFill: true))
                .contentShape(shade, eoFill: true)
                .onTapGesture {}
                .accessibilityHidden(true)
            if let visible, !visible.isNull, !visible.isEmpty {
                RoundedRectangle(cornerRadius: 14)
                    .stroke(Prism.action, lineWidth: 2)
                    .shadow(color: Prism.action.opacity(0.3), radius: 8)
                    .frame(width: visible.width, height: visible.height)
                    .position(x: visible.midX, y: visible.midY)
                    .allowsHitTesting(false)
                    .accessibilityHidden(true)
            }
        }
    }
}

extension FirstRunTutorial.Step {
    var target: TutorialTarget? {
        switch self {
        case .start: .start
        case .upload: .upload
        case .settings: .settings
        case .captions: .captions
        case .contentType: .contentType
        case .shorts: .shorts
        case .preview: .preview
        case .editing: .editing
        case .timeline: .timeline
        case .export: .export
        case .created, .retry: nil
        }
    }
    var progress: String {
        switch self {
        case .start: "FIRST VIDEO · 1 OF 6"
        case .upload: "FIRST VIDEO · 2 OF 6"
        case .settings: "FIRST VIDEO · 3 OF 6"
        case .captions: "FIRST VIDEO · 4 OF 6"
        case .contentType, .retry: "FIRST VIDEO · 5 OF 6"
        case .created: "FIRST VIDEO · 6 OF 6"
        case .shorts: "EDITOR TOUR · 1 OF 5"
        case .preview: "EDITOR TOUR · 2 OF 5"
        case .editing: "EDITOR TOUR · 3 OF 5"
        case .timeline: "EDITOR TOUR · 4 OF 5"
        case .export: "EDITOR TOUR · 5 OF 5"
        }
    }
    var title: String {
        switch self {
        case .start: "Let’s create your first video."
        case .upload: "Add a video to work with."
        case .settings: "Make it your Short."
        case .captions: "Give your words a style."
        case .contentType: "Ready to create?"
        case .retry: "Let’s finish your first video."
        case .created: "You created your first video."
        case .shorts: "Your Shorts live here."
        case .preview: "Watch before you share."
        case .editing: "Make every word yours."
        case .timeline: "Fine-tune the moment."
        case .export: "Save a video you can share."
        }
    }
    var detail: String {
        switch self {
        case .start: "Follow this quick tutorial to make your first Short. Click the highlighted Start creating card to begin."
        case .upload: "Drop a video into the highlighted area, click Browse files, or paste a file path. A short video with clear speech is a good first choice."
        case .settings: "Choose how many Shorts to make, their length, and the section to analyze. Auto works well to start. Then click Next: Choose captions."
        case .captions: "Pick a caption style, or leave Auto selected. You can change it later. Scroll down and click Next: Choose content type."
        case .contentType: "Choose the kind of video, or keep Auto. Scroll down and click Analyze and create Shorts. Prism will find the moments and prepare your clips."
        case .retry: "No video has been created yet. Return to setup to try again with this video. Your project is kept."
        case .created: "Your first Short is ready in the editor. Review it before exporting. You can finish here, or take a quick tour of the editing tools."
        case .shorts: "Select a Short to open it. Each clip keeps its own framing, captions, and timing, so you can review every pick."
        case .preview: "Play your Short here to check the framing and captions. Use the player controls to pause and review a moment."
        case .editing: "Edit the captions here. Select a Short first, then adjust its words and caption style before sharing."
        case .timeline: "Use the timeline to inspect timing, trim your clip, and adjust its focus. Changes are saved to your project automatically."
        case .export: "Click Export when you’re ready. Choose your Shorts and quality, then save the finished MP4 videos."
        }
    }
}

/// A reserved footer keeps the instructions clear of every highlighted control, even in a small window.
struct TutorialCoach: View {
    let tutorial: FirstRunTutorial
    let returnToSetup: () -> Void
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @AccessibilityFocusState private var headingFocused: Bool

    var body: some View {
        if let step = tutorial.step {
            HStack(alignment: .center, spacing: 28) {
                Image(systemName: step == .created ? "checkmark.circle.fill" : "sparkles")
                    .font(Prism.text(26)).foregroundStyle(Prism.accent)
                    .frame(width: 48, height: 48).background(Prism.accent.opacity(0.12), in: RoundedRectangle(cornerRadius: 14))
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 7) {
                    Text(step.progress).font(Prism.mono(10)).foregroundStyle(Prism.accent)
                    Text(step.title).font(Prism.display(21)).accessibilityAddTraits(.isHeader)
                        .accessibilityFocused($headingFocused)
                    Text(step.detail).font(Prism.text(12)).foregroundStyle(Prism.textSecondary)
                        .fixedSize(horizontal: false, vertical: true)
                }.frame(maxWidth: .infinity, alignment: .leading)
                VStack(spacing: 10) {
                    if step == .created {
                        Button("Done") { tutorial.dismiss() }.buttonStyle(.prismPrimary)
                        Button("Show me the editor") { tutorial.exploreEditor() }.buttonStyle(.prismSecondary)
                    } else if step.isEditorTour {
                        Button(step == .export ? "Finish tutorial" : "Next") { tutorial.next() }.buttonStyle(.prismPrimary)
                        Button("Finish tour") { tutorial.dismiss() }.buttonStyle(.prismLink)
                    } else {
                        if step == .retry { Button("Return to setup", action: returnToSetup).buttonStyle(.prismPrimary) }
                        Button("Finish later") { tutorial.dismiss() }.buttonStyle(.prismLink)
                    }
                }.frame(width: 180)
            }
            .padding(.horizontal, 28).padding(.vertical, 20)
            .background(Prism.surface1)
            .overlay(alignment: .top) { Prism.border.frame(height: 1) }
            .animation(reduceMotion ? nil : .easeOut(duration: 0.15), value: step)
            .onChange(of: step, initial: true) { _, _ in headingFocused = true }
        }
    }
}
