import AppKit
import SwiftUI
import AVKit

/// An isolated UI fixture: Preview menu actions replace AI generation, and Account.swift uses the fake key store below.
enum TutorialPreviewKeys {
    static func read(service: String) -> String { "" }
    static func save(_ value: String, service: String) throws {}
}

@main struct TutorialPreview: App {
    @State private var model: AppModel
    @State private var updater = AppUpdater()
    private let root: URL

    init() {
        let root = URL(fileURLWithPath: ProcessInfo.processInfo.environment["PRISM_TUTORIAL_PREVIEW_ROOT"]!)
        self.root = root
        let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        precondition(support.path.hasPrefix(root.path), "Preview must run with its isolated home")
        _model = State(initialValue: AppModel(appDirectory: root.appendingPathComponent("Library")))
        let fonts = (try? FileManager.default.contentsOfDirectory(at: URL(fileURLWithPath: "packaging/Fonts"), includingPropertiesForKeys: nil)) ?? []
        CTFontManagerRegisterFontURLs(fonts.filter { $0.pathExtension == "ttf" } as CFArray, .process, true, nil)
    }

    var body: some Scene {
        WindowGroup("Prism Tutorial Preview") {
            ContentView(model: model)
                .frame(minWidth: 1100, minHeight: 720)
                .font(Prism.text(13)).foregroundStyle(Prism.text).buttonStyle(.prismSecondary)
                .preferredColorScheme(.dark).environment(updater)
                .onAppear { model.account.email = "tutorial@example.test" }
        }
        .defaultSize(width: 1100, height: 720)
        .commands {
            CommandMenu("Preview") {
                Button("Load sample video") {
                    model.create()
                    let item = MediaItem(path: root.appendingPathComponent("sample.mov").path, kind: "video", duration: 60, width: 1920, height: 1080)
                    model.project?.media = [item]
                    model.selection = item.id
                    model.isStartingNewVideo = false
                    model.resetSourceRange(for: item)
                    model.screen = .importSource
                }
                Button("Simulate successful creation") {
                    guard let video = model.project?.media.first else { return }
                    var segment = EditSegment(mediaID: video.id, duration: 20, caption: "Your first video")
                    segment.cropTrackingVersion = SubjectFramer.version
                    model.project?.segments = [segment]
                    model.selection = video.id
                    model.previewShortID = segment.id
                    model.previewSegment = segment
                    model.screen = .editor
                    model.tutorial.didCreateVideo()
                }
                Button("Replay tutorial") {
                    model.tutorial.restart(email: "tutorial@example.test")
                    model.screen = .home
                }
            }
        }
    }
}
