import SwiftUI
import AVKit
import AppKit

@main
struct RelioApp: App {
    @State private var model = AppModel()
    @State private var updater = AppUpdater()
    @AppStorage(PrismAppearance.storageKey) private var appearance = PrismAppearance.system
    init() { Prism.registerFonts() }
    var body: some Scene {
        WindowGroup("Prism") {
            ContentView(model: model)
                .frame(minWidth: 1100, minHeight: 720)
                .preferredColorScheme(appearance.colorScheme)
                .font(Prism.text(13))
                .foregroundStyle(Prism.text)
                .buttonStyle(.prismSecondary)
                .environment(updater)
        }
        .commands { PrismCommands(model: model, updater: updater) }
    }
}

/// The menu bar: File for new, open and export, Edit's Undo for both text and Short edits, and Settings under the app menu.
struct PrismCommands: Commands {
    let model: AppModel
    let updater: AppUpdater
    var body: some Commands {
        CommandGroup(after: .appInfo) {
            Button("Check for Updates…") { updater.checkForUpdates() }
                .disabled(!updater.isEnabled || !model.canUseMenus)
        }
        CommandGroup(replacing: .appSettings) {
            Button("Settings…") { model.showSettings() }
                .keyboardShortcut(",", modifiers: .command).disabled(!model.canUseMenus)
        }
        CommandGroup(replacing: .newItem) {
            Button("New Shorts Project") { model.startLongVideoToShort() }
                .keyboardShortcut("n", modifiers: .command).disabled(!model.canUseMenus)
            Button("Open Video…") { model.openVideoFromMenu() }
                .keyboardShortcut("o", modifiers: .command).disabled(!model.canUseMenus)
            Button("Open Project…") { model.openProject() }
                .keyboardShortcut("o", modifiers: [.command, .shift]).disabled(!model.canUseMenus)
        }
        CommandGroup(after: .newItem) {
            Divider()
            Button("Export…") { model.chooseExport() }
                .keyboardShortcut("e", modifiers: .command).disabled(!model.canExport)
            Button("Show Exports in Finder") { model.revealExports() }
                .disabled(model.project == nil)
        }
        CommandGroup(before: .sidebar) {
            Button(model.isSidebarCollapsed ? "Show Sidebar" : "Hide Sidebar") { model.isSidebarCollapsed.toggle() }
                .keyboardShortcut("s", modifiers: [.command, .control])
                .disabled(model.screen == .editor || !model.hasAIAccess)
        }
        CommandGroup(replacing: .undoRedo) {
            Button("Undo") { model.undoFromMenu() }
                .keyboardShortcut("z", modifiers: .command)
            Button("Redo") { model.redoFromMenu() }
                .keyboardShortcut("z", modifiers: [.command, .shift])
        }
    }
}

@MainActor @Observable
final class AppModel {
    enum Screen { case home, create, importSource, editor, settings }
    var screen: Screen = .home {
        didSet {
            if screen == .editor { isStartingNewVideo = false }
            // Back on Home, cards and Shorts counts reload, so Shorts made meanwhile show up.
            if screen == .home && oldValue != .home { projectListRevision += 1 }
        }
    }
    var isStartingNewVideo = false
    /// Prism opens with the narrow icon sidebar; expanding it lasts until the app quits.
    var isSidebarCollapsed = true
    /// The preview fills the app window.
    var isPlayerExpanded = false
    /// The Short the current player shows; its captions are drawn over the live preview.
    var previewSegment: EditSegment?
    var project: ProjectData?
    var message = "Create a project to begin."
    var isBusy = false
    var generationProgress: Double? = nil {
        didSet { if oldValue == nil, generationProgress != nil { generationStartedAt = .now } }
    }
    var generationStartedAt = Date.now
    var generationStage = ""
    /// Set when an overloaded model handed requests to another model during the current Shorts run.
    var modelFallbackNote: String?
    /// Why the last Shorts run produced nothing; shown as a blocking popup in the editor.
    var generationError: GenerationFailure?
    /// The popup's title, advice and buttons follow `kind`, so a busy server is never blamed on the video or its range.
    struct GenerationFailure {
        enum Kind { case noMoments, settings, temporary, limit, other }
        /// Raised when Supabase refuses a run: the same limit message as the one kept on this Mac.
        struct Refusal: LocalizedError { let message: String; var errorDescription: String? { message } }
        var message: String
        var kind: Kind
    }

    /// What a failed run needs: another range, a Settings change, or simply another try later.
    nonisolated static func failureKind(_ error: Error) -> GenerationFailure.Kind {
        if error is GenerationFailure.Refusal { return .limit }
        let error = (error as? GeminiSelection.StageFailure)?.underlying ?? error
        if error is URLError { return .temporary }
        guard let failure = error as? GeminiSelection.Failure else {
            return (error as? ShortMaker.Failure) == .invalidRange ? .noMoments : .other
        }
        switch failure {
        case .noStrongClips, .noDistinctClips, .requestTooLarge: return .noMoments
        case .invalidConfiguration: return .settings
        case .request(let status): return [400, 401, 403, 404].contains(status) ? .settings : .temporary
        case .server(let status, _): return [400, 401, 403, 404].contains(status) ? .settings : .temporary
        case .invalidResponse, .invalidTiming: return .temporary
        case .audioExport: return .other
        case .signInUnavailable: return .settings
        case .usageLimit: return .limit
        }
    }
    private var generationTask: Task<Void, Never>?
    /// Export uses the progress popup too, but its Cancel keeps you in the editor.
    var isExporting = false
    /// Set when an export finishes; shown as a popup with a Finder shortcut.
    var exportSummary: String?
    func cancelGeneration() {
        guard generationTask != nil else { return }
        generationStage = "Cancelling…"
        generationTask?.cancel()
    }

    var player: AVPlayer?
    var selection: UUID?
    var previewShortID: UUID?
    var previewRevision = 0
    var exportedFiles: [URL] = []
    var isPreviewLoading = false
    var previewError: String?
    private var subjectTrackingRevision: Int?
    /// Prism AI is framing the previewed Short; the preview waits, the rest of the editor doesn't.
    var isFramingPreview: Bool { subjectTrackingRevision != nil }
    var projectURL: URL?
    var store: ProjectStore?
    let machine = MachineProfile.detect()
    /// The optional Prism account: sign-in and one stats row per finished export. Nothing else leaves the Mac.
    let account = Account()
    let tutorial = FirstRunTutorial()
    var creatorPreferences = ""
    var sourcePath = ""
    var shortCount = 3
    /// Prism AI decides how many Shorts the video holds instead of a fixed count.
    var isShortCountAuto = true
    /// Approximate Short length in seconds; 0 is Auto, where Prism AI gives each Short the length its story needs.
    var shortDuration = 0.0
    var shortSourceRegion = ShortMaker.SourceRegion.entireVideo
    var shortCaptionStyle: CaptionStyle = .auto
    /// Chosen after captions, so it never overrides the caption style picked on the step before.
    var shortVideoType: VideoType = .auto
    var customStartMinutes = "0"
    var customEndMinutes = ""
    var shortsSource: MediaItem? {
        guard !isStartingNewVideo else { return nil }
        return project?.media.first(where: { $0.id == selection && $0.kind == "video" }) ?? project?.media.first(where: { $0.kind == "video" })
    }
    func minuteSeconds(_ text: String) -> Double? {
        guard let value = Double(text.trimmingCharacters(in: .whitespacesAndNewlines).replacingOccurrences(of: ",", with: ".")), value.isFinite else { return nil }
        let seconds = value * 60
        return seconds.isFinite ? seconds : nil
    }
    var customRangeError: String? {
        guard shortSourceRegion == .custom else { return nil }
        guard let video = shortsSource else { return "Import a video first." }
        guard let start = minuteSeconds(customStartMinutes), let end = minuteSeconds(customEndMinutes) else { return "Enter valid start and end times in minutes." }
        guard start >= 0, end <= video.duration else { return "Times must be between 0 and \(String(format: "%.3f", video.duration / 60)) minutes (the video’s duration)." }
        guard end > start else { return "End time must be after start time." }
        return nil
    }
    func resetSourceRange(for video: MediaItem) {
        shortSourceRegion = .entireVideo
        customStartMinutes = "0"
        // Round down so a displayed value never exceeds the actual source duration.
        customEndMinutes = String(format: "%.6f", floor(video.duration / 60 * 1_000_000) / 1_000_000)
    }
    var editHistory: [[EditSegment]] = []
    var redoHistory: [[EditSegment]] = []
    var recentProjectPaths: [String] = UserDefaults.standard.stringArray(forKey: "recentProjects") ?? []
    let libraryURL: URL

    init(appDirectory: URL? = nil) {
        let app = appDirectory ?? FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("Relio")
        libraryURL = app.appendingPathComponent("Library")
        try? FileManager.default.createDirectory(at: app, withIntermediateDirectories: true)
        try? FileManager.default.createDirectory(at: libraryURL.appendingPathComponent("Projects"), withIntermediateDirectories: true)
        let globals = try? ProjectStore(root: app)
        creatorPreferences = (try? globals?.load(String.self, key: "creatorPreferences")) ?? ""
        restoreSavedProjects()
        screen = .home
    }
    /// The AI configuration for a signed-in person, for one video: requests go through Prism's server, which counts the
    /// video against the account's limit. nil when signed out.
    func geminiConfiguration(for video: MediaItem) -> GeminiConfiguration? {
        guard account.isSignedIn else { return nil }
        var configuration = GeminiConfiguration()
        configuration.usage = .init(video: UsageLimit.serverKey(video), minutes: UsageLimit.minutes(of: video),
                                    day: Account.dayString(.now))
        let account = self.account
        configuration.accessToken = { await account.currentAccessToken() }
        configuration.onRetry = { note in
            Task { @MainActor in
                self.message = note
                if self.generationProgress != nil, self.generationStage != "Cancelling…" { self.generationStage = note }
            }
        }
        configuration.onFallback = { from, to in
            Task { @MainActor in self.modelFallbackNote = "\(from) was overloaded, so Prism switched to \(to)." }
        }
        return configuration
    }

    /// `text` plus the model switch made during the task that just finished, reported once.
    func withModelNote(_ text: String) -> String {
        guard let note = modelFallbackNote else { return text }
        modelFallbackNote = nil
        return text + " " + note
    }
    func create() {
        guard !isBusy else { return }
        let formatter = DateFormatter()
        formatter.dateFormat = "yyyy-MM-dd HH-mm-ss"
        let name = "Video \(formatter.string(from: .now))"
        let url = libraryURL.appendingPathComponent("Projects").appendingPathComponent("\(name) \(UUID().uuidString).relio")
        do {
            try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
            try FileManager.default.createDirectory(at: url.appendingPathComponent("Media"), withIntermediateDirectories: true)
            try FileManager.default.createDirectory(at: url.appendingPathComponent("Exports"), withIntermediateDirectories: true)
            let nextStore = try ProjectStore(root: url)
            let nextProject = ProjectData(name: name)
            try nextStore.save(nextProject, key: "project")
            projectURL = url
            store = nextStore
            player?.pause()
            player = nil
            selection = nil
            previewShortID = nil
            previewSegment = nil
            timingShortIDs = []
            isPreviewLoading = false
            previewError = nil
            previewRevision += 1
            sourcePath = ""
            editHistory = []
            redoHistory = []
            exportedFiles = []
            lastExportFolder = nil
            project = nextProject
            lastSavedAt = .now
            UserDefaults.standard.set(url.path, forKey: "lastProject")
            remember(url)
            screen = .editor
            message = "Import a long video to make your first Short."
        } catch { message = "Could not create project: \(error.localizedDescription)" }
    }
    /// Menu commands stay off while a task runs or the Prism AI key gate covers the window.
    /// AI works with a signed-in account (the server holds the key) or with an older key saved on this Mac.
    var hasAIAccess: Bool { account.isSignedIn }
    /// Set by the sign-in gate, so Settings opens on its Account page.
    var opensAccountSettings = false
    var canUseMenus: Bool { !isBusy && hasAIAccess && !tutorial.isActive }
    var canExport: Bool { canUseMenus && screen == .editor && project?.media.isEmpty == false && exportChoice == nil }

    func showSettings() {
        guard canUseMenus else { return }
        player?.pause()
        screen = .settings
    }

    /// File › Open Video: the same flow as Create Shorts, starting with the file picker.
    func openVideoFromMenu() {
        guard canUseMenus else { return }
        startLongVideoToShort()
        importVideo()
    }

    /// Edit › Undo: text being typed undoes its own typing; otherwise the editor undoes the last Short edit.
    func undoFromMenu() {
        if NSApplication.shared.keyWindow?.firstResponder is NSText {
            NSApplication.shared.sendAction(Selector(("undo:")), to: nil, from: nil)
        } else if screen == .editor, generationError == nil, exportChoice == nil, exportSummary == nil, !editHistory.isEmpty {
            undoFromEditor()
        }
    }

    /// Text fields keep their own redo history; elsewhere, restore the last undone clip edit.
    func redoFromMenu() {
        if NSApplication.shared.keyWindow?.firstResponder is NSText {
            NSApplication.shared.sendAction(Selector(("redo:")), to: nil, from: nil)
        } else if screen == .editor, generationError == nil, exportChoice == nil, exportSummary == nil, !redoHistory.isEmpty {
            redoFromEditor()
        }
    }

    func startLongVideoToShort() {
        guard !isBusy else { return }
        player?.pause()
        isStartingNewVideo = true
        screen = .importSource
        sourcePath = ""
        message = "Upload a video to begin."

    }
    func openProject() {
        guard !isBusy else { return }
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true; panel.canChooseFiles = false
        panel.allowedContentTypes = []
        guard panel.runModal() == .OK, let url = panel.url else { return }
        open(url)
    }
    func open(_ url: URL) {
        guard !isBusy else { return }
        do {
            let s = try ProjectStore(root: url, create: false)
            guard var p = try s.load(ProjectData.self, key: "project") else { throw ProjectStore.StoreError.database }
            // Resolve managed assets relative to the project when a project folder is moved.
            for index in p.media.indices {
                let relocated = url.appendingPathComponent("Media").appendingPathComponent(p.media[index].name)
                if FileManager.default.fileExists(atPath: relocated.path) { p.media[index].path = relocated.path }
                if let thumbnail = p.media[index].thumbnail {
                    let relocatedThumbnail = url.appendingPathComponent("Thumbnails").appendingPathComponent(MediaItem.fileName(in: thumbnail))
                    if FileManager.default.fileExists(atPath: relocatedThumbnail.path) { p.media[index].thumbnail = relocatedThumbnail.path }
                }
            }
            editHistory = []; redoHistory = []; exportedFiles = []; lastExportFolder = nil; timingShortIDs = []; previewSegment = nil; store = s; project = p; projectURL = url; selection = p.media.first?.id
            lastSavedAt = (try? url.appendingPathComponent("project.sqlite").resourceValues(forKeys: [.contentModificationDateKey]))?.contentModificationDate
            UserDefaults.standard.set(url.path, forKey: "lastProject")
            remember(url)
            screen = .editor
            // A project opens on its first Short, the thing you came to review; the source is one click away.
            selectPreview(p.segments.first?.id)
            message = ""
        } catch { message = "Could not open project: \(error.localizedDescription)" }
    }
    private func remember(_ url: URL) {
        recentProjectPaths.removeAll { $0 == url.path }
        recentProjectPaths.insert(url.path, at: 0)
        UserDefaults.standard.set(recentProjectPaths, forKey: "recentProjects")
    }
    private func restoreSavedProjects() {
        let fileManager = FileManager.default
        var seen = Set<String>()
        var paths = recentProjectPaths.filter { fileManager.fileExists(atPath: $0) && seen.insert($0).inserted }
        let knownPaths = Set(paths)
        let projectsDirectory = libraryURL.appendingPathComponent("Projects", isDirectory: true)
        let folders = (try? fileManager.contentsOfDirectory(at: projectsDirectory,
            includingPropertiesForKeys: [.isDirectoryKey], options: [.skipsHiddenFiles])) ?? []
        let recovered = folders.compactMap { folder -> (String, Date)? in
            guard folder.pathExtension == "relio",
                  fileManager.fileExists(atPath: folder.appendingPathComponent("project.sqlite").path),
                  !knownPaths.contains(folder.path),
                  let projectStore = try? ProjectStore(root: folder, create: false),
                  let project = try? projectStore.load(ProjectData.self, key: "project") else { return nil }
            return (folder.path, project.created)
        }.sorted { $0.1 > $1.1 }
        paths.append(contentsOf: recovered.map(\.0))
        recentProjectPaths = paths
        UserDefaults.standard.set(paths, forKey: "recentProjects")
    }
    /// When the open project last reached disk; the editor header shows it so saving is visible.
    var lastSavedAt: Date?
    func save() throws {
        guard let project else { return }
        guard let store else { throw ProjectStore.StoreError.database }
        try store.save(project, key: "project")
        lastSavedAt = .now
    }

    /// Keeps the cloud transcript with the project; "Create more Shorts" then skips uploading and transcribing again.
    /// It's saved straight away, so it survives a later cancel or failure in the same run.
    private func storeTranscript(_ transcript: SentenceTranscript, for mediaID: UUID) {
        guard project?.media.contains(where: { $0.id == mediaID }) == true else { return }
        var saved = project?.transcripts ?? [:]
        if let existing = saved[mediaID.uuidString], existing.end - existing.start > transcript.end - transcript.start { return }
        saved[mediaID.uuidString] = transcript
        project?.transcripts = saved
        try? save()
    }

    /// The same video's cloud transcript from another project (same name, length, size and file size),
    /// so starting over with a video you used before skips uploading and transcribing it again.
    /// It opens every listed project, so it runs off the main thread.
    nonisolated private static func transcript(matching video: MediaItem, inProjects paths: [String]) -> SentenceTranscript? {
        func fileSize(_ path: String) -> Int? { (try? FileManager.default.attributesOfItem(atPath: path)[.size] as? Int) ?? nil }
        let size = fileSize(video.path)
        var best: SentenceTranscript?
        for path in paths {
            guard let other = try? ProjectStore(root: URL(fileURLWithPath: path), create: false).load(ProjectData.self, key: "project") else { continue }
            for media in other.media where media.name == video.name && abs(media.duration - video.duration) < 0.01
                && media.width == video.width && media.height == video.height && fileSize(media.path) == size {
                guard let transcript = other.transcripts?[media.id.uuidString] else { continue }
                if transcript.end - transcript.start > (best.map { $0.end - $0.start } ?? -1) { best = transcript }
            }
        }
        return best
    }

    var projectFolders: [ProjectFolder] = (UserDefaults.standard.data(forKey: "projectFolders"))
        .flatMap { try? JSONDecoder().decode([ProjectFolder].self, from: $0) } ?? []
    private func saveFolders() {
        UserDefaults.standard.set(try? JSONEncoder().encode(projectFolders), forKey: "projectFolders")
    }
    @discardableResult
    func createFolder(named name: String) -> UUID? {
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        let folder = ProjectFolder(name: String(trimmed.prefix(60)))
        projectFolders.append(folder)
        saveFolders()
        return folder.id
    }
    func renameFolder(_ id: UUID, to name: String) {
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, let index = projectFolders.firstIndex(where: { $0.id == id }) else { return }
        projectFolders[index].name = String(trimmed.prefix(60))
        saveFolders()
    }
    /// Removes only the folder; its projects go back to Home.
    func deleteFolder(_ id: UUID) {
        projectFolders.removeAll { $0.id == id }
        saveFolders()
    }
    /// Puts a project in a folder (nil takes it out); a project is in at most one folder.
    func moveProject(_ path: String, toFolder id: UUID?) {
        // Drops can carry any text; only known projects belong in folders.
        guard id == nil || recentProjectPaths.contains(path) else { return }
        guard id == nil || projectFolders.contains(where: { $0.id == id }) else { return }
        for index in projectFolders.indices { projectFolders[index].projectPaths.removeAll { $0 == path } }
        if let id, let index = projectFolders.firstIndex(where: { $0.id == id }) {
            projectFolders[index].projectPaths.insert(path, at: 0)
        }
        saveFolders()
    }

    /// Bumped when a project changes from Home, so its card reloads.
    var projectListRevision = 0

    func renameProject(at path: String, to newTitle: String) {
        let title = newTitle.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !title.isEmpty else { return }
        do {
            // The open project is saved from memory, so change it there or the next save would undo the rename.
            if projectURL?.path == path, project != nil {
                let previous = project?.title
                project?.title = title
                do { try save() }
                catch { project?.title = previous; throw error }
            } else {
                let projectStore = try ProjectStore(root: URL(fileURLWithPath: path), create: false)
                guard var stored = try projectStore.load(ProjectData.self, key: "project") else { throw ProjectStore.StoreError.database }
                stored.title = title
                try projectStore.save(stored, key: "project")
            }
            projectListRevision += 1
            message = "Renamed project to “\(title)”."
        } catch { message = "Could not rename project: \(error.localizedDescription)" }
    }

    /// Moves the project folder to the Trash, where it can still be restored.
    func deleteProject(at path: String, moveToTrash: (URL) throws -> Void = { try FileManager.default.trashItem(at: $0, resultingItemURL: nil) }) {
        guard !isBusy else { return }
        let deletingOpen = projectURL?.path == path
        let previousSelection = selection
        let previousShort = previewShortID
        if deletingOpen {
            player?.pause(); player = nil
            previewRevision += 1; subjectTrackingRevision = nil; store = nil
        }
        do {
            try moveToTrash(URL(fileURLWithPath: path))
            if deletingOpen {
                project = nil; projectURL = nil; editHistory = []; redoHistory = []; previewSegment = nil; lastSavedAt = nil
                selection = nil; previewShortID = nil; isPreviewLoading = false; previewError = nil
                UserDefaults.standard.removeObject(forKey: "lastProject")
            }
            recentProjectPaths.removeAll { $0 == path }
            UserDefaults.standard.set(recentProjectPaths, forKey: "recentProjects")
            moveProject(path, toFolder: nil)
            message = "Moved the project to the Trash."
        } catch {
            if deletingOpen {
                store = try? ProjectStore(root: URL(fileURLWithPath: path), create: false)
                selection = previousSelection
                selectPreview(previousShort)
            }
            message = "Could not delete project: \(error.localizedDescription)"
        }
    }
    func importVideo() {
        guard !isBusy else { return }
        let panel = NSOpenPanel()
        panel.allowedContentTypes = [.movie, .video, .mpeg4Movie, .quickTimeMovie]
        panel.begin { response in
            guard response == .OK, let url = panel.url else { return }
            Task { @MainActor in self.importSource(url) }
        }
    }
    func importFromPath() {
        let expanded = NSString(string: sourcePath.trimmingCharacters(in: .whitespacesAndNewlines)).expandingTildeInPath
        let url = URL(fileURLWithPath: expanded)
        guard FileManager.default.fileExists(atPath: url.path) else {
            message = "No file exists at that path."
            return
        }
        importSource(url)
    }
    static let importableExtensions: Set<String> = ["mov", "mp4", "m4v", "avi"]
    func importSource(_ url: URL) {
        guard !isBusy else { return }
        guard Self.importableExtensions.contains(url.pathExtension.lowercased()) else {
            message = "Choose a MOV, MP4, M4V, or AVI video."
            return
        }
        if isStartingNewVideo || projectURL == nil {
            create()
            guard screen == .editor else { return }
            screen = .importSource
        }
        guard let projectURL else { return }
        sourcePath = url.path
        importVideo(from: url, into: projectURL)
    }
    private func importVideo(from url: URL, into projectURL: URL) {
        let returnToEditor = screen == .editor
        isBusy = true; message = "Copying video into your Prism library…"
        Task {
            let mediaDirectory = projectURL.appendingPathComponent("Media")
            try? FileManager.default.createDirectory(at: mediaDirectory, withIntermediateDirectories: true)
            let copiedURL = uniqueDestination(for: url, in: mediaDirectory)
            do {
                try await ShortMaker.copySource(url, to: copiedURL)
            } catch {
                message = "Could not copy video: \(error.localizedDescription)"
                isBusy = false
                return
            }
            message = "Reading video metadata and creating thumbnail…"
            let item = await MediaEngine.inspect(copiedURL, thumbnailDirectory: projectURL.appendingPathComponent("Thumbnails"))
            if let item {
                // "Choose a different video" before any Shorts exist replaces the first pick; otherwise the project
                // kept the rejected copy and was named after it.
                let previousMedia = project?.media ?? []
                let previousTranscripts = project?.transcripts
                let replaced = !returnToEditor && project?.segments.isEmpty == true ? previousMedia : []
                project?.media = previousMedia.filter { media in !replaced.contains { $0.id == media.id } } + [item]
                for old in replaced { project?.transcripts?[old.id.uuidString] = nil }
                do { try save() } catch {
                    project?.media = previousMedia
                    project?.transcripts = previousTranscripts
                    try? FileManager.default.removeItem(at: copiedURL)
                    message = "Could not save import: \(error.localizedDescription)"
                    isBusy = false
                    return
                }
                selection = item.id
                startHashing(item, in: projectURL)
                resetSourceRange(for: item)
                player?.pause()
                player = AVPlayer(url: copiedURL)
                previewSegment = nil
                // Only the project's own copies are deleted, never a file outside it.
                for path in replaced.flatMap({ [$0.path, $0.thumbnail].compactMap { $0 } }) where path.hasPrefix(projectURL.path + "/") {
                    try? FileManager.default.removeItem(atPath: path)
                }
                previewShortID = nil
                screen = returnToEditor ? .editor : .importSource
                message = returnToEditor ? "Video imported. Add a clip or create Shorts." : "Video imported. Choose your settings, then press Continue."
            } else { try? FileManager.default.removeItem(at: copiedURL); message = "This video format could not be opened." }
            isBusy = false

        }
    }
    private func uniqueDestination(for source: URL, in directory: URL) -> URL {
        let base = source.deletingPathExtension().lastPathComponent
        let ext = source.pathExtension
        var destination = directory.appendingPathComponent(source.lastPathComponent)
        var index = 2
        while FileManager.default.fileExists(atPath: destination.path) {
            destination = directory.appendingPathComponent("\(base) \(index).\(ext)")
            index += 1
        }
        return destination
    }
    func continueImport() {
        guard !isBusy, selection != nil else { return }
        screen = .editor
        makeConfiguredShorts()
    }

    func selectPreview(_ shortID: UUID?) {
        subjectTrackingRevision = nil
        previewShortID = shortID
        previewError = nil
        isPreviewLoading = false
        previewRevision += 1
        let revision = previewRevision
        player?.pause()
        guard let video = project?.media.first(where: { $0.id == shortID.flatMap { id in project?.segments.first(where: { $0.id == id })?.mediaID } }) ?? project?.media.first(where: { $0.id == selection }) else {
            // Nothing to show: drop the last project's player so its video and captions don't linger.
            player = nil
            previewSegment = nil
            return
        }
        guard let shortID, let segment = project?.segments.first(where: { $0.id == shortID }) else {
            previewSegment = nil
            player = AVPlayer(url: URL(fileURLWithPath: video.path))
            return
        }
        selection = video.id
        player = nil
        isPreviewLoading = true
        // Framing runs in the background: the editor stays usable and only this preview waits. Not while another job
        // runs; the Short then previews with its saved framing and is tracked next time, or at export.
        if !isBusy, segment.cropTrackingVersion != SubjectFramer.version && segment.splitScreen != true, let configuration = geminiConfiguration(for: video) {
            subjectTrackingRevision = revision
            message = "Prism AI is framing the main subject…"
            Task {
                let path = await ShortMaker.analyzeSubjectPath(
                    URL(fileURLWithPath: video.path), start: segment.start, duration: segment.duration, zoom: segment.cropZoom ?? 1.08, configuration: configuration,
                            speech: segment.captions ?? []
                )
                // The path fits the range it was made for; a Short trimmed meanwhile is tracked again next time.
                guard revision == previewRevision, subjectTrackingRevision == revision,
                      let index = project?.segments.firstIndex(where: { $0.id == shortID }),
                      project?.segments[index].start == segment.start, project?.segments[index].duration == segment.duration else { return }
                let previous = project?.segments[index]
                project?.segments[index].cropKeyframes = path
                project?.segments[index].cropTrackingVersion = SubjectFramer.version
                do {
                    try save()
                    subjectTrackingRevision = nil
                    // An empty path means Prism AI could not be reached or answered badly; no subject still gives a steady path.
                    message = withModelNote(path.isEmpty ? "Prism AI could not frame this Short, so the crop stays centered. Use Re-track to try again." : "Subject tracking ready.")
                    selectPreview(shortID)
                } catch {
                    if let previous { project?.segments[index] = previous }
                    subjectTrackingRevision = nil
                    isPreviewLoading = false
                    previewError = "Could not save subject tracking: \(error.localizedDescription)"
                    message = "Could not save subject tracking: \(error.localizedDescription)"
                }
            }
            return
        }
        Task {
            do {
                // Plays the edit live instead of rendering a file first, so switching Shorts is instant.
                let item = try await ShortMaker.previewItem(source: URL(fileURLWithPath: video.path), segment: segment)
                guard revision == previewRevision else { return }
                previewSegment = segment
                player = AVPlayer(playerItem: item)
                isPreviewLoading = false
            } catch {
                guard revision == previewRevision else { return }
                isPreviewLoading = false
                previewError = error.localizedDescription
                message = "Could not preview Short: \(error.localizedDescription)"
            }
        }
    }

    /// Content hashes being worked out and saved, by media id. A run waits for its video's hash before it starts.
    var hashTasks: [UUID: Task<Void, Never>] = [:]

    /// Hashes a video's bytes in the background, then saves the hash into its project, even if another project is open by then.
    func startHashing(_ item: MediaItem, in projectFolder: URL) {
        let url = URL(fileURLWithPath: item.path)
        hashTasks[item.id] = Task {
            let hash = await Task.detached(priority: .utility) { try? MediaEngine.contentHash(of: url) }.value
            defer { hashTasks[item.id] = nil }
            // Without a hash (unreadable file, failed save) the video keeps its name-based usage key.
            guard let hash else { return }
            if projectURL == projectFolder, let index = project?.media.firstIndex(where: { $0.id == item.id }) {
                project?.media[index].contentHash = hash
                do { try save() } catch { project?.media[index].contentHash = nil }
            } else if let store = try? ProjectStore(root: projectFolder, create: false),
                      var stored = try? store.load(ProjectData.self, key: "project"),
                      let index = stored.media.firstIndex(where: { $0.id == item.id }) {
                stored.media[index].contentHash = hash
                try? store.save(stored, key: "project")
            }
        }
    }

    /// A re-analysis, which charges part of the video's minutes, waiting for the person to confirm it.
    struct PaidRun { let videoID: UUID; let minutes: Double; let count: Int; let duration: Double; let sourceRegion: ShortMaker.SourceRegion }
    var pendingPaidRun: PaidRun?

    func makeConfiguredShorts() {
        guard !isBusy, let video = project?.media.first(where: { $0.id == selection }) ?? project?.media.first(where: { $0.kind == "video" }) else { return }
        let count = isShortCountAuto ? 0 : shortCount, duration = shortDuration, region = shortSourceRegion
        // Problems Prism can see at once are reported at once, without a "Preparing" step first.
        if region == .custom, let error = customRangeError { message = error; return }
        guard account.isSignedIn else { makeShorts(for: video, count: count, duration: duration, sourceRegion: region); return }
        isBusy = true; generationProgress = 0; generationError = nil; generationStage = "Preparing video…"; message = "Preparing video…"
        generationTask = Task {
            let run = await prepareRun(for: video.id)
            isBusy = false; generationProgress = nil; generationTask = nil
            switch run {
            case .start(let video): makeShorts(for: video, count: count, duration: duration, sourceRegion: region)
            case .confirm(let video, let charge):
                pendingPaidRun = .init(videoID: video.id, minutes: charge, count: count, duration: duration, sourceRegion: region)
                message = ""
            case .stop(let failure):
                if let failure { message = failure.message; generationError = failure } else { message = "" }
            }
        }
    }

    enum PreparedRun { case start(MediaItem), confirm(MediaItem, charge: Double), stop(GenerationFailure?) }

    /// Waits for the video's content hash, then asks the server whether this is a re-analysis and what it costs.
    private func prepareRun(for videoID: UUID) async -> PreparedRun {
        // A video imported before hashing existed, never analyzed, is hashed now; one already analyzed keeps its old key.
        if hashTasks[videoID] == nil, let projectURL, let video = project?.media.first(where: { $0.id == videoID }),
           video.contentHash == nil, project?.transcripts?[videoID.uuidString] == nil,
           project?.segments.contains(where: { $0.mediaID == videoID }) != true {
            startHashing(video, in: projectURL)
        }
        // Polled rather than awaited, so Cancel answers at once; the hash itself keeps going and is saved for next time.
        while hashTasks[videoID] != nil, !Task.isCancelled { try? await Task.sleep(for: .milliseconds(100)) }
        guard !Task.isCancelled else { return .stop(nil) }
        guard let video = project?.media.first(where: { $0.id == videoID }) else { return .stop(nil) }
        let unavailable = PreparedRun.stop(.init(message: "Prism couldn't check your usage right now. Try again in a moment.", kind: .temporary))
        // Without the count Prism can't warn before a re-analysis, so it doesn't start one blind.
        guard let reanalysis = await account.reanalysis(UsageLimit.serverKey(video)) else { return unavailable }
        guard !Task.isCancelled else { return .stop(nil) }
        guard reanalysis.runs > 0 else { return .start(video) }
        guard let usage = await account.usageStatus() else { return unavailable }
        guard !Task.isCancelled else { return .stop(nil) }
        let left = max(0, usage.allowance - usage.used)
        // The server refuses it too; saying so here spares a confirmation that can't succeed.
        guard reanalysis.charge <= left else {
            return .stop(.init(message: "This re-analysis needs \(Int(reanalysis.charge)) min, but you have \(Int(left.rounded(.down))) min left. Ask for a promo code to get more, then enter it in Settings › Usage.", kind: .limit))
        }
        return .confirm(video, charge: reanalysis.charge)
    }

    /// Starts the re-analysis the person confirmed.
    func confirmPaidRun() {
        guard let run = pendingPaidRun else { return }
        pendingPaidRun = nil
        guard let video = project?.media.first(where: { $0.id == run.videoID }) else { return }
        makeShorts(for: video, count: run.count, duration: run.duration, sourceRegion: run.sourceRegion)
    }
    private func makeShorts(for video: MediaItem, count: Int, duration: Double, sourceRegion: ShortMaker.SourceRegion) {
        guard !isBusy else { return }
        if sourceRegion == .custom, let error = customRangeError { message = error; return }
        let customStart = sourceRegion == .custom ? minuteSeconds(customStartMinutes) : nil
        let customEnd = sourceRegion == .custom ? minuteSeconds(customEndMinutes) : nil
        guard var runConfiguration = geminiConfiguration(for: video) else {
            message = "Sign in to your Prism account to make Shorts."
            generationError = .init(message: "Sign in to your Prism account to make Shorts.", kind: .settings)
            return
        }
        // Every request of this run carries the same id, so the server counts it as one analysis.
        runConfiguration.usage?.run = UUID().uuidString
        let configuration = runConfiguration
        let usageKey = UsageLimit.videoKey(video)
        let serverUsageKey = UsageLimit.serverKey(video)
        let usageMinutes = UsageLimit.minutes(of: video)
        modelFallbackNote = nil
        isBusy = true; generationProgress = 0; generationError = nil; generationStage = "Preparing video"; message = "Preparing video analysis…"
        let sourceURL = URL(fileURLWithPath: video.path)
        let usedRanges = (project?.segments ?? []).filter { $0.mediaID == video.id }.map { SourceInterval(start: $0.start, end: $0.start + $0.duration) }
        let savedTranscript = project?.transcripts?[video.id.uuidString]
        let otherProjects = recentProjectPaths.filter { $0 != projectURL?.path }
        let videoType = shortVideoType
        Notifier.requestPermission()
        generationTask = Task {
            do {
                // The account's server allowance includes promo minutes; local usage is only an estimate.
                try Task.checkCancellation()
                if await account.usageAllowed(video: serverUsageKey, minutes: usageMinutes, on: .now) == false {
                    throw GenerationFailure.Refusal(message: "You've used your beta allowance. Ask for a promo code to get more, then enter it in Settings › Usage.")
                }
                var cachedTranscript = savedTranscript
                if cachedTranscript == nil,
                   let earlier = await Task.detached(priority: .userInitiated, operation: { Self.transcript(matching: video, inProjects: otherProjects) }).value {
                    cachedTranscript = earlier
                    storeTranscript(earlier, for: video.id)
                }
                try Task.checkCancellation()
                let results = try await ShortMaker.analyze(
                    sourceURL,
                    requestedDuration: duration,
                    count: count,
                    sourceRegion: sourceRegion,
                    customStart: customStart, customEnd: customEnd,
                    excluding: usedRanges,
                    gemini: configuration,
                    videoType: videoType,
                    cachedTranscript: cachedTranscript,
                    onTranscript: { transcript in
                        Task { @MainActor in self.storeTranscript(transcript, for: video.id) }
                    },
                    generationProgress: { fraction, stage in
                        Task { @MainActor in
                            guard self.generationProgress != nil, self.generationStage != "Cancelling…" else { return }
                            self.generationProgress = max(self.generationProgress ?? 0, fraction)
                            self.generationStage = stage
                        }
                    }
                )
                try Task.checkCancellation()
                var candidates: [EditSegment] = results.map {
                    var segment = EditSegment(mediaID: video.id, start: $0.start, duration: $0.duration, caption: $0.caption,
                          fitToFrame: $0.fitToFrame, captions: $0.captions, cropKeyframes: $0.cropKeyframes, cropTrackingVersion: SubjectFramer.version,
                          speechWords: $0.speechWords, suggestedTitle: $0.suggestedTitle, selectionReason: $0.selectionReason,
                          captionNotice: $0.analysisWarning, captionStyle: shortCaptionStyle)
                    segment.score = $0.score
                    segment.suggestedDescription = $0.suggestedDescription
                    segment.videoType = $0.videoType
                    // Only an explicit Podcast pick splits the frame; an auto-detected podcast may have one person on camera.
                    if videoType == .podcast { segment.splitScreen = true; segment.captionPosition = .middle }
                    return segment
                }
                let splitIndices = candidates.indices.filter { candidates[$0].splitScreen == true }
                if !splitIndices.isEmpty {
                    try Task.checkCancellation()
                    generationStage = "Prism AI · finding both speakers in \(splitIndices.count) Shorts"
                    let ranges = splitIndices.map { (index: $0, start: candidates[$0].start, duration: candidates[$0].duration) }
                    let centers = try await ShortMaker.concurrentMap(ranges, limit: ShortMaker.parallelRequests) { range in
                        (range.index, await ShortMaker.findSplitCenters(sourceURL, start: range.start, duration: range.duration, configuration: configuration))
                    }
                    for (index, found) in centers { candidates[index].splitCenters = found }
                }
                try Task.checkCancellation()
                let fresh = try appendGeneratedShorts(candidates)
                guard !fresh.isEmpty else {
                    message = "No new distinct moments were found in this range. Your existing clips were kept. Try another region or length."
                    generationError = .init(message: message, kind: .noMoments)
                    generationProgress = nil; generationTask = nil; isBusy = false
                    Notifier.notifyIfInBackground(title: "No new Shorts found", body: message)
                    return
                }
                // Only a run that made Shorts uses up the video limit.
                UsageLimit.record(usageKey, minutes: usageMinutes)
                usageRevision += 1
                message = "Prism AI selected \(fresh.count) complete clip ranges and layouts. Review framing and captions before export."
                let warning = results.compactMap(\.analysisWarning).first
                if let warning { message += " " + warning }
                message = withModelNote(message)
                selectPreview(fresh.first?.id)
                tutorial.didCreateVideo()
                Notifier.notifyIfInBackground(title: fresh.count == 1 ? "1 Short ready" : "\(fresh.count) Shorts ready", body: project?.displayTitle ?? "Prism")
            } catch {
                if error is GenerationFailure.Refusal { message = error.localizedDescription }
                else { message = Task.isCancelled ? "Generation cancelled. Your existing clips were kept." : "Analysis failed: \(error.localizedDescription)" }
                if !Task.isCancelled {
                    generationError = .init(message: error.localizedDescription, kind: Self.failureKind(error))
                    Notifier.notifyIfInBackground(title: "Couldn’t make Shorts", body: error.localizedDescription)
                }
                modelFallbackNote = nil
            }
            generationProgress = nil
            generationTask = nil
            isBusy = false
            if shortCaptionStyle.usesWordTiming { timeWordsForAllShorts() }
        }
    }
    /// Commit a generated batch atomically; regenerating never discards a user's previous work.
    @discardableResult
    func appendGeneratedShorts(_ candidates: [EditSegment]) throws -> [EditSegment] {
        guard project != nil else { return [] }
        let previous = project?.segments ?? []
        var fresh: [EditSegment] = []
        for candidate in candidates {
            guard candidate.start.isFinite, candidate.duration.isFinite, candidate.start >= 0, candidate.duration > 0 else {
                throw ShortMaker.Failure.invalidRange
            }
            guard let video = project?.media.first(where: { $0.id == candidate.mediaID && $0.kind == "video" }) else {
                throw ShortMaker.Failure.noVideo
            }
            guard candidate.start + candidate.duration <= video.duration + 0.001 else { throw ShortMaker.Failure.invalidRange }
            if (previous + fresh).contains(where: { $0.id == candidate.id }) { continue }
            if (previous + fresh).allSatisfy({ existing in
                existing.mediaID != candidate.mediaID || !TranscriptSelection.overlaps(start: candidate.start, duration: candidate.duration,
                    otherStart: existing.start, otherDuration: existing.duration)
            }) { fresh.append(candidate) }
        }
        guard !fresh.isEmpty else { return [] }
        project?.segments = previous + fresh
        do { try save() } catch { project?.segments = previous; throw error }
        editHistory.append(previous)
        redoHistory.removeAll()
        return fresh
    }
    /// A Short's title as a file name: no path or Finder-unsafe characters, at most 80 characters.
    nonisolated static func exportFileName(title: String?) -> String? {
        let cleaned = (title ?? "").components(separatedBy: CharacterSet(charactersIn: "/\\:*?\"<>|").union(.newlines).union(.controlCharacters))
            .joined(separator: " ")
            .split(separator: " ", omittingEmptySubsequences: true).joined(separator: " ")
            .trimmingCharacters(in: CharacterSet(charactersIn: ". "))
        return cleaned.isEmpty ? nil : String(cleaned.prefix(80))
    }

    /// Reserve every name before concurrent renders start, including numbered files already in the folder.
    static func reserveExportDestination(name: String, folder: URL, reserved: inout Set<String>) -> URL {
        var destination = folder.appendingPathComponent("\(name).mp4")
        var copy = 2
        while FileManager.default.fileExists(atPath: destination.path) || FileManager.default.fileExists(atPath: ShortMaker.notesURL(for: destination).path)
                || reserved.contains(destination.lastPathComponent.lowercased()) {
            destination = folder.appendingPathComponent("\(name) \(copy).mp4")
            copy += 1
        }
        reserved.insert(destination.lastPathComponent.lowercased())
        return destination
    }

    /// What the export card is set to; nil while it is closed.
    struct ExportChoice {
        var shortIDs: Set<UUID>
        var includeSource: Bool
        var quality: ShortMaker.ExportQuality
        var folder: URL
        /// Titles and descriptions as edited on the card, by Short.
        var titles: [UUID: String] = [:]
        var descriptions: [UUID: String] = [:]
        /// Why the last export attempt couldn't start, shown on the card.
        var error: String? = nil
    }
    var exportChoice: ExportChoice?
    /// Where and how the last export went, for the finished popup and the Exports button.
    var lastExportFolder: URL?
    var lastExportQuality = ShortMaker.ExportQuality.full
    var lastExportShortCount = 0

    /// Opens the export card with every Short ticked, or only the one with `id`.
    func chooseExport(only id: UUID? = nil) {
        guard !isBusy, let project, !project.media.isEmpty else { return }
        let quality = ShortMaker.ExportQuality(rawValue: UserDefaults.standard.string(forKey: "export.quality") ?? "") ?? .full
        exportChoice = .init(shortIDs: Set(project.segments.filter { id == nil || $0.id == id }.map(\.id)),
                             includeSource: false, quality: quality, folder: defaultExportFolder(),
                             titles: Dictionary(uniqueKeysWithValues: project.segments.map { ($0.id, $0.suggestedTitle ?? "") }),
                             descriptions: Dictionary(uniqueKeysWithValues: project.segments.map { ($0.id, $0.suggestedDescription ?? "") }))
    }

    /// True while the export card asks Prism AI for missing descriptions.
    var isWritingDescriptions = false

    /// Fills the export card's empty descriptions with one Prism AI request; titles and typed text are kept.
    func writeMissingDescriptions() async {
        guard var choice = exportChoice, let project, !isWritingDescriptions else { return }
        let missing = project.segments.filter { (choice.descriptions[$0.id] ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
        guard let first = missing.first, let video = project.media.first(where: { $0.id == first.mediaID }),
              let configuration = geminiConfiguration(for: video) else {
            exportChoice?.error = "Sign in to your Prism account to write descriptions."
            return
        }
        isWritingDescriptions = true
        defer { isWritingDescriptions = false }
        do {
            let written = try await GeminiSelection.describe(missing.map { segment in
                (choice.titles[segment.id] ?? segment.suggestedTitle ?? "", (segment.captions ?? []).map(\.text).joined(separator: " "))
            }, configuration: configuration)
            // The card may have changed while the request ran; only still-empty fields are filled.
            guard let current = exportChoice else { return }
            choice = current
            for (index, text) in written where (choice.descriptions[missing[index].id] ?? "").isEmpty { choice.descriptions[missing[index].id] = text }
            choice.error = written.count < missing.count ? "Prism AI wrote \(written.count) of \(missing.count) descriptions. Write the rest yourself or try again." : nil
            exportChoice = choice
        } catch {
            exportChoice?.error = "Couldn't write descriptions: \(error.localizedDescription)"
        }
    }

    /// Downloads › Prism › the project's name.
    func defaultExportFolder() -> URL {
        let downloads = FileManager.default.urls(for: .downloadsDirectory, in: .userDomainMask)[0]
        return downloads.appendingPathComponent("Prism").appendingPathComponent(Self.exportFileName(title: project?.displayTitle) ?? "Prism export")
    }

    /// Renders the ticked Shorts and copies the main video if asked, into `choice.folder`.
    func export(_ choice: ExportChoice) {
        guard !isBusy, let current = project else { return }
        // Titles and descriptions edited on the card stay on the Shorts, and go into the files below.
        var edited = current
        for index in edited.segments.indices {
            let id = edited.segments[index].id
            if let title = choice.titles[id] { edited.segments[index].suggestedTitle = title }
            if let description = choice.descriptions[id] { edited.segments[index].suggestedDescription = description }
        }
        if edited.segments != current.segments {
            project = edited
            do { try save() } catch {
                project = current
                exportChoice = choice
                exportChoice?.error = "Could not save the titles: \(error.localizedDescription)"
                return
            }
        }
        let project = edited
        let segments = project.segments.enumerated().filter { choice.shortIDs.contains($0.element.id) }
        let sources = choice.includeSource ? project.media.filter { $0.kind == "video" } : []
        guard !segments.isEmpty || !sources.isEmpty else { return }
        do { try FileManager.default.createDirectory(at: choice.folder, withIntermediateDirectories: true) } catch {
            // The card stays open with the reason, instead of closing and leaving it in the status line.
            exportChoice = choice
            exportChoice?.error = "Could not use this folder: \(error.localizedDescription) Choose another folder."
            return
        }
        exportChoice = nil
        UserDefaults.standard.set(choice.quality.rawValue, forKey: "export.quality")
        let media = project.media
        let projectName = project.displayTitle
        let folder = choice.folder
        let total = segments.count + sources.count
        exportedFiles = []
        lastExportFolder = folder
        lastExportQuality = choice.quality
        lastExportShortCount = segments.count
        isBusy = true; message = total == 1 ? "Exporting 1 file…" : "Exporting \(total) files…"
        isExporting = true; generationProgress = 0; generationStage = "Preparing export"
        Notifier.requestPermission()
        generationTask = Task {
            do {
                // Each Short gets its file name up front, so two rendering side by side never pick the same name.
                var reserved = Set<String>()
                let jobs = segments.map { number, segment -> (Int, EditSegment, URL) in
                    let name = Self.exportFileName(title: segment.suggestedTitle) ?? "\(Self.exportFileName(title: projectName) ?? "Prism") Short \(number + 1)"
                    let destination = Self.reserveExportDestination(name: name, folder: folder, reserved: &reserved)
                    return (number, segment, destination)
                }
                // One configuration per video, so each request is counted against the right video's limit.
                let configurations = Dictionary(uniqueKeysWithValues: media.compactMap { video in geminiConfiguration(for: video).map { (video.id, $0) } })
                generationStage = total == 1 ? "Exporting 1 Short" : "Exporting \(segments.count) Shorts"
                // Two Shorts render at once: faster, without starving the Mac's video encoder.
                _ = try await ShortMaker.concurrentMap(jobs, limit: 2) { number, originalSegment, destination in
                    var segment = originalSegment
                    guard let video = media.first(where: { $0.id == segment.mediaID }) else { throw ShortMaker.Failure.noVideo }
                    if segment.cropTrackingVersion != SubjectFramer.version && segment.splitScreen != true, let configuration = configurations[video.id] {
                        segment.cropKeyframes = await ShortMaker.analyzeSubjectPath(
                            URL(fileURLWithPath: video.path), start: segment.start, duration: segment.duration, zoom: segment.cropZoom ?? 1.08, configuration: configuration,
                            speech: segment.captions ?? []
                        )
                        // A cancelled analysis returns no path; saving it would freeze this Short's framing.
                        try Task.checkCancellation()
                        segment.cropTrackingVersion = SubjectFramer.version
                        let framed = segment
                        try await MainActor.run {
                            if let storedIndex = self.project?.segments.firstIndex(where: { $0.id == framed.id }) {
                                let previous = self.project?.segments[storedIndex]
                                self.project?.segments[storedIndex].cropKeyframes = framed.cropKeyframes
                                self.project?.segments[storedIndex].cropTrackingVersion = SubjectFramer.version
                                do { try self.save() }
                                catch {
                                    if let previous { self.project?.segments[storedIndex] = previous }
                                    throw error
                                }
                            }
                        }
                    }
                    try Task.checkCancellation()
                    try await ShortMaker.export(source: URL(fileURLWithPath: video.path), segment: segment, destination: destination, quality: choice.quality)
                    await MainActor.run {
                        self.exportedFiles.append(destination)
                        self.generationProgress = Double(self.exportedFiles.count) / Double(total)
                        self.message = "Exported \(self.exportedFiles.count) of \(total)…"
                    }
                    return number
                }
                for video in sources {
                    try Task.checkCancellation()
                    generationProgress = Double(exportedFiles.count) / Double(total)
                    generationStage = "Copying the main video"
                    let original = URL(fileURLWithPath: video.path)
                    let destination = uniqueDestination(for: original, in: folder)
                    // A copy, not a re-render: the main video keeps its original quality. Same-drive copies are instant clones.
                    try await ShortMaker.copySource(original, to: destination)
                    exportedFiles.append(destination)
                }
                var parts: [String] = []
                if !segments.isEmpty { parts.append(segments.count == 1 ? "1 Short" : "\(segments.count) Shorts") }
                if !sources.isEmpty { parts.append("the main video") }
                message = withModelNote("Exported \(parts.joined(separator: " and ")) to \(Self.displayPath(folder)).")
                exportSummary = message
                Notifier.notifyIfInBackground(title: "Export finished", body: message)
                let seconds = segments.reduce(0) { $0 + $1.element.duration }
                Task { await account.recordExport(shortCount: segments.count, seconds: seconds, quality: choice.quality.rawValue) }
            }
            catch {
                let completed = exportedFiles.count
                message = Task.isCancelled
                    ? "Export cancelled. \(completed) of \(total) files finished in \(Self.displayPath(folder))."
                    : completed == 0
                    ? "Export failed: \(error.localizedDescription)"
                    : "Export stopped after \(completed) of \(total) files. Completed files are in \(Self.displayPath(folder)). \(error.localizedDescription)"
                if !Task.isCancelled { Notifier.notifyIfInBackground(title: "Export failed", body: message) }
            }
            isBusy = false; isExporting = false; generationProgress = nil; generationTask = nil
        }
    }

    /// "Downloads › Prism › My project" for a folder in the home folder, else the full path.
    nonisolated static func displayPath(_ url: URL) -> String {
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        guard url.path.hasPrefix(home + "/") else { return url.path }
        return url.path.dropFirst(home.count + 1).split(separator: "/").joined(separator: " › ")
    }

    func revealExports() {
        if !exportedFiles.isEmpty {
            NSWorkspace.shared.activateFileViewerSelecting(exportedFiles)
            return
        }
        let folder = [lastExportFolder, project == nil ? nil : defaultExportFolder()].compactMap { $0 }
            .first { FileManager.default.fileExists(atPath: $0.path) } ?? projectURL?.appendingPathComponent("Exports")
        if let folder { NSWorkspace.shared.open(folder) }
    }
    func revealLibrary() {
        NSWorkspace.shared.activateFileViewerSelecting([libraryURL])
    }
    private func rememberEdit() { editHistory.append(project?.segments ?? []) }
    private func formatSeconds(_ value: Double) -> String {
        value.rounded() == value ? "\(Int(value)) seconds" : String(format: "%.1f seconds", value)
    }
    /// `captionsOnly` edits swap the caption overlay in place, so the player keeps its playhead.
    /// `id` edits that Short even when another one is open, without switching the preview to it.
    private func applyEdit(to id: UUID? = nil, captionsOnly: Bool = false, _ change: (inout EditSegment, MediaItem) -> String?) -> String? {
        guard let previous = project?.segments else { return nil }
        var segments = previous
        if segments.isEmpty, id == nil, let video = project?.media.first(where: { $0.kind == "video" }) {
            segments = [.init(mediaID: video.id, duration: min(video.duration, 30))]
        }
        guard let index = segments.firstIndex(where: { $0.id == (id ?? previewShortID) }) ?? (id == nil ? segments.indices.first : nil),
              let video = project?.media.first(where: { $0.id == segments[index].mediaID }) else { return nil }
        var segment = segments[index]
        guard let reply = change(&segment, video) else { return nil }
        segments[index] = segment
        guard segments != previous else { message = reply; return reply }
        project?.segments = segments
        do {
            try save()
            editHistory.append(previous)
            redoHistory.removeAll()
            if captionsOnly && player != nil && previewSegment?.id == segment.id { previewSegment = segment }
            else if id == nil || id == previewShortID { selectPreview(segment.id) }
            message = reply; return reply
        } catch {
            project?.segments = previous
            return "Could not save the edit: \(error.localizedDescription)"
        }
    }
    func setFraming(fit: Bool) {
        guard !isBusy else { return }
        if let reply = applyEdit({ segment, _ in
            segment.fitToFrame = fit
            segment.splitScreen = nil
            if fit { segment.cropZoom = 1 }
            return fit ? "The full source frame will be visible in the vertical video." : "The vertical crop follows the saved focus path."
        }) { message = reply }
    }

    func setSplitScreen() {
        guard !isBusy, let segment = activeSegment,
              let video = project?.media.first(where: { $0.id == segment.mediaID }) else { return }
        guard segment.splitCenters == nil else {
            _ = applyEdit { segment, _ in
                segment.splitScreen = true; segment.captionPosition = .middle
                return "Split screen: left person on top, right person on the bottom, captions in the middle."
            }
            return
        }
        guard let configuration = geminiConfiguration(for: video) else { message = "Sign in to your Prism account first."; return }
        isBusy = true
        message = "Prism AI is finding both speakers…"
        Task {
            let centers = await ShortMaker.findSplitCenters(URL(fileURLWithPath: video.path), start: segment.start, duration: segment.duration,
                                                           configuration: configuration)
            isBusy = false
            // Saved to the Short it was made for, even if another Short was opened meanwhile.
            let reply = applyEdit(to: segment.id) { segment, _ in
                segment.splitScreen = true; segment.captionPosition = .middle; segment.splitCenters = centers
                return withModelNote(centers == nil
                    ? "Split screen on. Couldn't find two faces, so the left half is on top and the right half on the bottom."
                    : "Split screen: each speaker is centered in their half, captions in the middle.")
            }
            if reply == nil { message = "The Short was removed before split screen was ready." }
        }
    }

    func holdFramingAtCenter() {
        guard !isBusy else { return }
        _ = applyEdit { segment, _ in
            segment.cropPosition = 0.5
            segment.cropKeyframes = []
            segment.cropTrackingVersion = SubjectFramer.version
            return "Framing centered and held steady. Re-track subject to follow movement."
        }
    }

    func regenerateSelectedSubtitles() {
        guard !isBusy, let segment = activeSegment,
              let video = project?.media.first(where: { $0.id == segment.mediaID }) else {
            message = "Select a Short before generating subtitles."
            return
        }
        let segmentID = segment.id
        guard let configuration = geminiConfiguration(for: video) else { message = "Sign in to your Prism account first."; return }
        isBusy = true
        message = "Prism AI is transcribing this Short…"
        Task {
            let result: CaptionGenerationResult
            do {
                let cloud = try await GeminiSelection.regenerateCaptions(url: URL(fileURLWithPath: video.path),
                    interval: (segment.start, segment.start + segment.duration), configuration: configuration)
                let relativeWords = cloud.words.map { TimedSpeechWord(text: $0.text, start: $0.start - segment.start, duration: $0.duration) }
                let relativeCues = cloud.cues.map { TimedCaption(text: $0.text, start: $0.start - segment.start, duration: $0.duration) }
                result = .init(cues: relativeCues, issue: relativeCues.isEmpty ? .noSpeech : nil, words: relativeWords, notice: cloud.notice)
            } catch {
                isBusy = false
                message = "Could not transcribe Short: \(error.localizedDescription)"
                return
            }
            // Saved to the Short it was made for, even if another Short was opened meanwhile.
            guard let index = project?.segments.firstIndex(where: { $0.id == segmentID }) else {
                isBusy = false
                message = "The Short was removed before its subtitles were ready."
                return
            }
            guard !result.cues.isEmpty else {
                isBusy = false
                message = result.issue?.message ?? "Speech recognition couldn't create subtitles. Try again."
                return
            }
            editHistory.append(project?.segments ?? [])
            project?.segments[index].captions = result.cues
            project?.segments[index].speechWords = result.words
            project?.segments[index].captionNotice = result.notice
            do {
                try save()
                redoHistory.removeAll()
                isBusy = false
                if previewSegment?.id == segmentID { previewSegment = project?.segments[index] }
                message = withModelNote("Added \(result.cues.count) timed subtitle phrases." + (result.notice.map { " " + $0 } ?? ""))
            } catch {
                if let previous = editHistory.popLast() { project?.segments = previous }
                isBusy = false
                message = "Could not save subtitles: \(error.localizedDescription)"
            }
        }
    }

    /// ↑ and ↓ in the editor: the previous or next Short, in the order the Shorts list shows them.
    func selectAdjacentShort(_ step: Int) {
        guard !isBusy, var shorts = project?.segments, !shorts.isEmpty else { return }
        if UserDefaults.standard.bool(forKey: "editor.shortsBestFirst") {
            let order = Dictionary(uniqueKeysWithValues: shorts.enumerated().map { ($1.id, $0) })
            shorts.sort { ($0.score ?? -1, -order[$0.id]!) > ($1.score ?? -1, -order[$1.id]!) }
        }
        let current = shorts.firstIndex { $0.id == previewShortID }
        let next = current.map { min(shorts.count - 1, max(0, $0 + step)) } ?? (step > 0 ? 0 : shorts.count - 1)
        guard shorts[next].id != previewShortID else { return }
        selectPreview(shorts[next].id)
    }

    var activeSegment: EditSegment? {
        project?.segments.first(where: { $0.id == previewShortID })
    }

    func undoFromEditor() { guard !isBusy else { return }; message = undoEdit() }
    func redoFromEditor() { guard !isBusy else { return }; message = redoEdit() }

    func removeShort(_ id: UUID) {
        guard !isBusy, let index = project?.segments.firstIndex(where: { $0.id == id }) else { return }
        let wasPreviewed = previewShortID == id
        let previousSelection = project?.segments.first(where: { $0.id != id })?.id
        rememberEdit()
        project?.segments.remove(at: index)
        do {
            try save()
            redoHistory.removeAll()
            if wasPreviewed { selectPreview(previousSelection) }
            message = "Removed Short. Use Undo to restore it."
        } catch {
            if let previous = editHistory.popLast() { project?.segments = previous }
            message = "Could not remove Short: \(error.localizedDescription)"
        }
    }

    func toggleSelectedAudio() {
        guard !isBusy, activeSegment != nil else { return }
        if let reply = applyEdit({ segment, _ in
            segment.isMuted = segment.isMuted != true
            return segment.isMuted == true ? "Clip audio muted." : "Source audio restored."
        }) { message = reply }
    }

    func setSelectedCaptionStyle(_ style: CaptionStyle) {
        guard !isBusy, activeSegment != nil else { return }
        if let reply = applyEdit(captionsOnly: true, { segment, _ in
            segment.captionStyle = style
            return "\(style.title) subtitles applied."
        }) { message = reply }
        // Word-by-word styles need exact timing, so every Short still without it starts transcribing now.
        if style.usesWordTiming { timeWordsForAllShorts() }
    }

    /// Bumped when the video limit counts a video, so Settings › Usage redraws.
    var usageRevision = 0
    /// Set by the limit popup's "See usage", so Settings opens on its Usage page.
    var opensUsageSettings = false

    /// Shorts whose words Prism AI is timing in the background.
    var timingShortIDs: Set<UUID> = []

    /// Transcribes every Short in the project that has speech but no exact word timing, several at a time, in the
    /// background. The editor stays usable; each Short updates as soon as its timing arrives.
    func timeWordsForAllShorts() {
        guard let project, let projectURL else { return }
        let pending = project.segments.filter { segment in
            segment.speechWords?.isEmpty != false && !timingShortIDs.contains(segment.id)
                && project.media.first(where: { $0.id == segment.mediaID })?.hasAudio == true
        }
        guard !pending.isEmpty else { return }
        // The project's saved sentence transcript covers most Shorts, so only their words need a new transcription.
        let jobs = pending.compactMap { segment -> (EditSegment, URL, [TimedCaption]?, GeminiConfiguration)? in
            guard let video = project.media.first(where: { $0.id == segment.mediaID }), let configuration = geminiConfiguration(for: video) else { return nil }
            return (segment, URL(fileURLWithPath: video.path),
                    project.transcripts?[video.id.uuidString]?.cues(covering: (segment.start, segment.start + segment.duration)), configuration)
        }
        timingShortIDs.formUnion(jobs.map(\.0.id))
        Task {
            await withTaskGroup(of: (EditSegment, GeminiSelection.CloudCaptions?).self) { group in
                var next = 0
                func startNext() {
                    guard next < jobs.count else { return }
                    let (segment, url, saved, configuration) = jobs[next]; next += 1
                    group.addTask {
                        let cloud = try? await GeminiSelection.regenerateCaptions(url: url, interval: (segment.start, segment.start + segment.duration),
                                                                                  configuration: configuration, saved: saved)
                        return (segment, cloud)
                    }
                }
                for _ in 0..<ShortMaker.parallelRequests { startNext() }
                while let (segment, cloud) = await group.next() {
                    timingShortIDs.remove(segment.id)
                    if let cloud, self.projectURL == projectURL { applyWordTiming(cloud, to: segment) }
                    startNext()
                }
            }
        }
    }

    /// Stores timing for the Short it was made for, as long as its range hasn't moved meanwhile. Caption lines the
    /// person edited in the meantime are kept; only untouched lines are replaced by the timed transcript.
    private func applyWordTiming(_ cloud: GeminiSelection.CloudCaptions, to snapshot: EditSegment) {
        guard let index = project?.segments.firstIndex(where: { $0.id == snapshot.id }), let current = project?.segments[index],
              current.start == snapshot.start, current.duration == snapshot.duration else { return }
        let words = cloud.words.map { TimedSpeechWord(text: $0.text, start: $0.start - snapshot.start, duration: $0.duration) }
        let cues = cloud.cues.map { TimedCaption(text: $0.text, start: $0.start - snapshot.start, duration: $0.duration) }
        var updated = current
        if !cues.isEmpty, current.captions == snapshot.captions { updated.captions = cues }
        if !words.isEmpty { updated.speechWords = words; updated.captionNotice = nil }
        guard updated != current else { return }
        project?.segments[index] = updated
        try? save()
        // Captions draw over the player, so the preview keeps playing where it is.
        if previewSegment?.id == snapshot.id { previewSegment = updated }
    }

    /// Subtitle placement, size and pop-in for the selected Short; nil leaves that setting unchanged.
    func setSelectedCaptionLayout(position: CaptionPosition? = nil, size: CaptionSize? = nil, animated: Bool? = nil) {
        guard !isBusy, activeSegment != nil else { return }
        if let reply = applyEdit(captionsOnly: true, { segment, _ in
            if let position { segment.captionPosition = position }
            if let size { segment.captionSize = size }
            if let animated { segment.captionAnimated = animated }
            return "Subtitle layout saved."
        }) { message = reply }
    }

    /// Replaces caption wording only; timings stay. An empty line removes that caption.
    func updateSelectedCaptionTexts(_ texts: [String]) {
        guard !isBusy, let cues = activeSegment?.captions, texts.count == cues.count else { return }
        if let reply = applyEdit(captionsOnly: true, { segment, _ in
            segment.captions = zip(cues, texts).compactMap { cue, text in
                let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
                return trimmed.isEmpty ? nil : TimedCaption(text: trimmed, start: cue.start, duration: cue.duration)
            }
            return "Caption text saved."
        }) { message = reply }
    }

    func updateSelectedEdit(start: Double, duration: Double, caption: String, captionStart: Double, captionDuration: Double,
                            cropZoom: Double = 1.08, cropPosition: Double = 0.5) {
        guard !isBusy, activeSegment != nil else { return }
        if let reply = applyEdit({ segment, media in
            guard captionStart.isFinite, captionDuration.isFinite, cropZoom.isFinite, cropPosition.isFinite, captionDuration > 0,
                  cropZoom >= 1, cropZoom <= 1.5, cropPosition >= 0, cropPosition <= 1,
                  rebase(&segment, media: media, start: start, duration: duration) else { return nil }
            let finalCaptionStart = min(max(0, captionStart), max(0, segment.duration - 0.05))
            let finalCaptionDuration = min(captionDuration, segment.duration - finalCaptionStart)
            guard finalCaptionDuration > 0 else { return nil }
            segment.caption = caption
            segment.cropZoom = cropZoom
            segment.cropPosition = cropPosition
            segment.captionStart = finalCaptionStart
            segment.captionDuration = finalCaptionDuration
            return abs(segment.start - start) > 0.005 || abs(segment.duration - duration) > 0.005
                ? "Clip changes saved on complete speech boundaries (\(formatSeconds(segment.duration)))."
                : "Clip changes saved."
        }) { message = reply }
        else { message = "Choose valid clip and text ranges within the source and clip duration." }
    }

    /// Moves a Short to a new source range without cutting a spoken word, carrying its captions, word timings
    /// and focus path along so they stay on the same moments. False when the range is invalid.
    private func rebase(_ segment: inout EditSegment, media: MediaItem, start: Double, duration: Double) -> Bool {
        guard start.isFinite, duration.isFinite, start >= 0, duration > 0, start + duration <= media.duration + 0.001 else { return false }
        let oldSourceStart = segment.start
        let absoluteWords = (segment.speechWords ?? []).map {
            TimedSpeechWord(text: $0.text, start: oldSourceStart + $0.start, duration: $0.duration)
        }
        var finalStart = start
        if let cutWord = absoluteWords.first(where: { $0.start + 0.02 < finalStart && $0.start + $0.duration - 0.02 > finalStart }) {
            finalStart = max(0, cutWord.start)
        }
        var finalEnd = min(media.duration, finalStart + duration)
        if let cutWord = absoluteWords.first(where: { $0.start + 0.02 < finalEnd && $0.start + $0.duration - 0.02 > finalEnd }) {
            let wordEnd = cutWord.start + cutWord.duration
            finalEnd = wordEnd <= media.duration ? wordEnd + 0.04 : max(finalStart + 0.1, cutWord.start)
            finalEnd = min(media.duration, finalEnd)
        }
        let finalDuration = finalEnd - finalStart
        guard finalDuration > 0 else { return false }
        if let currentCaptions = segment.captions {
            segment.captions = currentCaptions.compactMap { cue in
                let absoluteStart = oldSourceStart + cue.start
                let absoluteEnd = absoluteStart + cue.duration
                let clippedStart = max(finalStart, absoluteStart)
                let clippedEnd = min(finalEnd, absoluteEnd)
                guard clippedEnd > clippedStart else { return nil }
                return TimedCaption(text: cue.text, start: clippedStart - finalStart, duration: clippedEnd - clippedStart)
            }
        }
        segment.speechWords = absoluteWords.compactMap { word in
            let end = word.start + word.duration
            guard word.start >= finalStart - 0.01, end <= finalEnd + 0.01 else { return nil }
            return TimedSpeechWord(text: word.text, start: word.start - finalStart, duration: word.duration)
        }
        if let currentPath = segment.cropKeyframes, !currentPath.isEmpty {
            let points = currentPath.map { CropKeyframe(time: oldSourceStart + $0.time, position: $0.position, isSceneCut: $0.isSceneCut, preserveWholeFrame: $0.preserveWholeFrame) }.sorted { $0.time < $1.time }
            func position(at time: Double) -> Double? {
                guard let first = points.first, let last = points.last else { return nil }
                if time <= first.time { return first.position }
                if time >= last.time { return last.position }
                guard let rightIndex = points.firstIndex(where: { $0.time >= time }), rightIndex > 0 else { return nil }
                let left = points[rightIndex - 1]
                let right = points[rightIndex]
                if right.isSceneCut == true && time < right.time { return left.position }
                let fraction = (time - left.time) / max(0.001, right.time - left.time)
                return left.position + (right.position - left.position) * fraction
            }
            var rebased = points.compactMap { point -> CropKeyframe? in
                guard point.time > finalStart, point.time < finalEnd else { return nil }
                return .init(time: point.time - finalStart, position: point.position, isSceneCut: point.isSceneCut, preserveWholeFrame: point.preserveWholeFrame)
            }
            // New end points keep the neighboring whole-frame flag, or a trimmed Fit-style path would zoom in at its edges.
            func wholeFrame(at time: Double) -> Bool? { (points.last { $0.time <= time } ?? points.first)?.preserveWholeFrame }
            if let firstPosition = position(at: finalStart) {
                rebased.insert(.init(time: 0, position: firstPosition, preserveWholeFrame: wholeFrame(at: finalStart)), at: 0)
            }
            if let lastPosition = position(at: finalEnd) {
                rebased.append(.init(time: finalDuration, position: lastPosition, preserveWholeFrame: wholeFrame(at: finalEnd)))
            }
            segment.cropKeyframes = rebased
        }
        segment.start = finalStart
        segment.duration = finalDuration
        return true
    }

    func adjustCropKeyframe(from sourceTime: Double, to targetTime: Double, position: Double, insert: Bool) {
        guard !isBusy, let activeSegment else { return }
        guard sourceTime.isFinite, targetTime.isFinite, position.isFinite,
              targetTime >= 0, targetTime <= activeSegment.duration, position >= 0, position <= 1 else { return }
        _ = applyEdit { segment, _ in
            // Path points are stored without the tracking offset (cropPosition − 0.5) that preview, export and the
            // focus track add on top, so the offset is taken off the clicked position and the starting points sit at 0.5.
            let bias = (segment.cropPosition ?? 0.5) - 0.5
            var stored = position - bias
            var points = segment.cropKeyframes ?? [CropKeyframe(time: 0, position: 0.5), CropKeyframe(time: segment.duration, position: 0.5)]
            // A strong tracking offset can put the clicked point outside the stored 0–1 range. Bake the offset
            // into the existing path first, preserving its visible framing, so either edge remains reachable.
            if !(0...1).contains(stored) {
                points = points.map { .init(time: $0.time, position: min(1, max(0, $0.position + bias)),
                                           isSceneCut: $0.isSceneCut, preserveWholeFrame: $0.preserveWholeFrame) }
                segment.cropPosition = 0.5
                stored = position
            }
            if insert {
                if let nearest = points.indices.min(by: { abs(points[$0].time - targetTime) < abs(points[$1].time - targetTime) }),
                   abs(points[nearest].time - targetTime) < 0.18 {
                    points[nearest].position = stored
                } else {
                    points.append(.init(time: targetTime, position: stored))
                }
            } else if let nearest = points.indices.min(by: { abs(points[$0].time - sourceTime) < abs(points[$1].time - sourceTime) }) {
                points[nearest].time = targetTime
                points[nearest].position = stored
            }
            // Scene cuts and whole-frame shots stay marked; dropping them turned cuts into pans.
            points = points
                .filter { $0.time.isFinite && $0.position.isFinite }
                .map { .init(time: min(segment.duration, max(0, $0.time)), position: min(1, max(0, $0.position)),
                             isSceneCut: $0.isSceneCut, preserveWholeFrame: $0.preserveWholeFrame) }
                .sorted { $0.time < $1.time }
            var unique: [CropKeyframe] = []
            for point in points {
                if let last = unique.last, abs(last.time - point.time) < 0.02 {
                    var merged = point
                    if last.isSceneCut == true { merged.isSceneCut = true }
                    merged.preserveWholeFrame = point.preserveWholeFrame ?? last.preserveWholeFrame
                    unique[unique.count - 1] = merged
                } else { unique.append(point) }
            }
            segment.cropKeyframes = unique
            return insert ? "Subject focus point added." : "Subject focus point moved."
        }
    }

    func retrackSelectedSubject() {
        guard !isBusy, let clip = activeSegment,
              let index = project?.segments.firstIndex(where: { $0.id == clip.id }) else { return }
        let previous = project?.segments ?? []
        project?.segments[index].cropTrackingVersion = 0
        do {
            try save()
            if previous != project?.segments { editHistory.append(previous); redoHistory.removeAll() }
            selectPreview(clip.id)
        } catch {
            project?.segments = previous
            message = "Could not refresh subject tracking: \(error.localizedDescription)"
        }
    }

    func addManualClip() {
        guard !isBusy, let video = project?.media.first(where: { $0.id == selection }), video.duration > 0 else { return }
        let time = previewShortID == nil ? player?.currentTime().seconds ?? 0 : 0
        let start = min(max(0, time.isFinite ? time : 0), max(0, video.duration - 1))
        let previous = project?.segments ?? []
        let clip = EditSegment(mediaID: video.id, start: start, duration: min(shortDuration > 0 ? shortDuration : 30, video.duration - start))
        rememberEdit()
        project?.segments.append(clip)
        do {
            try save()
            redoHistory.removeAll()
            selectPreview(clip.id)
            message = "Clip added. Adjust its timing in the inspector."
        } catch {
            project?.segments = previous
            editHistory.removeLast()
            message = "Could not save clip: \(error.localizedDescription)"
        }
    }

    var previewLength: Double { activeSegment?.duration ?? project?.media.first(where: { $0.id == selection })?.duration ?? 0 }

    func togglePlayback() {
        guard let player else { return }
        if player.rate != 0 { player.pause(); return }
        if player.currentTime().seconds >= previewLength - 0.1 { seekPreview(to: 0) }
        player.play()
    }

    func seekPreview(by seconds: Double) {
        guard let player else { return }
        seekPreview(to: player.currentTime().seconds + seconds)
    }

    func seekPreview(to seconds: Double) {
        guard seconds.isFinite else { return }
        let limit = activeSegment?.duration ?? project?.media.first(where: { $0.id == selection })?.duration ?? 0
        player?.seek(to: CMTime(seconds: max(0, min(seconds, limit)), preferredTimescale: 600), toleranceBefore: .zero, toleranceAfter: .zero)
    }

    private func undoEdit() -> String {
        guard project != nil, let previous = editHistory.last else { return "There isn’t an edit to undo yet." }
        let current = project?.segments ?? []
        project?.segments = previous
        do {
            try save()
            editHistory.removeLast()
            redoHistory.append(current)
            let restoredSelection = previous.contains(where: { $0.id == previewShortID }) ? previewShortID : previous.first?.id
            selectPreview(restoredSelection)
            return "Undone. I restored the previous timeline edit."
        } catch {
            project?.segments = current
            return "Could not save undo: \(error.localizedDescription)"
        }
    }

    private func redoEdit() -> String {
        guard project != nil, let next = redoHistory.last else { return "There isn’t an edit to redo yet." }
        let current = project?.segments ?? []
        project?.segments = next
        do {
            try save()
            redoHistory.removeLast()
            editHistory.append(current)
            let restoredSelection = next.contains(where: { $0.id == previewShortID }) ? previewShortID : next.first?.id
            selectPreview(restoredSelection)
            return "Redone. Restored the timeline edit."
        } catch {
            project?.segments = current
            return "Could not save redo: \(error.localizedDescription)"
        }
    }

}

private struct PointerFeedback: ViewModifier {
    @Environment(\.isEnabled) private var isEnabled
    @State private var isHovering = false
    @State private var pointingCursorIsPushed = false

    @ViewBuilder
    func body(content: Content) -> some View {
        let feedback = content
            .contentShape(Rectangle())
            .onHover { hovering in
                isHovering = hovering && isEnabled
                if #unavailable(macOS 15.0) {
                    if hovering && isEnabled && !pointingCursorIsPushed {
                        NSCursor.pointingHand.push()
                        pointingCursorIsPushed = true
                    } else if (!hovering || !isEnabled) && pointingCursorIsPushed {
                        NSCursor.pop()
                        pointingCursorIsPushed = false
                    }
                }
            }
            .onDisappear {
                if pointingCursorIsPushed {
                    NSCursor.pop()
                    pointingCursorIsPushed = false
                }
            }
            .brightness(isHovering ? 0.08 : 0)
            .scaleEffect(isHovering ? 1.015 : 1)
            .animation(.easeOut(duration: 0.12), value: isHovering)
        if #available(macOS 15.0, *) {
            feedback.pointerStyle(isEnabled ? .link : .default)
        } else {
            feedback
        }
    }
}

private extension View {
    func pointerFeedback() -> some View { modifier(PointerFeedback()) }
}

private struct ResourceRefreshOption: Identifiable {
    let title: String
    let seconds: Double
    var id: Double { seconds }
}

private struct SettingsCategoryTile: View {
    let title: String
    let detail: String
    let icon: String
    let isSelected: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            VStack(alignment: .leading, spacing: 11) {
                HStack {
                    Image(systemName: icon)
                        .font(Prism.text(20, .medium))
                        .foregroundStyle(Prism.accent)
                        .frame(width: 38, height: 38)
                        .background(Prism.surface2, in: RoundedRectangle(cornerRadius: 12))
                    Spacer()
                    if isSelected {
                        Image(systemName: "checkmark.circle.fill")
                            .foregroundStyle(Prism.accent)
                            .accessibilityHidden(true)
                    }
                }
                Text(title).font(Prism.text(14, .medium))
                Text(detail).font(Prism.text(10)).foregroundStyle(Prism.textSecondary).lineLimit(2)
                Spacer(minLength: 0)
            }
            .padding(14)
            .frame(maxWidth: .infinity, minHeight: 136, maxHeight: 136, alignment: .topLeading)
            .background(isSelected ? Prism.accent.opacity(0.15) : Prism.surface1, in: RoundedRectangle(cornerRadius: 12))
            .overlay(RoundedRectangle(cornerRadius: 12).stroke(isSelected ? Prism.accent : Prism.surface2, lineWidth: isSelected ? 2 : 1))
            .contentShape(RoundedRectangle(cornerRadius: 16))
        }
        .buttonStyle(.plain)
        .pointerFeedback()
        .accessibilityAddTraits(isSelected ? .isSelected : [])
    }
}

struct ContentView: View {
    @Bindable var model: AppModel
    @State private var isDropTarget = false
    @State private var isHomeDropTarget = false
    @State private var choosingCaptions = false
    @State private var choosingType = false
    @State private var showAllProjects = false
    @State private var openFolderID: UUID?
    @State private var folderNamePrompt: FolderNamePrompt?
    @State private var folderNameText = ""
    @State private var dropTargetFolder: UUID?
    private struct FolderNamePrompt: Identifiable { let id = UUID(); var folderID: UUID?; var movingProject: String? }
    @State private var projectShortCounts: [String: Int] = [:]
    @State private var renameProjectPath: String?
    @State private var renameText = ""
    @State private var deleteProjectPath: String?
    @State private var statsProject: ProjectPath?
    /// The export card's Shorts list height, measured so a short list leaves no empty space.
    @State var exportListHeight: CGFloat = 0
    /// Shorts opened on the export card to show their title and description.
    @State var openExportShorts: Set<UUID> = []
    /// The sidebar logo turns into the open or close sidebar control while the pointer is on it.
    @State var hoveringLogo = false
    @FocusState private var keyFieldFocused: Bool
    @AppStorage(PrismAppearance.storageKey) var appearance = PrismAppearance.system
    @AppStorage("editor.leftSidebarWidth") var leftSidebarWidth = 248.0
    @AppStorage("editor.rightSidebarWidth") var rightSidebarWidth = 282.0
    @AppStorage("editor.timelineHeight") var timelineHeight = 278.0
    @AppStorage("system.resourceRefreshSeconds") private var resourceRefreshSeconds = 60.0
    @State private var selectedSettingsCategory: SettingsCategory = .account
    /// The signed-in account's video counts from Supabase; local history cannot represent an account's allowance.
    @State private var serverUsage: (used: Double, allowance: Double)?
    @State private var usageAccount: String?
    @State private var usageLoading = false
    @State private var promoCode = ""
    @State private var promoStatus = ""
    private let resourceRefreshOptions: [ResourceRefreshOption] = [
        .init(title: "1 second", seconds: 1), .init(title: "5 seconds", seconds: 5),
        .init(title: "10 seconds", seconds: 10), .init(title: "30 seconds", seconds: 30),
        .init(title: "1 minute", seconds: 60), .init(title: "5 minutes", seconds: 300),
        .init(title: "10 minutes", seconds: 600), .init(title: "15 minutes", seconds: 900),
        .init(title: "30 minutes", seconds: 1_800), .init(title: "45 minutes", seconds: 2_700),
        .init(title: "60 minutes", seconds: 3_600)
    ]
    private enum SettingsCategory { case account, usage, systemResources, updates }
    @State private var accountEmail = ""
    @State private var accountPassword = ""
    @Environment(AppUpdater.self) var updater
    private var tutorialFlow: FirstRunTutorial.Flow {
        switch model.screen {
        case .home: .home
        case .importSource:
            model.shortsSource == nil ? .upload : choosingType ? .contentType : choosingCaptions ? .captions : .settings
        case .editor: .editor
        default: .other
        }
    }
    private var tutorialVisible: Bool {
        model.hasAIAccess && model.tutorial.isActive && !model.isBusy && !model.isPlayerExpanded
            && model.generationError == nil && model.exportChoice == nil && model.exportSummary == nil
    }
    private func connectTutorial() {
        model.tutorial.connect(email: model.account.email)
        if model.tutorial.step == .start { model.screen = .home }
        model.tutorial.follow(tutorialFlow)
    }
    var body: some View {
        HStack(spacing: 0) {
            if model.screen != .editor { sidebar.frame(width: model.isSidebarCollapsed ? 76 : 252) }
            VStack(spacing: 0) {
                if model.screen == .editor { editorHeader } else { topbar }
                if model.screen == .home { dashboard }
                else if model.screen == .create { creationModes }
                else if model.screen == .importSource { sourceImport }
                else if model.screen == .settings { settingsPage }
                else { editingWorkspace }
            }
        }
        .background(Prism.surface0)
        .overlayPreferenceValue(TutorialAnchors.self) { anchors in
            if tutorialVisible, let step = model.tutorial.step {
                GeometryReader { proxy in
                    let target = step.target.flatMap { anchors[$0] }.map { proxy[$0] }
                    let viewport = anchors[.sourceViewport].map { proxy[$0] }
                    TutorialSpotlight(spotlight: target.map { rect in viewport.map { rect.intersection($0) } ?? rect })
                }
            }
        }
        .safeAreaInset(edge: .bottom, spacing: 0) {
            if tutorialVisible {
                TutorialCoach(tutorial: model.tutorial) { model.screen = .importSource }
            }
        }
        .overlay {
            if model.isPlayerExpanded, model.screen == .editor, let player = model.player {
                expandedPlayer(player)
            }
        }
        .overlay {
            if model.screen == .editor, let progress = model.generationProgress { generationOverlay(progress) }
            else if model.screen == .editor, let error = model.generationError { generationErrorOverlay(error) }
            else if model.screen == .editor, let summary = model.exportSummary { exportDoneOverlay(summary) }
            else if model.screen == .editor, let choice = model.exportChoice { exportChoiceOverlay(choice) }
        }
        .overlay { if let run = model.pendingPaidRun { paidRunOverlay(run) } }
        .overlay(alignment: .bottom) {
            if updater.updatedVersion != nil { updatedBanner }
            else if updater.readyVersion != nil, !updater.isBannerDismissed { updateBanner }
        }
        .overlay { if !model.hasAIAccess { signInGate } }
        .tint(Prism.accent)
        // The title bar names the open project in the editor, like other Mac document apps.
        .navigationTitle(model.screen == .editor ? (model.project?.displayTitle ?? "Prism") : "Prism")
        .animation(.easeInOut(duration: 0.2), value: model.isSidebarCollapsed)
        .onAppear { connectTutorial() }
        .onChange(of: model.account.email) { _, _ in connectTutorial() }
        .onChange(of: tutorialFlow) { _, flow in model.tutorial.follow(flow) }
    }
    /// Prism can't do anything without Prism AI, so while no key is saved this card covers the whole app and blocks it.
    /// Until someone signs in, Prism's AI can't run. Signing in replaces the old key-entry step.
    /// Until someone signs in, Prism's AI can't run, so this card covers the app. It signs in or creates the account in place.
    var signInGate: some View {
        ZStack {
            Color.black.opacity(0.72).contentShape(Rectangle()).onTapGesture {}
            VStack(alignment: .leading, spacing: 16) {
                HStack(spacing: 10) {
                    PrismMark().frame(height: 26)
                    Text("Sign in to Prism").font(Prism.display(22))
                }
                Text("Sign in or create a free account to start. Prism's AI runs on our server, so you don't need an API key.")
                    .font(Prism.text(13)).foregroundStyle(Prism.textSecondary).fixedSize(horizontal: false, vertical: true)
                TextField("Email", text: $accountEmail)
                    .textFieldStyle(.roundedBorder).textContentType(.username)
                SecureField("Password (at least 6 characters)", text: $accountPassword)
                    .textFieldStyle(.roundedBorder).textContentType(.password)
                    .onSubmit { Task { await model.account.signIn(email: accountEmail, password: accountPassword); if model.account.isSignedIn { accountPassword = "" } } }
                if !model.account.status.isEmpty {
                    Text(model.account.status).font(Prism.text(12)).foregroundStyle(Prism.textSecondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                HStack {
                    Button("Create account") { Task { await model.account.signUp(email: accountEmail, password: accountPassword); accountPassword = "" } }
                    Spacer()
                    if model.account.isWorking { ProgressView().controlSize(.small) }
                    Button("Sign in") { Task { await model.account.signIn(email: accountEmail, password: accountPassword); if model.account.isSignedIn { accountPassword = "" } } }
                        .buttonStyle(.prismPrimary).keyboardShortcut(.defaultAction)
                }
                .disabled(model.account.isWorking || accountEmail.isEmpty || accountPassword.isEmpty)
            }
            .padding(28)
            .frame(width: 460)
            .background(Prism.surface1, in: RoundedRectangle(cornerRadius: 16))
            .overlay(RoundedRectangle(cornerRadius: 16).stroke(Prism.border))
        }
    }
    /// Fills the app window (not macOS full screen), so it opens and closes instantly.
    func expandedPlayer(_ player: AVPlayer) -> some View {
        ZStack(alignment: .topTrailing) {
            Color.black
            RelioPlayerView(player: player, captionSegment: model.previewSegment, showsControls: true)
            Button { model.isPlayerExpanded = false } label: {
                Image(systemName: "arrow.down.right.and.arrow.up.left")
                    .font(Prism.text(13, .medium)).foregroundStyle(.white)
                    .frame(width: 34, height: 34).background(.black.opacity(0.6), in: Circle())
            }
            .buttonStyle(.plain).padding(16)
            .keyboardShortcut(.cancelAction)
            .help("Exit full view · Esc").accessibilityLabel("Exit full view")
        }
        .onDisappear { model.isPlayerExpanded = false }
    }
    var sidebar: some View {
        VStack(alignment: .leading, spacing: 17) {
            if model.isSidebarCollapsed {
                logoToggle.frame(maxWidth: .infinity)
            } else {
                HStack(spacing: 10) {
                    logoToggle
                    Text("Prism").font(Prism.display(24)).tracking(-0.5)
                    Spacer()
                }
        Text("Your video editor · Cloud AI").font(Prism.text(12)).foregroundStyle(Prism.textSecondary)
            }
            Divider().padding(.vertical, 8)
            sidebarButton("Home", icon: "house.fill", selected: model.screen == .home) { model.screen = .home }
            sidebarButton("Create Shorts", icon: "plus.square.fill", selected: model.screen == .importSource, prominent: true, shortTitle: "Create") { model.startLongVideoToShort() }
            if model.project != nil {
                sidebarButton("Editor", icon: "film.stack.fill", selected: model.screen == .editor) { model.screen = .editor }
            }
            Spacer()
            sidebarButton("Settings", icon: "gearshape.fill", selected: model.screen == .settings) { model.screen = .settings }
            TimelineView(.periodic(from: .now, by: min(3_600, max(1, resourceRefreshSeconds)))) { _ in
                let machine = MachineProfile.detect()
                if model.isSidebarCollapsed {
                    VStack(spacing: 6) {
                        resourceRing(memory: machine.memoryUsage, storage: machine.freeStorageRatio)
                        Text("\(machine.freeGB) GB free").font(Prism.text(9, .medium)).foregroundStyle(Prism.accent)
                            .lineLimit(1).minimumScaleFactor(0.7)
                    }
                    .frame(maxWidth: .infinity)
                    .help("RAM used: \(String(format: "%.1f", machine.memoryUsedGB)) of \(machine.memoryGB) GB · Storage free: \(machine.freeGB) of \(machine.storageGB) GB")
                    .accessibilityLabel("RAM \(Int(machine.memoryUsage * 100)) percent used; \(machine.freeGB) gigabytes of storage free")
                } else {
                    VStack(alignment: .leading, spacing: 12) {
                        Text("System resources").font(Prism.text(11, .medium)).foregroundStyle(Prism.textSecondary)
                        VStack(spacing: 5) {
                            HStack(spacing: 6) {
                                Image(systemName: "memorychip").foregroundStyle(Prism.textSecondary)
                                Text("RAM used").foregroundStyle(Prism.textSecondary)
                                Spacer(minLength: 3)
                                Text("\(String(format: "%.1f", machine.memoryUsedGB)) / \(machine.memoryGB) GB")
                                    .foregroundStyle(Prism.textSecondary).monospacedDigit()
                            }.font(Prism.text(11, .medium))
                            PrismProgressLine(value: machine.memoryUsage)
                        }
                        VStack(spacing: 5) {
                            HStack(spacing: 6) {
                                Image(systemName: "internaldrive").foregroundStyle(Prism.textSecondary)
                                Text("Storage free").foregroundStyle(Prism.textSecondary)
                                Spacer(minLength: 3)
                                Text("\(machine.freeGB) / \(machine.storageGB) GB")
                                    .foregroundStyle(Prism.textSecondary).monospacedDigit()
                            }.font(Prism.text(11, .medium))
                            PrismProgressLine(value: machine.freeStorageRatio)
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .accessibilityElement(children: .combine)
                    .help("RAM and available storage refresh every \(resourceRefreshLabel)")
                }
            }
        }
        .padding(model.isSidebarCollapsed ? 14 : 24)
        .frame(maxHeight: .infinity, alignment: .topLeading)
        .background(Prism.surface1)
    }

    /// Asks before every re-analysis, which charges part of the video's minutes.
    func paidRunOverlay(_ run: AppModel.PaidRun) -> some View {
        let minutes = max(1, Int(run.minutes.rounded(.up)))
        return ZStack {
            Color.black.opacity(0.55).contentShape(Rectangle()).onTapGesture {}
            VStack(alignment: .leading, spacing: 14) {
                Label("Use your minutes?", systemImage: "gauge.with.dots.needle.33percent").font(Prism.text(16, .medium))
                Text("This re-analysis will use \(minutes) \(minutes == 1 ? "minute" : "minutes") of your plan.").font(Prism.text(13))
                Text("Re-analyzing a video uses part of its length: half on Trial, a third on Creator and Studio.")
                    .font(Prism.text(12)).foregroundStyle(Prism.textSecondary).fixedSize(horizontal: false, vertical: true)
                HStack {
                    Button("Cancel") { model.pendingPaidRun = nil }.controlSize(.large).keyboardShortcut(.cancelAction)
                    Spacer()
                    Button("Re-analyze") { model.confirmPaidRun() }.buttonStyle(.prismPrimary).keyboardShortcut(.defaultAction)
                }
            }
            .padding(24)
            .frame(width: 440)
            .background(Prism.surface1, in: RoundedRectangle(cornerRadius: 16))
            .overlay(RoundedRectangle(cornerRadius: 16).stroke(Prism.border))
            .accessibilityElement(children: .contain)
            .accessibilityLabel("Confirm a charged re-analysis")
        }
    }

    /// The logo, which shows the sidebar icon on hover and opens or closes the sidebar when clicked.
    var logoToggle: some View {
        let collapsed = model.isSidebarCollapsed
        return Button { model.isSidebarCollapsed.toggle() } label: {
            ZStack {
                PrismMark().frame(height: 24).opacity(hoveringLogo ? 0 : 1)
                Image(systemName: collapsed ? "sidebar.right" : "sidebar.left").font(Prism.text(17))
                    .foregroundStyle(Prism.textSecondary).opacity(hoveringLogo ? 1 : 0)
            }
            .frame(width: 36, height: 32)
            .background(hoveringLogo ? Prism.surface2 : .clear, in: RoundedRectangle(cornerRadius: 8))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain).pointerFeedback()
        .onHover { hovering in withAnimation(.easeOut(duration: 0.12)) { hoveringLogo = hovering } }
        .help(collapsed ? "Expand sidebar · ⌃⌘S" : "Collapse sidebar · ⌃⌘S")
        .accessibilityLabel(collapsed ? "Expand sidebar" : "Collapse sidebar")
    }

    /// One ring for the collapsed sidebar: RAM used on the outer arc and inside, free storage on the inner blue arc.
    private func resourceRing(memory: Double, storage: Double) -> some View {
        ZStack {
            arc(memory, color: Prism.text, width: 4)
            arc(storage, color: Prism.accent, width: 3).padding(6)
            VStack(spacing: 0) {
                Text("RAM").font(Prism.text(7, .medium)).foregroundStyle(Prism.textSecondary)
                Text("\(Int(memory * 100))%").font(Prism.display(10))
            }
            .lineLimit(1).minimumScaleFactor(0.6)
            .padding(.horizontal, 11)
        }
        .frame(width: 50, height: 50)
    }

    private func arc(_ fraction: Double, color: Color, width: CGFloat) -> some View {
        ZStack {
            Circle().stroke(Prism.border, lineWidth: width)
            Circle()
                .trim(from: 0, to: fraction)
                .stroke(color, style: StrokeStyle(lineWidth: width, lineCap: .round))
                .rotationEffect(.degrees(-90))
        }
    }
    func sidebarButton(_ title: String, icon: String, selected: Bool = false, prominent: Bool = false, shortTitle: String? = nil, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            if model.isSidebarCollapsed {
                // Only the icon gets a small pill, with its name below, so the narrow sidebar stays light.
                VStack(spacing: 5) {
                    // The filled plus square would draw a square inside the pill, so Create uses a plain plus here.
                    Image(systemName: prominent ? "plus" : icon).font(Prism.text(17, .medium))
                        .frame(width: 44, height: 30)
                        .foregroundStyle(prominent ? Prism.ink : (selected ? Prism.text : Prism.textSecondary))
                        .background(prominent ? Prism.action : (selected ? Prism.surface2 : .clear), in: Capsule())
                    Text(shortTitle ?? title).font(Prism.text(10, .medium)).lineLimit(1).minimumScaleFactor(0.8)
                        .foregroundStyle(selected || prominent ? Prism.text : Prism.textSecondary)
                }
                .frame(maxWidth: .infinity)
                .padding(.vertical, 2)
                .contentShape(Rectangle())
            } else {
                // The padding and fill sit inside the button, so the whole highlighted pill takes the click, not only the label.
                Label(title, systemImage: icon)
                    .font(prominent || selected ? Prism.text(14, .medium) : Prism.text(14))
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 12)
                    .padding(.vertical, prominent ? 13 : 10)
                    .foregroundStyle(prominent ? Prism.ink : Prism.text)
                    .background(prominent ? Prism.action : (selected ? Prism.surface2 : .clear), in: RoundedRectangle(cornerRadius: 8))
                    .contentShape(RoundedRectangle(cornerRadius: 8))
            }
        }
        .buttonStyle(.plain).pointerFeedback()
        .help(title)
        .accessibilityLabel(title)
        .accessibilityAddTraits(selected ? .isSelected : [])
    }
    var topbar: some View {
        HStack {
            Text(model.screen == .settings ? "Settings" : model.screen == .home ? "Home" : (model.screen == .create || model.screen == .importSource ? "Create Shorts" : (model.project?.displayTitle ?? "Editor"))).font(Prism.display(18))
            Spacer()
            if model.isBusy { ProgressView().controlSize(.small) }
            if model.isBusy && (model.screen == .editor || model.screen == .importSource) { Text(model.message).font(Prism.text(12)).foregroundStyle(Prism.textSecondary).lineLimit(1) }
            AppearanceSwitch(selection: $appearance).padding(.leading, 12)
        }.padding(20)
    }
    /// A downloaded update: small and calm, at the bottom, never over a popup. Restarting waits for exports and AI tasks.
    var updateBanner: some View {
        HStack(alignment: .top, spacing: 14) {
            Image(systemName: "arrow.down.circle.fill").font(Prism.text(18)).foregroundStyle(Prism.accent)
            VStack(alignment: .leading, spacing: 4) {
                Text("New version ready — Restart to update").font(Prism.text(13, .medium))
                if let version = updater.readyVersion {
                    Text("Prism \(version)").font(Prism.mono(11)).foregroundStyle(Prism.textSecondary)
                }
                ForEach(updater.releaseNotes, id: \.self) { line in
                    Text("• " + line).font(Prism.text(12)).foregroundStyle(Prism.textSecondary).lineLimit(1)
                }
                if model.isBusy {
                    Text("Available when the current export or AI task finishes.").font(Prism.text(11)).foregroundStyle(Prism.textSecondary)
                }
            }
            Spacer(minLength: 12)
            Button("Later") { updater.isBannerDismissed = true }.buttonStyle(.prismGhost)
            Button("Restart to update") { updater.restartToUpdate() }
                .buttonStyle(.prismPrimary).disabled(model.isBusy)
                .help(model.isBusy ? "Prism restarts once the export or AI task has finished" : "Install the update and reopen Prism")
        }
        .padding(16)
        .frame(maxWidth: 560)
        .background(Prism.surface1, in: RoundedRectangle(cornerRadius: 14))
        .overlay(RoundedRectangle(cornerRadius: 14).stroke(Prism.border))
        .shadow(color: .black.opacity(0.18), radius: 16, y: 6)
        .padding(.bottom, 24)
        .transition(.move(edge: .bottom).combined(with: .opacity))
        .accessibilityElement(children: .contain)
        .accessibilityLabel("New version ready")
    }

    /// The first launch after an update says what changed, in the same calm card.
    var updatedBanner: some View {
        HStack(alignment: .top, spacing: 14) {
            Image(systemName: "checkmark.circle.fill").font(Prism.text(18)).foregroundStyle(Prism.accent)
            VStack(alignment: .leading, spacing: 4) {
                Text("Updated to Prism \(updater.updatedVersion ?? updater.version)").font(Prism.text(13, .medium))
                if updater.updatedNotes.isEmpty {
                    Text("You're on the latest version.").font(Prism.text(12)).foregroundStyle(Prism.textSecondary)
                } else {
                    Text("What's new").font(Prism.text(11, .medium)).foregroundStyle(Prism.textSecondary).padding(.top, 2)
                    ForEach(updater.updatedNotes, id: \.self) { line in
                        Text("• " + line).font(Prism.text(12)).foregroundStyle(Prism.textSecondary).fixedSize(horizontal: false, vertical: true)
                    }
                }
            }
            Spacer(minLength: 12)
            Button("Got it") { withAnimation(.easeOut(duration: 0.2)) { updater.updatedVersion = nil } }
                .buttonStyle(.prismPrimary).keyboardShortcut(.defaultAction)
        }
        .padding(16)
        .frame(maxWidth: 560)
        .background(Prism.surface1, in: RoundedRectangle(cornerRadius: 14))
        .overlay(RoundedRectangle(cornerRadius: 14).stroke(Prism.border))
        .shadow(color: .black.opacity(0.18), radius: 16, y: 6)
        .padding(.bottom, 24)
        .transition(.move(edge: .bottom).combined(with: .opacity))
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Prism was updated")
    }

    var usageTileDetail: String {
        guard model.account.isSignedIn else { return "Sign in to see usage" }
        guard usageAccount == model.account.email, let usage = serverUsage else { return usageLoading ? "Checking usage…" : "Usage unavailable" }
        return "\(minutesText(usage.used)) of \(Int(usage.allowance)) min used"
    }

    func minutesText(_ value: Double) -> String { "\(Int(value.rounded(.down))) min" }

    /// The beta allowance: minutes used so far, what is left, and where a promo code goes.
    var usageSettings: some View {
        return VStack(alignment: .leading, spacing: 18) {
            Label("Usage", systemImage: "gauge.with.dots.needle.33percent").font(Prism.display(20))
            Text("Beta accounts get \(Int(UsageLimit.allowance)) minutes of video to make Shorts from. A video you already used doesn't count again. Need more? Ask me for a promo code, then enter it below.")
                .font(Prism.text(13)).foregroundStyle(Prism.textSecondary).fixedSize(horizontal: false, vertical: true)
            Divider()
            if let usage = serverUsage, model.account.isSignedIn, usageAccount == model.account.email {
                usageRow(used: usage.used, limit: usage.allowance)
            } else {
                Text(!model.account.isSignedIn ? "Sign in to see usage." : usageLoading ? "Checking usage…" : "Usage is unavailable. Check your connection and try again.")
                    .font(Prism.text(12)).foregroundStyle(Prism.textSecondary)
                if model.account.isSignedIn && !usageLoading {
                    Button("Retry") { Task { await refreshUsage() } }.buttonStyle(PrismButtonStyle(kind: .secondary))
                }
            }
            VStack(alignment: .leading, spacing: 8) {
                Text("Promo code").font(Prism.text(14, .medium))
                HStack(spacing: 10) {
                    TextField("Enter code", text: $promoCode)
                        .textFieldStyle(.roundedBorder).controlSize(.large)
                        .onSubmit { redeemPromo() }
                    Button("Redeem") { redeemPromo() }
                        .buttonStyle(PrismButtonStyle(kind: .primary))
                        .disabled(promoCode.trimmingCharacters(in: .whitespaces).isEmpty)
                }
                if !promoStatus.isEmpty {
                    Text(promoStatus).font(Prism.text(12)).foregroundStyle(Prism.textSecondary)
                }
            }
        }
        .padding(24)
        .background(Prism.surface1, in: RoundedRectangle(cornerRadius: 16))
    }

    func redeemPromo() {
        let code = promoCode
        Task {
            promoStatus = await model.account.redeemPromo(code)
            promoCode = ""
            await refreshUsage()
        }
    }

    @MainActor func refreshUsage() async {
        let accountEmail = model.account.email
        serverUsage = nil
        usageAccount = nil
        guard accountEmail != nil else { usageLoading = false; return }
        usageLoading = true
        let result = await model.account.usageStatus()
        guard !Task.isCancelled, model.account.email == accountEmail else { return }
        serverUsage = result
        usageAccount = accountEmail
        usageLoading = false
    }

    func usageRow(used: Double, limit: Double) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text("Used").font(Prism.text(14, .medium))
                Spacer()
                Text("\(minutesText(used)) of \(Int(limit)) min").font(Prism.mono(13)).foregroundStyle(used >= limit ? Prism.amber : Prism.textSecondary)
            }
            PrismProgressLine(value: min(1, used / limit))
            Text(used >= limit ? "All minutes used · ask for a promo code" : "\(minutesText(limit - used)) left")
                .font(Prism.text(12)).foregroundStyle(Prism.textSecondary)
        }
        .accessibilityElement(children: .combine)
    }

    var updateSettings: some View {
        VStack(alignment: .leading, spacing: 18) {
            Label("Updates", systemImage: "arrow.triangle.2.circlepath").font(Prism.display(20))
            Text("Prism checks for updates when it opens and every few hours, downloads them in the background and asks you to restart when one is ready. Every update is signed, and Prism refuses any it can't verify.")
                .font(Prism.text(13)).foregroundStyle(Prism.textSecondary).fixedSize(horizontal: false, vertical: true)
            Divider()
            HStack {
                VStack(alignment: .leading, spacing: 5) {
                    Text("Current version").font(Prism.text(14, .medium))
                    Text("Prism \(updater.version) (\(updater.build))").font(Prism.mono(13)).foregroundStyle(Prism.textSecondary).textSelection(.enabled)
                }
                Spacer()
                Button("Check for updates…") { updater.checkForUpdates() }
                    .disabled(!updater.isEnabled || model.isBusy)
            }
            updateStatus
            if let lastCheck = updater.lastCheck {
                Text("Last checked \(lastCheck.formatted(date: .abbreviated, time: .shortened))").font(Prism.text(12)).foregroundStyle(Prism.textSecondary)
            }
            if !updater.isEnabled {
                Label("Updates are off in this build. Install Prism from prismclips.app to get updates.", systemImage: "info.circle")
                    .font(Prism.text(12)).foregroundStyle(Prism.textSecondary).fixedSize(horizontal: false, vertical: true)
            }
            Divider()
            Text("What changed").font(Prism.text(14, .medium))
            if updater.history.isEmpty {
                Text("Versions you run will be listed here with their changes.").font(Prism.text(12)).foregroundStyle(Prism.textSecondary)
            }
            ForEach(updater.history.reversed()) { release in
                VStack(alignment: .leading, spacing: 4) {
                    Text(release.version == updater.version ? "Prism \(release.version) · current" : "Prism \(release.version)")
                        .font(Prism.text(13, .medium))
                    if release.notes.isEmpty {
                        Text("No notes were published for this version.").font(Prism.text(12)).foregroundStyle(Prism.textSecondary)
                    } else {
                        ForEach(release.notes, id: \.self) { line in
                            Text("• " + line).font(Prism.text(12)).foregroundStyle(Prism.textSecondary).fixedSize(horizontal: false, vertical: true)
                        }
                    }
                }
                .padding(.bottom, 4)
            }
            Divider()
        }
        .padding(24)
        .background(Prism.surface1, in: RoundedRectangle(cornerRadius: 16))
    }

    /// Whether an update is ready, found, or the last check came back clean.
    @ViewBuilder var updateStatus: some View {
        if let version = updater.readyVersion {
            VStack(alignment: .leading, spacing: 8) {
                Label("Prism \(version) is downloaded and ready.", systemImage: "arrow.down.circle.fill")
                    .font(Prism.text(13, .medium)).foregroundStyle(Prism.accent)
                ForEach(updater.releaseNotes, id: \.self) { line in
                    Text("• " + line).font(Prism.text(12)).foregroundStyle(Prism.textSecondary)
                }
                Button("Restart to update") { updater.restartToUpdate() }
                    .buttonStyle(.prismPrimary).disabled(model.isBusy)
                if model.isBusy {
                    Text("Available when the current export or AI task finishes.").font(Prism.text(11)).foregroundStyle(Prism.textSecondary)
                }
            }
        } else if let version = updater.availableVersion {
            VStack(alignment: .leading, spacing: 6) {
                Label("Prism \(version) is available. It is downloading.", systemImage: "arrow.down.circle")
                    .font(Prism.text(13, .medium)).foregroundStyle(Prism.accent)
                ForEach(updater.availableNotes, id: \.self) { line in
                    Text("• " + line).font(Prism.text(12)).foregroundStyle(Prism.textSecondary)
                }
            }
        } else if let result = updater.checkResult {
            Label(result, systemImage: "checkmark.circle")
                .font(Prism.text(13, .medium)).foregroundStyle(Prism.textSecondary)
        }
    }

    var accountSettings: some View {
        VStack(alignment: .leading, spacing: 18) {
            Label("Account", systemImage: "person.crop.circle").font(Prism.display(20))
            Text("Optional. When you're signed in, each export adds its date, number of Shorts, length and quality to your stats on the Prism website. Videos, transcripts and file names stay on your Mac.")
                .font(Prism.text(13)).foregroundStyle(Prism.textSecondary).fixedSize(horizontal: false, vertical: true)
            Divider()
            if let email = model.account.email {
                HStack(spacing: 10) {
                    Image(systemName: "checkmark.circle.fill").foregroundStyle(Prism.accent)
                    Text("Signed in as \(email)").font(Prism.text(13, .medium))
                    Spacer()
                }
                .padding(12)
                .background(Prism.surface1, in: RoundedRectangle(cornerRadius: 12))
                Button("Sign out", role: .destructive) { model.account.signOut() }
                    .buttonStyle(PrismButtonStyle(kind: .secondary, stretches: true))
                Button("See your stats in the browser") { NSWorkspace.shared.open(Account.statsPage) }
                    .buttonStyle(PrismButtonStyle(kind: .secondary, stretches: true))
                Button("Replay first-video tutorial") {
                    model.tutorial.restart(email: email)
                    model.screen = .home
                }
                .buttonStyle(PrismButtonStyle(kind: .secondary, stretches: true))
            } else {
                TextField("Email", text: $accountEmail).textFieldStyle(.roundedBorder).textContentType(.username).controlSize(.large)
                SecureField("Password (at least 6 characters)", text: $accountPassword).textFieldStyle(.roundedBorder).textContentType(.password).controlSize(.large)
                HStack(spacing: 10) {
                    Button("Sign in") { Task { await model.account.signIn(email: accountEmail, password: accountPassword); if model.account.isSignedIn { accountPassword = "" } } }
                        .buttonStyle(PrismButtonStyle(kind: .primary, stretches: true))
                    Button("Create account") { Task { await model.account.signUp(email: accountEmail, password: accountPassword); accountPassword = "" } }
                        .buttonStyle(PrismButtonStyle(kind: .secondary, stretches: true))
                }
                .disabled(model.account.isWorking || accountEmail.isEmpty || accountPassword.isEmpty)
            }
            if !model.account.status.isEmpty {
                Text(model.account.status).font(Prism.text(12)).foregroundStyle(Prism.textSecondary)
            }
        }
    }

    var settingsPage: some View {
        VStack(alignment: .leading, spacing: 20) {
            VStack(alignment: .leading, spacing: 6) {
                Text("Settings").font(Prism.display(32))
                Text("Choose a category to configure Prism.")
                    .foregroundStyle(Prism.textSecondary)
            }
            HStack(spacing: 14) {
                SettingsCategoryTile(title: "Account", detail: model.account.email ?? "Sign in to track your stats", icon: "person.crop.circle", isSelected: selectedSettingsCategory == .account) {
                    withAnimation(.easeInOut(duration: 0.2)) { selectedSettingsCategory = .account }
                }
                SettingsCategoryTile(title: "Usage", detail: usageTileDetail, icon: "gauge.with.dots.needle.33percent", isSelected: selectedSettingsCategory == .usage) {
                    withAnimation(.easeInOut(duration: 0.2)) { selectedSettingsCategory = .usage }
                }
                SettingsCategoryTile(title: "System resources", detail: "RAM and storage updates", icon: "chart.bar.xaxis", isSelected: selectedSettingsCategory == .systemResources) {
                    withAnimation(.easeInOut(duration: 0.2)) { selectedSettingsCategory = .systemResources }
                }
                SettingsCategoryTile(title: "Updates", detail: "Prism \(updater.version)", icon: "arrow.triangle.2.circlepath", isSelected: selectedSettingsCategory == .updates) {
                    withAnimation(.easeInOut(duration: 0.2)) { selectedSettingsCategory = .updates }
                }
            }
            ScrollView {
                Group {
                    if selectedSettingsCategory == .account {
                        accountSettings
                    } else if selectedSettingsCategory == .updates {
                        updateSettings
                    } else if selectedSettingsCategory == .usage {
                        usageSettings
                    } else {
                        TimelineView(.periodic(from: .now, by: min(3_600, max(1, resourceRefreshSeconds)))) { _ in
                            let machine = MachineProfile.detect()
                            VStack(alignment: .leading, spacing: 20) {
                                VStack(alignment: .leading, spacing: 8) {
                                    Label("System resources", systemImage: "chart.bar.xaxis").font(Prism.display(20))
                                    Text("Monitor this Mac and choose how often the sidebar refreshes.")
                                        .font(Prism.text(13)).foregroundStyle(Prism.textSecondary)
                                }
                                HStack(spacing: 14) {
                                    resourceSummary(title: "Memory used", value: "\(String(format: "%.1f", machine.memoryUsedGB)) / \(machine.memoryGB) GB", fraction: machine.memoryUsage, tint: .purple)
                                    resourceSummary(title: "Storage available", value: "\(machine.freeGB) / \(machine.storageGB) GB", fraction: machine.freeStorageRatio, tint: Color(red: 0.12, green: 0.78, blue: 0.90))
                                }
                                Divider()
                                HStack(alignment: .center, spacing: 18) {
                                    VStack(alignment: .leading, spacing: 5) {
                                        Text("Sidebar update frequency").font(Prism.text(14, .medium))
                                        Text("Choose from 1 second to 60 minutes.").font(Prism.text(12)).foregroundStyle(Prism.textSecondary)
                                    }
                                    Spacer(minLength: 8)
                                    Picker("Refresh interval", selection: $resourceRefreshSeconds) {
                                        ForEach(resourceRefreshOptions) { option in
                                            Text(option.title).tag(option.seconds)
                                        }
                                    }
                                    .pickerStyle(.menu)
                                    .accessibilityLabel("System resource refresh interval")
                                }
                            }
                            .padding(24)
                            .background(Prism.surface1, in: RoundedRectangle(cornerRadius: 16))
                        }
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        }
        .padding(32)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .onAppear {
            if model.opensUsageSettings { selectedSettingsCategory = .usage; model.opensUsageSettings = false }
            if model.opensAccountSettings { selectedSettingsCategory = .account; model.opensAccountSettings = false }
        }
        .task(id: "\(model.account.email ?? "")|\(model.usageRevision)") { await refreshUsage() }
    }

    private func resourceSummary(title: String, value: String, fraction: Double, tint: Color) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(title).font(Prism.text(13)).foregroundStyle(Prism.textSecondary)
            Text(value).font(Prism.display(20))
            GeometryReader { geometry in
                ZStack(alignment: .leading) {
                    Capsule().fill(Prism.surface2)
                    Capsule().fill(tint).frame(width: geometry.size.width * min(1, max(0, fraction)))
                }
            }
            .frame(height: 7)
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Prism.surface1, in: RoundedRectangle(cornerRadius: 12))
    }

    private var resourceRefreshLabel: String {
        resourceRefreshOptions.first(where: { $0.seconds == resourceRefreshSeconds })?.title ?? "1 minute"
    }

    var dashboard: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 30) {
                HStack(spacing: 14) {
                    Button { model.startLongVideoToShort() } label: {
                        HStack(spacing: 20) {
                            Image(systemName: "plus.square.fill").font(Prism.text(29, .medium))
                            VStack(alignment: .leading, spacing: 5) {
                                Text("Start creating").font(Prism.display(22))
                                Text("One in. Many out. Choose a video and Prism finds the moments worth sharing.")
                                    .font(Prism.text(13, .medium)).opacity(0.82)
                            }
                            Spacer(minLength: 12)
                            Image(systemName: "arrow.up.right").font(Prism.text(18, .medium))
                        }
                        .padding(.horizontal, 24)
                        .frame(maxWidth: .infinity, minHeight: 104)
                        .contentShape(RoundedRectangle(cornerRadius: 16))
                    }
                    .buttonStyle(.plain)
                    .foregroundStyle(Prism.ink)
                    .background(Prism.action, in: RoundedRectangle(cornerRadius: 16))
                    .pointerFeedback()
                    .help("Start creating · ⌘N")
                    .tutorialTarget(.start)
                }

                // Uploads that never got Shorts are kept but tucked away; until counts load, every project shows.
                let openFolder = model.projectFolders.first { $0.id == openFolderID }
                let foldered = Set(model.projectFolders.flatMap(\.projectPaths))
                let shown = openFolder.map { folder in model.recentProjectPaths.filter { folder.projectPaths.contains($0) } }
                    ?? model.recentProjectPaths.filter { !foldered.contains($0) }
                let finished = shown.filter { (projectShortCounts[$0] ?? 1) > 0 }
                HStack(alignment: .firstTextBaseline) {
                    if let openFolder {
                        Button { openFolderID = nil } label: { Label("Projects", systemImage: "chevron.left") }
                            .buttonStyle(.prismGhost).keyboardShortcut(.cancelAction)
                            .dropDestination(for: String.self) { paths, _ in
                                paths.forEach { model.moveProject($0, toFolder: nil) }; return !paths.isEmpty
                            }
                            .help("Back to all projects · drop a project here to take it out of the folder")
                        Text(openFolder.name).font(Prism.display(22))
                    } else {
                        Text("Projects").font(Prism.display(22))
                    }
                    Spacer()
                    if openFolder == nil {
                        Button { folderNameText = ""; folderNamePrompt = FolderNamePrompt() } label: {
                            Label("New folder", systemImage: "folder.badge.plus")
                        }
                        .buttonStyle(.prismGhost)
                        .help("Make a folder and drag projects into it")
                    }
                }
                if openFolder == nil && !model.projectFolders.isEmpty {
                    folderGrid
                }
                if let openFolder, shown.isEmpty {
                    VStack(spacing: 10) {
                        Image(systemName: "folder").font(Prism.text(34)).foregroundStyle(Prism.textSecondary)
                        Text("\(openFolder.name) is empty").font(Prism.text(14, .medium))
                        Text("Go back to Projects and drag a project onto this folder, or right-click a project › Move to folder.")
                            .foregroundStyle(Prism.textSecondary).multilineTextAlignment(.center)
                    }.frame(maxWidth: .infinity).padding(48).background(Prism.surface1, in: RoundedRectangle(cornerRadius: 16))
                } else if model.recentProjectPaths.isEmpty {
                    VStack(spacing: 10) {
                        Image(systemName: "rectangle.stack").font(Prism.text(34)).foregroundStyle(Prism.textSecondary)
                        Text("Your projects will appear here").font(Prism.text(14, .medium))
                        Text("Create a Short to start your first project.").foregroundStyle(Prism.textSecondary)
                    }.frame(maxWidth: .infinity).padding(48).background(Prism.surface1, in: RoundedRectangle(cornerRadius: 16))
                } else {
                    // Newest first; two rows keep Home calm, the rest are one click away.
                    let visible = showAllProjects ? finished : Array(finished.prefix(12))
                    projectGrid(visible)
                    if finished.count > 12 {
                        // Outlined with a chevron so it reads as "more below", not as a heading.
                        Button { showAllProjects.toggle() } label: {
                            HStack(spacing: 6) {
                                Text(showAllProjects ? "Show fewer" : "Show all \(finished.count) projects")
                                Image(systemName: showAllProjects ? "chevron.up" : "chevron.down").font(Prism.text(11, .medium))
                            }
                        }
                            .buttonStyle(.prismSecondary)
                    }
                }
            }.padding(24).frame(maxWidth: 1800, alignment: .leading).frame(maxWidth: .infinity)
        }
        // A video dropped from Finder anywhere on Home starts a new Shorts project with it.
        .dropDestination(for: URL.self) { urls, _ in
            guard let url = urls.first, url.isFileURL, AppModel.importableExtensions.contains(url.pathExtension.lowercased()), !model.isBusy else { return false }
            model.startLongVideoToShort()
            model.importSource(url)
            return true
        } isTargeted: { isHomeDropTarget = $0 }
        .overlay {
            if isHomeDropTarget {
                VStack(spacing: 12) {
                    Image(systemName: "arrow.down.circle.fill").font(Prism.text(44))
                    Text("Drop to create Shorts").font(Prism.display(22))
                    Text("MOV, MP4, M4V or AVI").font(Prism.text(12)).foregroundStyle(Prism.textSecondary)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .background(Prism.accent.opacity(0.10), in: RoundedRectangle(cornerRadius: 16))
                .overlay(RoundedRectangle(cornerRadius: 16).stroke(style: StrokeStyle(lineWidth: 2, dash: [10, 8])).foregroundStyle(Prism.accent))
                .padding(16)
                .allowsHitTesting(false)
            }
        }
        .task(id: model.recentProjectPaths + ["\(model.projectListRevision)"]) { projectShortCounts = await Self.shortCounts(model.recentProjectPaths) }
        .alert(folderNamePrompt?.folderID == nil ? "New folder" : "Rename folder",
               isPresented: Binding(get: { folderNamePrompt != nil }, set: { if !$0 { folderNamePrompt = nil } })) {
            TextField("Folder name", text: $folderNameText)
            Button(folderNamePrompt?.folderID == nil ? "Create" : "Rename") {
                if let prompt = folderNamePrompt {
                    if let id = prompt.folderID { model.renameFolder(id, to: folderNameText) }
                    else if let id = model.createFolder(named: folderNameText), let path = prompt.movingProject {
                        model.moveProject(path, toFolder: id)
                    }
                }
                folderNamePrompt = nil
            }
            .disabled(folderNameText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            Button("Cancel", role: .cancel) { folderNamePrompt = nil }
        }
        .alert("Rename project", isPresented: Binding(get: { renameProjectPath != nil }, set: { if !$0 { renameProjectPath = nil } })) {
            TextField("Project name", text: $renameText)
            Button("Rename") {
                if let path = renameProjectPath { model.renameProject(at: path, to: renameText) }
                renameProjectPath = nil
            }
            .disabled(renameText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            Button("Cancel", role: .cancel) { renameProjectPath = nil }
        }
        .confirmationDialog("Move this project to the Trash?", isPresented: Binding(get: { deleteProjectPath != nil }, set: { if !$0 { deleteProjectPath = nil } }), titleVisibility: .visible) {
            Button("Move to Trash", role: .destructive) {
                if let path = deleteProjectPath { model.deleteProject(at: path) }
                deleteProjectPath = nil
            }
            Button("Cancel", role: .cancel) { deleteProjectPath = nil }
        } message: {
            Text("Its Shorts, exports and imported video go to the Trash. You can restore the project from there.")
        }
        .sheet(item: $statsProject) { project in ProjectStatsView(path: project.path) }
    }
    var folderGrid: some View {
        LazyVGrid(columns: [GridItem(.adaptive(minimum: 160, maximum: 220), spacing: 12)], alignment: .leading, spacing: 14) {
            ForEach(model.projectFolders) { folder in
                let count = folder.projectPaths.filter { model.recentProjectPaths.contains($0) }.count
                let targeted = dropTargetFolder == folder.id
                Button { openFolderID = folder.id } label: {
                    HStack(spacing: 12) {
                        Image(systemName: targeted ? "folder.fill.badge.plus" : "folder.fill")
                            .font(Prism.text(26)).foregroundStyle(Prism.accent)
                        VStack(alignment: .leading, spacing: 3) {
                            Text(folder.name).font(Prism.text(13, .medium)).lineLimit(1)
                            Text(count == 1 ? "1 project" : "\(count) projects").font(Prism.text(11)).foregroundStyle(Prism.textSecondary)
                        }
                        Spacer(minLength: 0)
                    }
                    .padding(14)
                    .frame(maxWidth: .infinity, minHeight: 64, alignment: .leading)
                    .background(targeted ? Prism.accent.opacity(0.14) : Prism.surface1, in: RoundedRectangle(cornerRadius: 12))
                    .overlay(RoundedRectangle(cornerRadius: 12).stroke(targeted ? Prism.accent : .clear, lineWidth: 2))
                    .contentShape(RoundedRectangle(cornerRadius: 12))
                }
                .buttonStyle(.plain).pointerFeedback()
                .dropDestination(for: String.self) { paths, _ in
                    paths.forEach { model.moveProject($0, toFolder: folder.id) }
                    return !paths.isEmpty
                } isTargeted: { dropTargetFolder = $0 ? folder.id : (dropTargetFolder == folder.id ? nil : dropTargetFolder) }
                .contextMenu {
                    Button { folderNameText = folder.name; folderNamePrompt = FolderNamePrompt(folderID: folder.id) } label: { Label("Rename…", systemImage: "pencil") }
                    Divider()
                    Button(role: .destructive) { model.deleteFolder(folder.id) } label: { Label("Delete folder (keeps projects)", systemImage: "folder.badge.minus") }
                }
                .accessibilityLabel("Folder \(folder.name), \(count) projects")
                .help("Open folder · drop projects here")
            }
        }
    }
    func beginRename(_ path: String) {
        let stored = try? ProjectStore(root: URL(fileURLWithPath: path), create: false).load(ProjectData.self, key: "project")
        renameText = stored?.displayTitle ?? ProjectData.folderTitle(URL(fileURLWithPath: path))
        renameProjectPath = path
    }
    func projectGrid(_ paths: [String]) -> some View {
        LazyVGrid(columns: [GridItem(.adaptive(minimum: 160, maximum: 220), spacing: 12)], alignment: .leading, spacing: 14) {
            ForEach(paths, id: \.self) { path in
                RecentProjectCard(path: path, revision: model.projectListRevision) { model.open(URL(fileURLWithPath: path)) }
                    .draggable(path)
                    .contextMenu {
                        Button { beginRename(path) } label: { Label("Rename…", systemImage: "pencil") }
                        Menu {
                            ForEach(model.projectFolders.filter { !$0.projectPaths.contains(path) }) { folder in
                                Button(folder.name) { model.moveProject(path, toFolder: folder.id) }
                            }
                            if !model.projectFolders.isEmpty { Divider() }
                            Button("New folder…") { folderNameText = ""; folderNamePrompt = FolderNamePrompt(movingProject: path) }
                        } label: { Label("Move to folder", systemImage: "folder") }
                        if model.projectFolders.contains(where: { $0.projectPaths.contains(path) }) {
                            Button { model.moveProject(path, toFolder: nil) } label: { Label("Remove from folder", systemImage: "folder.badge.minus") }
                        }
                        Button { statsProject = ProjectPath(path: path) } label: { Label("Show stats", systemImage: "chart.bar") }
                        Divider()
                        Button(role: .destructive) { deleteProjectPath = path } label: { Label("Move to Trash", systemImage: "trash") }
                    }
            }
        }
    }
    /// How many Shorts each project has, read off the main thread.
    nonisolated static func shortCounts(_ paths: [String]) async -> [String: Int] {
        await Task.detached(priority: .utility) {
            var counts: [String: Int] = [:]
            for path in paths {
                guard let store = try? ProjectStore(root: URL(fileURLWithPath: path), create: false),
                      let project = try? store.load(ProjectData.self, key: "project") else { continue }
                counts[path] = project.segments.count
            }
            return counts
        }.value
    }
    var creationModes: some View {
        VStack(alignment: .leading, spacing: 28) {
            VStack(alignment: .leading, spacing: 8) {
                Text("What do you want Prism to create?").font(Prism.display(36))
                Text("Choose a starting point. Your media stays inside your Prism library.").font(Prism.text(16)).foregroundStyle(Prism.textSecondary)
            }
            HStack(spacing: 18) {
                creationCard(
                    icon: "rectangle.portrait.and.arrow.forward",
                    eyebrow: "Long → short",
                    title: "Long video into a Short",
                    detail: "Find a strong moment, crop it vertically, add captions, and export.",
                    action: { model.startLongVideoToShort() }
                )
                creationCard(
                    icon: "photo.on.rectangle.angled",
                    eyebrow: "Video + photos → short",
                    title: "Photos and videos into a Short",
                    detail: "Turn a collection of moments into a polished short-form story.",
                    comingSoon: true,
                    action: {}
                )
                creationCard(
                    icon: "rectangle.stack.badge.play",
                    eyebrow: "Video + photos → long",
                    title: "Photos and videos into a long video",
                    detail: "Build a longer story from your clips, photos, audio, and music.",
                    comingSoon: true,
                    action: {}
                )
            }
            Spacer()
            Button { model.screen = .home } label: { Label("Back to Home", systemImage: "chevron.left") }
                .buttonStyle(.prismLink).pointerFeedback().foregroundStyle(Prism.textSecondary)
        }
        .padding(38)
        .frame(maxWidth: 1200, maxHeight: .infinity, alignment: .topLeading)
        .frame(maxWidth: .infinity)
    }
    var sourceImport: some View {
        ScrollView {
            VStack(spacing: 20) {
                VStack(spacing: 8) {
                    Text(model.shortsSource == nil ? "Step 1 of 5 · Choose video"
                         : choosingType ? "Step 4 of 5 · Choose content type"
                         : choosingCaptions ? "Step 3 of 5 · Choose captions" : "Step 2 of 5 · Set up Shorts")
                        .font(Prism.text(12, .medium)).foregroundStyle(Prism.textSecondary)
                    Text(model.shortsSource == nil ? "Add your long video"
                         : choosingType ? "What kind of video is it?"
                         : choosingCaptions ? "Choose your captions" : "Choose your Short settings")
                        .font(Prism.display(36))
                    Text(model.shortsSource == nil ? "Upload a video first. Then choose clip lengths and which part to analyze."
                         : choosingType ? "This tells Prism what to look for, how to lay out each Short and which captions Auto picks."
                         : choosingCaptions ? "Pick how speech appears on your Shorts. You can change it for each Short in the editor."
                         : "Your video is ready. Choose how to turn it into Shorts.")
                        .font(Prism.text(16)).foregroundStyle(Prism.textSecondary)
                }
                if let video = model.shortsSource, choosingType {
                    VStack(spacing: 20) {
                        typeChoice
                        HStack {
                            Button { choosingType = false } label: { Label("Back to captions", systemImage: "chevron.left") }
                                .controlSize(.large).pointerFeedback().keyboardShortcut(.cancelAction)
                            Spacer()
                            Button("Analyze and create Shorts") { model.continueImport() }
                                .buttonStyle(.prismPrimary).pointerFeedback().keyboardShortcut(.defaultAction)
                                .disabled(model.isBusy || model.customRangeError != nil)
                        }
                        .accessibilityElement(children: .contain)
                        .accessibilityLabel("Content type for \(video.name)")
                    }
                    .tutorialTarget(.contentType)
                } else if let video = model.shortsSource, choosingCaptions {
                    VStack(spacing: 20) {
                        captionChoice
                        HStack {
                            Button { choosingCaptions = false } label: { Label("Back to settings", systemImage: "chevron.left") }
                                .controlSize(.large).pointerFeedback().keyboardShortcut(.cancelAction)
                            Spacer()
                            Button { choosingType = true } label: { Label("Next: Choose content type", systemImage: "chevron.right") }
                                .buttonStyle(.prismPrimary).pointerFeedback().keyboardShortcut(.defaultAction)
                                .disabled(model.isBusy || model.customRangeError != nil)
                        }
                        .accessibilityElement(children: .contain)
                        .accessibilityLabel("Captions for \(video.name)")
                    }
                    .tutorialTarget(.captions)
                } else if let video = model.shortsSource {
                    VStack(alignment: .leading, spacing: 10) {
                        Label(video.name, systemImage: "checkmark.circle.fill").foregroundStyle(Prism.accent)
                        Text("Video duration: \(clock(video.duration)) · \(String(format: "%.2f", video.duration / 60)) minutes")
                            .foregroundStyle(Prism.textSecondary)
                        Button("Choose a different video") { model.importVideo() }.pointerFeedback()
                    }
                    .frame(maxWidth: .infinity, alignment: .leading).padding(18)
                    .background(Prism.surface1, in: RoundedRectangle(cornerRadius: 16))
                    VStack(spacing: 20) {
                        shortsConfiguration
                        Button { choosingCaptions = true } label: { Label("Next: Choose captions", systemImage: "chevron.right") }
                            .buttonStyle(.prismPrimary).pointerFeedback().keyboardShortcut(.defaultAction)
                            .disabled(model.isBusy || model.customRangeError != nil)
                    }
                    .tutorialTarget(.settings)
                } else {
                    videoUploadControls
                        .tutorialTarget(.upload)
                }
                Button { model.screen = .home } label: { Label("Back to Home", systemImage: "chevron.left") }
                    .buttonStyle(.prismLink).pointerFeedback().foregroundStyle(Prism.textSecondary).frame(maxWidth: .infinity, alignment: .leading)
            }
            .disabled(model.isBusy)
            .padding(30).frame(maxWidth: 920, alignment: .top).frame(maxWidth: .infinity)
        }
        .tutorialTarget(.sourceViewport)
        .onAppear {
            choosingCaptions = false
            choosingType = false
            if model.customEndMinutes.isEmpty, let video = model.shortsSource { model.resetSourceRange(for: video) }
        }
        .onChange(of: model.selection) { _, _ in
            choosingCaptions = false
            choosingType = false
            if let video = model.shortsSource { model.resetSourceRange(for: video) }
        }
    }
    var shortsConfiguration: some View {
            VStack(alignment: .leading, spacing: 12) {
                Text("Shorts settings").font(Prism.text(12, .medium)).foregroundStyle(Prism.textSecondary)
                HStack(alignment: .top, spacing: 18) {
                    VStack(alignment: .leading, spacing: 7) {
                        Label("How many", systemImage: "square.stack.3d.up")
                            .font(Prism.text(12)).foregroundStyle(Prism.textSecondary)
                        Toggle("Auto", isOn: $model.isShortCountAuto)
                            .font(Prism.text(13, .medium))
                            .help("Prism AI finds every strong moment, up to one Short per minute of video and 20 in all")
                        if !model.isShortCountAuto {
                            Stepper("\(model.shortCount) Shorts", value: $model.shortCount, in: 1...ShortMaker.maxShorts)
                                .font(Prism.text(13, .medium))
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    VStack(alignment: .leading, spacing: 7) {
                        Label("Approx. length", systemImage: "clock")
                            .font(Prism.text(12)).foregroundStyle(Prism.textSecondary)
                        Picker("Approximate Short length", selection: $model.shortDuration) {
                            Text("Auto").tag(0.0)
                            ForEach([15.0, 30.0, 45.0, 60.0], id: \.self) { seconds in
                                Text("\(Int(seconds)) seconds").tag(seconds)
                            }
                        }
                        .labelsHidden().pickerStyle(.menu)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    VStack(alignment: .leading, spacing: 7) {
                        Label("Take clips from", systemImage: "timeline.selection")
                            .font(Prism.text(12)).foregroundStyle(Prism.textSecondary)
                        Picker("Choose video section", selection: $model.shortSourceRegion) {
                            ForEach(ShortMaker.SourceRegion.allCases) { region in
                                Text(region.title).tag(region)
                            }
                        }
                        .labelsHidden().pickerStyle(.menu)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
                if model.shortSourceRegion == .custom {
                    customRangeFields
                }
                Text("Prism analyzes the speech and frames of the \(model.shortSourceRegion.title.lowercased()) and suggests \(model.isShortCountAuto ? "every strong moment it finds, up to \(ShortMaker.maxShorts)" : model.shortCount == 1 ? "1 moment" : "up to \(model.shortCount) moments"), \(model.shortDuration > 0 ? "about \(Int(model.shortDuration)) seconds each" : "each 15–60 seconds, as long as its story needs"). Shorts never overlap. Review every pick before exporting.")
                    .font(Prism.text(12)).foregroundStyle(Prism.textSecondary)
                // A vertical crop enlarges a small source several times, so a 360p video looks blurry however it is exported.
                if let video = model.shortsSource, video.width > 0, video.height > 0, min(video.width, video.height) < 720 {
                    Label("This video is \(min(video.width, video.height))p, so Shorts made from it will look blurry. For sharp Shorts, use a 1080p copy of the video.",
                          systemImage: "exclamationmark.triangle")
                        .font(Prism.text(12)).foregroundStyle(Prism.amber).fixedSize(horizontal: false, vertical: true)
                }
                // What this run costs, before it starts: a video counts once, the first time Shorts are made from it.
                if let video = model.shortsSource, let usage = serverUsage {
                    let left = max(0, usage.allowance - usage.used)
                    Label("This video counts as \(minutesText(UsageLimit.minutes(of: video))) of your beta minutes the first time you use it. \(minutesText(left)) left of \(Int(usage.allowance)).",
                          systemImage: "gauge.with.dots.needle.33percent")
                        .font(Prism.text(12)).foregroundStyle(UsageLimit.minutes(of: video) > left ? Prism.amber : Prism.textSecondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            .task(id: model.account.email) { await refreshUsage() }
            .padding(18)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Prism.surface1, in: RoundedRectangle(cornerRadius: 16))

    }
    var typeChoice: some View {
        LazyVGrid(columns: [GridItem(.adaptive(minimum: 240), spacing: 14)], alignment: .leading, spacing: 14) {
            ForEach(VideoType.allCases) { type in
                let selected = model.shortVideoType == type
                Button { model.shortVideoType = type } label: {
                    VStack(alignment: .leading, spacing: 10) {
                        HStack {
                            Image(systemName: type.icon).font(Prism.text(20)).foregroundStyle(selected ? Prism.accent : Prism.textSecondary)
                            Spacer()
                            Image(systemName: selected ? "checkmark.circle.fill" : "circle")
                                .foregroundStyle(selected ? Prism.accent : Prism.textSecondary)
                        }
                        Text(type.title).font(Prism.text(14, .medium))
                        Text(type.detail).font(Prism.text(12)).foregroundStyle(Prism.textSecondary).lineLimit(3, reservesSpace: true)
                    }
                    .padding(16)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(selected ? Prism.surface2 : Prism.surface1, in: RoundedRectangle(cornerRadius: 16))
                    .overlay(RoundedRectangle(cornerRadius: 16).stroke(selected ? Color.accentColor : .clear, lineWidth: 2))
                    .contentShape(RoundedRectangle(cornerRadius: 16))
                }
                .buttonStyle(.plain).pointerFeedback()
                .accessibilityAddTraits(selected ? .isSelected : [])
            }
        }
    }
    var captionChoice: some View {
        VStack(alignment: .leading, spacing: 12) {
            LazyVGrid(columns: [GridItem(.adaptive(minimum: 190), spacing: 14)], alignment: .leading, spacing: 14) {
                ForEach(CaptionStyle.allCases) { style in
                    captionCard(style, title: style.title, detail: style.detail)
                }
            }
            if model.shortCaptionStyle.usesWordTiming {
                Text("This style follows each spoken word. Prism AI times the words of every Short after it is made.")
                    .font(Prism.text(12)).foregroundStyle(Prism.textSecondary)
            }
        }
    }
    func captionCard(_ style: CaptionStyle, title: String, detail: String) -> some View {
        let selected = model.shortCaptionStyle == style
        return Button { model.shortCaptionStyle = style } label: {
            VStack(alignment: .leading, spacing: 12) {
                CaptionStylePreview(style: style)
                    .padding(.horizontal, 10)
                    .frame(maxWidth: .infinity).frame(height: 84)
                    .background(Color(white: 0.28), in: RoundedRectangle(cornerRadius: 12))
                Label(title, systemImage: selected ? "checkmark.circle.fill" : "circle").font(Prism.text(14, .medium))
                // Two lines for every card, so cards in a row line up.
                Text(detail).font(Prism.text(12)).foregroundStyle(Prism.textSecondary).lineLimit(2, reservesSpace: true)
            }
            .padding(16)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(selected ? Prism.surface2 : Prism.surface1, in: RoundedRectangle(cornerRadius: 16))
            .overlay(RoundedRectangle(cornerRadius: 16).stroke(selected ? Color.accentColor : .clear, lineWidth: 2))
            .contentShape(RoundedRectangle(cornerRadius: 16))
        }
        .buttonStyle(.plain).pointerFeedback()
        .accessibilityAddTraits(selected ? .isSelected : [])
    }
    var customRangeFields: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                VStack(alignment: .leading) {
                    Text("Start (minutes)").font(Prism.text(12)).foregroundStyle(Prism.textSecondary)
                    TextField("Start in minutes", text: $model.customStartMinutes).textFieldStyle(.roundedBorder)
                }
                VStack(alignment: .leading) {
                    Text("End (minutes)").font(Prism.text(12)).foregroundStyle(Prism.textSecondary)
                    TextField("End in minutes", text: $model.customEndMinutes).textFieldStyle(.roundedBorder)
                }
            }
            if let error = model.customRangeError {
                Label(error, systemImage: "exclamationmark.circle").font(Prism.text(12)).foregroundStyle(Prism.amber)
            } else if let video = model.shortsSource,
                      let range = try? model.shortSourceRegion.interval(videoDuration: video.duration,
                          customStart: model.minuteSeconds(model.customStartMinutes), customEnd: model.minuteSeconds(model.customEndMinutes)) {
                Text("Analyze \(clock(range.start)) to \(clock(range.end)) · \(clock(range.end - range.start)) selected")
                    .font(Prism.text(12)).foregroundStyle(Prism.textSecondary)
            }
        }
    }
    var videoUploadControls: some View {
        VStack(spacing: 20) {
            VStack(spacing: 18) {
                Image(systemName: isDropTarget ? "arrow.down.circle.fill" : "arrow.down.doc.fill")
                    .font(Prism.text(58)).foregroundStyle(Prism.text)
                Text(isDropTarget ? "Drop to import" : "Drag and drop your video here").font(Prism.display(20))
                Text("MOV, MP4, M4V, or AVI").font(Prism.text(12)).foregroundStyle(Prism.textSecondary)
                Button("Browse files") { model.importVideo() }.buttonStyle(.prismPrimary).pointerFeedback()
            }
            .frame(maxWidth: .infinity, minHeight: 270)
            .background(isDropTarget ? Prism.accent.opacity(0.12) : Prism.surface1, in: RoundedRectangle(cornerRadius: 16))
            .overlay(RoundedRectangle(cornerRadius: 16).stroke(style: StrokeStyle(lineWidth: 2, dash: [10, 8])).foregroundStyle(isDropTarget ? Prism.accent : Prism.border))
            .dropDestination(for: URL.self, action: { urls, _ in
                guard let url = urls.first else { return false }
                model.importSource(url)
                return true
            }, isTargeted: { isDropTarget = $0 })
            VStack(alignment: .leading, spacing: 6) {
                Text("Or paste a file path").font(Prism.text(12, .medium)).foregroundStyle(Prism.textSecondary)
                HStack(spacing: 10) {
                    TextField("Video file path", text: $model.sourcePath, prompt: Text("/Users/you/Movies/my-video.mp4").foregroundStyle(Prism.textSecondary))
                        .textFieldStyle(.plain).font(Prism.mono(13)).padding(13)
                        .background(Prism.surface2, in: RoundedRectangle(cornerRadius: 12))
                        .onSubmit { model.importFromPath() }
                    Button("Import path") { model.importFromPath() }
                        .buttonStyle(.prismPrimary)
                        .pointerFeedback()
                        .disabled(model.sourcePath.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
                Text("Prism copies the selected video into your private Prism library.").font(Prism.text(12)).foregroundStyle(Prism.textSecondary)
            }

        }
    }
    func creationCard(icon: String, eyebrow: String, title: String, detail: String, comingSoon: Bool = false, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            VStack(alignment: .leading, spacing: 18) {
                HStack {
                    Image(systemName: icon).font(Prism.text(32)).foregroundStyle(Prism.text)
                    Spacer()
                    if comingSoon {
                        Text("Coming soon").font(Prism.text(11, .medium)).padding(.horizontal, 9).padding(.vertical, 5)
                            .background(Prism.surface2, in: Capsule()).foregroundStyle(Prism.textSecondary)
                    } else {
                        Image(systemName: "arrow.up.right").foregroundStyle(Prism.textSecondary)
                    }
                }
                Spacer()
                Text(eyebrow).font(Prism.text(12, .medium)).foregroundStyle(Prism.textSecondary)
                Text(title).font(Prism.display(24)).multilineTextAlignment(.leading)
                Text(detail).font(Prism.text(13)).foregroundStyle(Prism.textSecondary).multilineTextAlignment(.leading).fixedSize(horizontal: false, vertical: true)
            }
            .padding(24)
            .frame(maxWidth: .infinity, minHeight: 330, alignment: .leading)
            .background(
                Prism.surface1,
                in: RoundedRectangle(cornerRadius: 16)
            )
            .overlay(RoundedRectangle(cornerRadius: 16).stroke(Prism.border, lineWidth: 1))
            .opacity(comingSoon ? 0.72 : 1)
        }
        .buttonStyle(.plain).pointerFeedback()
        .disabled(comingSoon)
    }
    var selectedMedia: MediaItem? { model.project?.media.first(where: { $0.id == model.selection }) }

    func clock(_ seconds: Double) -> String { String(format: "%02d:%02d", Int(seconds) / 60, Int(seconds) % 60) }
}

private struct ProjectPath: Identifiable {
    let path: String
    var id: String { path }
}

private struct ProjectStats: Sendable {
    var title: String
    var created: Date
    var shortCount: Int
    var shortsSeconds: Double
    var exportCount: Int
    var sourceName: String?
    var sourceSeconds: Double?
    var resolution: String?
    var bytes: Int64
}

/// Read-only facts about one project, opened from its right-click menu on Home.
private struct ProjectStatsView: View {
    let path: String
    @Environment(\.dismiss) private var dismiss
    @State private var stats: ProjectStats?
    @State private var failed = false

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            if let stats {
                Text(stats.title).font(Prism.display(20)).lineLimit(2)
                Grid(alignment: .leading, horizontalSpacing: 24, verticalSpacing: 10) {
                    row("Shorts", "\(stats.shortCount)")
                    row("Total length of Shorts", Self.clock(stats.shortsSeconds), mono: true)
                    row("Exported videos", "\(stats.exportCount)")
                    if let name = stats.sourceName { row("Source video", name) }
                    if let seconds = stats.sourceSeconds { row("Source length", Self.clock(seconds), mono: true) }
                    if let resolution = stats.resolution { row("Resolution", resolution) }
                    row("Created", stats.created.formatted(date: .abbreviated, time: .shortened))
                    row("Size on disk", ByteCountFormatter.string(fromByteCount: stats.bytes, countStyle: .file))
                }
            } else if failed {
                Text("Could not read this project.").foregroundStyle(Prism.textSecondary)
            } else {
                ProgressView().frame(maxWidth: .infinity, minHeight: 120)
            }
            HStack {
                Button("Show in Finder") { NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: path)]) }
                    .buttonStyle(.prismSecondary)
                Spacer()
                Button("Done") { dismiss() }.buttonStyle(.prismPrimary).keyboardShortcut(.defaultAction)
            }
        }
        .padding(24)
        .frame(width: 440)
        .font(Prism.text(13))
        .foregroundStyle(Prism.text)
        .background(Prism.surface1)
        .task { await load() }
    }

    @ViewBuilder
    private func row(_ label: String, _ value: String, mono: Bool = false) -> some View {
        GridRow {
            Text(label).foregroundStyle(Prism.textSecondary)
            Text(value).font(mono ? Prism.mono(13) : Prism.text(13, .medium)).lineLimit(1).truncationMode(.middle)
        }
    }

    private func load() async {
        let projectPath = path
        let loaded = await Task.detached(priority: .utility) { () -> ProjectStats? in
            let root = URL(fileURLWithPath: projectPath)
            guard let project = try? ProjectStore(root: root, create: false).load(ProjectData.self, key: "project") else { return nil }
            let video = project.media.first(where: { $0.kind == "video" })
            let manager = FileManager.default
            let exports = (try? manager.contentsOfDirectory(at: root.appendingPathComponent("Exports"), includingPropertiesForKeys: nil)) ?? []
            var bytes: Int64 = 0
            if let files = manager.enumerator(at: root, includingPropertiesForKeys: [.totalFileAllocatedSizeKey]) {
                while let file = files.nextObject() as? URL {
                    bytes += Int64((try? file.resourceValues(forKeys: [.totalFileAllocatedSizeKey]).totalFileAllocatedSize) ?? 0)
                }
            }
            return ProjectStats(title: project.displayTitle, created: project.created, shortCount: project.segments.count,
                                shortsSeconds: project.segments.reduce(0) { $0 + $1.duration },
                                exportCount: exports.filter { $0.pathExtension.lowercased() == "mp4" }.count,
                                sourceName: video?.name, sourceSeconds: video?.duration,
                                resolution: video.flatMap { $0.width > 0 ? "\($0.width) × \($0.height)" : nil }, bytes: bytes)
        }.value
        stats = loaded
        failed = loaded == nil
    }

    private static func clock(_ seconds: Double) -> String {
        let total = max(0, Int(seconds.rounded()))
        if total >= 3600 { return String(format: "%d:%02d:%02d", total / 3600, (total / 60) % 60, total % 60) }
        return String(format: "%d:%02d", total / 60, total % 60)
    }
}

private struct RecentProjectSummary: Sendable {
    var title: String
    var duration: Double?
    var shortCount: Int
    var created: Date?
    var poster: CGImage?
}

/// One project as a compact row: a frame from its first Short, its title, Short count and creation date.
/// Projects cut from the same video share a source, so the source's thumbnail and name can't tell them apart.
private struct RecentProjectCard: View {
    let path: String
    /// Changes when the project is renamed from Home, so the card reloads.
    var revision = 0
    let action: () -> Void
    @State private var summary: RecentProjectSummary?

    private var fallbackTitle: String { ProjectData.folderTitle(URL(fileURLWithPath: path)) }

    private var details: String {
        guard let summary else { return " " }
        let shorts = summary.shortCount == 0 ? "No Shorts yet" : summary.shortCount == 1 ? "1 Short" : "\(summary.shortCount) Shorts"
        guard let created = summary.created else { return shorts }
        return shorts + " · " + created.formatted(.dateTime.day().month(.abbreviated).hour().minute())
    }

    var body: some View {
        Button(action: action) {
            VStack(alignment: .leading, spacing: 9) {
                ZStack {
                    if let poster = summary?.poster {
                        Image(decorative: poster, scale: 1).resizable().aspectRatio(contentMode: .fill)
                    } else {
                        Rectangle().fill(Prism.surface2)
                        Image(systemName: "play.rectangle.fill").font(Prism.text(34)).foregroundStyle(Prism.textSecondary)
                    }
                }
                .aspectRatio(16 / 9, contentMode: .fit)
                .clipped()
                .clipShape(RoundedRectangle(cornerRadius: 12))
                .overlay(alignment: .bottomTrailing) {
                    if let duration = summary?.duration {
                        Text(Self.clock(duration))
                            .font(Prism.display(10).monospacedDigit()).foregroundStyle(Prism.paper)
                            .padding(.horizontal, 6).padding(.vertical, 3)
                            .background(.black.opacity(0.78), in: RoundedRectangle(cornerRadius: 8))
                            .padding(6)
                    }
                }
                Text(summary?.title ?? fallbackTitle)
                    .font(Prism.text(12, .medium))
                    .lineLimit(2)
                    .multilineTextAlignment(.leading)
                    .frame(maxWidth: .infinity, minHeight: 30, alignment: .topLeading)
                Text(details)
                    .font(Prism.text(9, .medium))
                    .foregroundStyle(Prism.textSecondary)
                    .lineLimit(1)
            }
            .padding(8)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Prism.surface1, in: RoundedRectangle(cornerRadius: 12))
            .contentShape(RoundedRectangle(cornerRadius: 12))
        }
        .buttonStyle(.plain)
        .pointerFeedback()
        .accessibilityLabel("Open \(summary?.title ?? fallbackTitle), \(details)")
        .task(id: "\(path)#\(revision)") { await loadSummary() }
    }

    private static func clock(_ seconds: Double) -> String {
        let total = max(0, Int(seconds.rounded()))
        if total >= 3600 { return String(format: "%d:%02d:%02d", total / 3600, (total / 60) % 60, total % 60) }
        return String(format: "%d:%02d", total / 60, total % 60)
    }

    nonisolated(unsafe) private static let posterCache = NSCache<NSString, AnyObject>()
    private func loadSummary() async {
        let projectPath = path
        let loaded = await Task.detached(priority: .utility) { () -> RecentProjectSummary in
            let root = URL(fileURLWithPath: projectPath)
            guard let store = try? ProjectStore(root: root, create: false),
                  let project = try? store.load(ProjectData.self, key: "project") else {
                return RecentProjectSummary(title: ProjectData.folderTitle(root), duration: nil, shortCount: 0, created: nil, poster: nil)
            }
            let video = project.media.first(where: { $0.kind == "video" })
            let firstShort = project.segments.first
            var poster: CGImage?
            if let video {
                // Moved projects keep their media inside the project folder.
                let stored = URL(fileURLWithPath: video.path)
                let source = FileManager.default.fileExists(atPath: stored.path) ? stored
                    : root.appendingPathComponent("Media").appendingPathComponent(video.name)
                let time = firstShort.map { $0.start + min(1, $0.duration / 2) } ?? 1
                // Home reloads its cards on every visit; the poster only changes with the video or the first Short.
                let key = "\(source.path)|\(time)" as NSString
                if let cached = Self.posterCache.object(forKey: key) {
                    poster = CFGetTypeID(cached) == CGImage.typeID ? (cached as! CGImage) : nil
                } else {
                    let generator = AVAssetImageGenerator(asset: AVURLAsset(url: source))
                    generator.appliesPreferredTrackTransform = true
                    generator.maximumSize = CGSize(width: 480, height: 270)
                    poster = try? generator.copyCGImage(at: CMTime(seconds: time, preferredTimescale: 600), actualTime: nil)
                    if let poster { Self.posterCache.setObject(poster, forKey: key) }
                }
            }
            return RecentProjectSummary(title: project.displayTitle, duration: video?.duration, shortCount: project.segments.count,
                                        created: project.created, poster: poster)
        }.value
        guard !Task.isCancelled else { return }
        summary = loaded
    }
}

struct RelioPlayerView: NSViewRepresentable {
    let player: AVPlayer
    /// The Short being previewed; its export caption layers are drawn over the live video.
    var captionSegment: EditSegment? = nil
    var showsControls = false
    func makeNSView(context: Context) -> AVPlayerView {
        let view = AVPlayerView()
        view.controlsStyle = showsControls ? .floating : .none
        view.videoGravity = .resizeAspect
        view.player = player
        attachCaptions(to: view)
        return view
    }
    func makeCoordinator() -> Coordinator { Coordinator() }
    final class Coordinator { var captionSegment: EditSegment? }
    func updateNSView(_ view: AVPlayerView, context: Context) {
        if view.player !== player {
            view.player = player
            attachCaptions(to: view)
        } else if context.coordinator.captionSegment != captionSegment {
            attachCaptions(to: view)
        }
        context.coordinator.captionSegment = captionSegment
    }
    private func attachCaptions(to view: AVPlayerView) {
        guard let overlay = view.contentOverlayView else { return }
        overlay.subviews.forEach { $0.removeFromSuperview() }
        guard let item = player.currentItem, let segment = captionSegment,
              let captions = ShortMaker.captionLayer(for: segment) else { return }
        let captionView = PreviewCaptionView(item: item, captions: captions)
        captionView.frame = overlay.bounds
        captionView.autoresizingMask = [.width, .height]
        overlay.addSubview(captionView)
    }
}

/// Export's caption layers over the live preview: synced to playback and scaled to the displayed 9:16 video.
final class PreviewCaptionView: NSView {
    private let sync: AVSynchronizedLayer
    private let captions: CALayer
    init(item: AVPlayerItem, captions: CALayer) {
        sync = AVSynchronizedLayer(playerItem: item)
        self.captions = captions
        super.init(frame: .zero)
        wantsLayer = true
        captions.anchorPoint = .zero
        sync.addSublayer(captions)
        layer?.addSublayer(sync)
    }
    required init?(coder: NSCoder) { nil }
    // Clicks go through to the player controls.
    override func hitTest(_ point: NSPoint) -> NSView? { nil }
    override func layout() {
        super.layout()
        let video = AVMakeRect(aspectRatio: CGSize(width: 1080, height: 1920), insideRect: bounds)
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        sync.frame = video
        captions.position = .zero
        captions.setAffineTransform(CGAffineTransform(scaleX: video.width / 1080, y: video.height / 1920))
        CATransaction.commit()
    }
}

