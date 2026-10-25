import Foundation
import AVFoundation
import AppKit
import SwiftUI
import CSQLite

@main struct EditorModelTest {
    @MainActor static func main() async throws {
        let source = URL(fileURLWithPath: CommandLine.arguments[1])
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("RelioEditorTest-\(UUID())")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        guard let media = await MediaEngine.inspect(source, thumbnailDirectory: root) else { fatalError("Fixture unavailable") }
        let store = try ProjectStore(root: root)
        precondition(AppModel.exportFileName(title: "Oil: \"what's\" next?/now") == "Oil what's next now"
                     && AppModel.exportFileName(title: " .. ") == nil && AppModel.exportFileName(title: nil) == nil
                     && AppModel.exportFileName(title: String(repeating: "a", count: 200))?.count == 80,
                     "Export names must drop path and Finder-unsafe characters")
        print("PASS export file names come from Short titles")
        precondition(AppModel.failureKind(GeminiSelection.Failure.request(503)) == .temporary
                     && AppModel.failureKind(GeminiSelection.StageFailure(stage: "Audio transcription at 3m 0s", underlying: GeminiSelection.Failure.request(503))) == .temporary
                     && AppModel.failureKind(URLError(.notConnectedToInternet)) == .temporary
                     && AppModel.failureKind(GeminiSelection.Failure.request(403)) == .settings
                     && AppModel.failureKind(GeminiSelection.Failure.noStrongClips) == .noMoments
                     && AppModel.failureKind(ShortMaker.Failure.noVideo) == .other,
                     "A busy server must never be reported as a problem with the video or its range")
        print("PASS failed runs are explained by cause: busy server, settings, range or other")
        let model = AppModel(appDirectory: root.appendingPathComponent("App"))
        let folderModel = AppModel(appDirectory: root.appendingPathComponent("Folders"))
        var createdPaths = Set<URL>()
        for _ in 0..<5 {
            folderModel.create()
            precondition(createdPaths.insert(folderModel.projectURL!).inserted, "Rapid creation must never overwrite a project")
        }
        let createdIDs = try createdPaths.map { try ProjectStore(root: $0, create: false).load(ProjectData.self, key: "project")!.id }
        precondition(Set(createdIDs).count == 5)
        print("PASS rapid project creation preserves five separate projects")
        let exportFolder = root.appendingPathComponent("Collision checks")
        try FileManager.default.createDirectory(at: exportFolder, withIntermediateDirectories: true)
        try Data().write(to: exportFolder.appendingPathComponent("Story 2.mp4"))
        var reserved = Set<String>()
        let firstName = AppModel.reserveExportDestination(name: "Story", folder: exportFolder, reserved: &reserved)
        let secondName = AppModel.reserveExportDestination(name: "Story", folder: exportFolder, reserved: &reserved)
        let thirdName = AppModel.reserveExportDestination(name: "STORY", folder: exportFolder, reserved: &reserved)
        precondition(firstName.lastPathComponent == "Story.mp4" && secondName.lastPathComponent == "Story 3.mp4"
                     && Set([firstName, secondName, thirdName].map { $0.lastPathComponent.lowercased() }).count == 3,
                     "Concurrent exports must skip existing numbered names and case-insensitive reservations")
        print("PASS concurrent export names avoid existing numbered files and case collisions")
        folderModel.recentProjectPaths = ["/p/one.relio", "/p/two.relio"]
        let podcasts = folderModel.createFolder(named: "  Podcasts  ")!, other = folderModel.createFolder(named: "Other")!
        precondition(folderModel.createFolder(named: "   ") == nil)
        folderModel.moveProject("/p/one.relio", toFolder: podcasts)
        folderModel.moveProject("/p/one.relio", toFolder: other)
        folderModel.moveProject("not a project", toFolder: other)
        precondition(folderModel.projectFolders.first { $0.id == podcasts }?.projectPaths.isEmpty == true
                     && folderModel.projectFolders.first { $0.id == other }?.projectPaths == ["/p/one.relio"],
                     "A project lives in one folder at a time, and unknown drops are ignored")
        folderModel.renameFolder(other, to: "Satellite")
        folderModel.deleteFolder(other)
        precondition(folderModel.projectFolders.map(\.name) == ["Podcasts"] && folderModel.recentProjectPaths.count == 2,
                     "Deleting a folder keeps its projects")
        folderModel.deleteFolder(podcasts)
        print("PASS Home folders: create, move, one folder per project, rename, delete keeps projects")
        model.startLongVideoToShort()
        precondition(model.screen == .importSource && model.projectURL == nil && model.shortsSource == nil,
                     "Starting upload must not create an empty project or show previous footage")
        model.screen = .editor
        model.store = store
        model.projectURL = root
        model.project = ProjectData(name: "Editor test", media: [media])
        model.selection = media.id
        try model.save()
        var database: OpaquePointer?
        precondition(sqlite3_open(root.appendingPathComponent("project.sqlite").path, &database) == SQLITE_OK)
        precondition(sqlite3_exec(database, "CREATE TRIGGER test_save_failure BEFORE INSERT ON state BEGIN SELECT RAISE(ABORT, 'injected failure'); END", nil, nil, nil) == SQLITE_OK)
        do {
            _ = try model.appendGeneratedShorts([EditSegment(mediaID: media.id, start: 0, duration: 1)])
            preconditionFailure("Unsaved generated batches must be rejected")
        } catch { }
        precondition(model.project?.segments.isEmpty == true && model.editHistory.isEmpty)
        let originalTitle = model.project?.title
        model.renameProject(at: root.path, to: "Failed rename")
        precondition(model.project?.title == originalTitle && model.message.hasPrefix("Could not rename project:"),
                     "A failed rename must not be applied by a later save")
        model.importSource(source)
        let importDeadline = Date().addingTimeInterval(15)
        while model.isBusy && Date() < importDeadline { try await Task.sleep(for: .milliseconds(20)) }
        precondition(!model.isBusy && model.project?.media.map(\.id) == [media.id] && model.selection == media.id && model.player == nil,
                     "An unsaved import must leave the previous media, selection and player intact")
        precondition(model.message.hasPrefix("Could not save import:"))
        precondition(sqlite3_exec(database, "DROP TRIGGER test_save_failure", nil, nil, nil) == SQLITE_OK)
        sqlite3_close(database)
        print("PASS failed import preserves the previous selection and player")
        model.resetSourceRange(for: media)
        model.shortSourceRegion = .custom
        precondition(model.customRangeError == nil)
        model.customEndMinutes = "1000"
        precondition(model.customRangeError != nil, "Custom end must not exceed the imported video")
        model.makeConfiguredShorts()
        precondition(!model.isBusy && model.project?.segments.isEmpty == true, "Invalid range must block generation before AI calls")
        model.customEndMinutes = "NaN"
        precondition(model.customRangeError != nil)
        model.resetSourceRange(for: media)
        model.makeConfiguredShorts()
        precondition(!model.isBusy && model.generationError?.kind == .settings, "A missing key must open the Settings popup, not \"No Shorts found\"")
        model.generationError = nil
        print("PASS imported duration initializes the custom range and invalid minutes block generation")
        let generated = EditSegment(mediaID: media.id, start: 0, duration: 1, fitToFrame: true, suggestedTitle: "First story", selectionReason: "A specific hook and payoff.", captionNotice: "Sentence timing notice", captionStyle: .viral)
        _ = try model.appendGeneratedShorts([generated])
        let distinct = EditSegment(mediaID: media.id, start: 2, duration: 1)
        let appended = try model.appendGeneratedShorts([generated, distinct, distinct])
        precondition(appended.count == 1 && model.project?.segments.count == 2 && model.project?.segments.first?.id == generated.id,
                     "Generation must retain earlier work and reject duplicate candidates")
        let persisted = try store.load(ProjectData.self, key: "project")
        precondition(persisted?.segments.count == 2 && model.editHistory.last?.count == 1)
        precondition(persisted?.segments.first?.suggestedTitle == "First story" && persisted?.segments.first?.fitToFrame == true &&
                     persisted?.segments.first?.captionNotice == "Sentence timing notice" && persisted?.segments.first?.captionStyle == .viral)
        let undoCount = model.editHistory.count
        do {
            _ = try model.appendGeneratedShorts([EditSegment(mediaID: media.id, start: .nan, duration: 1)])
            preconditionFailure("Unencodable generated edits must not be committed")
        } catch { }
        precondition(model.project?.segments.count == 2 && model.editHistory.count == undoCount,
                     "Failed persistence must restore both clips and undo state")
        var reusedID = generated
        reusedID.start = 3
        let reused = try model.appendGeneratedShorts([reusedID])
        precondition(reused.isEmpty, "A generated batch must not reuse an existing clip ID")
        for invalid in [EditSegment(mediaID: media.id, start: -1, duration: 1),
                        EditSegment(mediaID: media.id, start: media.duration, duration: 1),
                        EditSegment(mediaID: UUID(), start: 0, duration: 1)] {
            do { _ = try model.appendGeneratedShorts([invalid]); preconditionFailure("Invalid source ranges must be rejected") }
            catch { }
        }
        precondition(model.project?.segments.count == 2 && model.editHistory.count == undoCount)
        model.project?.segments = []
        model.editHistory = []
        try model.save()
        print("PASS generated batches preserve previous edits, deduplicate and persist undo history")
        // Menu bar: Export only in the editor with a video, Edit › Undo undoes the last Short edit, appearance follows macOS by default.
        let emailWas = model.account.email
        model.account.email = "tester@example.com"
        model.screen = .home
        precondition(!model.canExport && model.canUseMenus, "Export must be off outside the editor")
        model.screen = .editor
        precondition(model.canExport, "Export must be on in the editor with a video")
        model.isBusy = true
        precondition(!model.canExport && !model.canUseMenus, "Menus must be off while a task runs")
        model.isBusy = false
        _ = try model.appendGeneratedShorts([EditSegment(mediaID: media.id, start: 3, duration: 1)])
        precondition(model.project?.segments.count == 1)
        model.undoFromMenu()
        precondition(model.project?.segments.isEmpty == true && model.editHistory.isEmpty, "Edit › Undo must undo the last Short edit")
        model.screen = .home
        model.redoFromMenu()
        precondition(model.project?.segments.isEmpty == true, "Redo must not change a project outside the editor")
        model.screen = .editor
        model.redoFromMenu()
        precondition(model.project?.segments.count == 1 && model.redoHistory.isEmpty, "Edit › Redo must restore the generated batch")
        model.undoFromMenu()
        model.account.email = emailWas
        precondition(PrismAppearance.system.colorScheme == nil && PrismAppearance.dark.colorScheme == .dark && PrismAppearance.light.colorScheme == .light)
        print("PASS menu bar: Export and Undo follow the editor; appearance follows macOS by default")
        // ↑ and ↓ walk the Shorts in the list's order, video order or best first, and stop at either end.
        var low = EditSegment(mediaID: media.id, start: 0, duration: 1); low.score = 60
        var high = EditSegment(mediaID: media.id, start: 2, duration: 1); high.score = 95
        model.project?.segments = [low, high]
        model.selectPreview(low.id)
        model.selectAdjacentShort(1)
        precondition(model.previewShortID == high.id, "↓ must open the next Short")
        model.selectAdjacentShort(1)
        precondition(model.previewShortID == high.id, "↓ on the last Short must stay there")
        UserDefaults.standard.set(true, forKey: "editor.shortsBestFirst")
        model.selectAdjacentShort(1)
        precondition(model.previewShortID == low.id, "Best first puts the 95 before the 60, so ↓ goes to the 60")
        UserDefaults.standard.removeObject(forKey: "editor.shortsBestFirst")
        model.selectPreview(nil)
        model.project?.segments = []
        print("PASS arrow keys move between Shorts in the order the list shows")
        // Video limit: 60 minutes a calendar day and 300 a week; a video counts once, at its length.
        var calendar = Calendar(identifier: .gregorian); calendar.timeZone = TimeZone(identifier: "UTC")!; calendar.firstWeekday = 2
        let monday = Date(timeIntervalSince1970: 1_793_059_200) // Monday 2026-10-26 00:00 UTC
        var usage: [UsageLimit.Entry] = []
        for index in 0..<3 { usage = UsageLimit.recorded("video \(index)", minutes: 20, in: usage, now: monday.addingTimeInterval(Double(index) * 60), calendar: calendar) }
        let noon = monday.addingTimeInterval(12 * 3_600)
        precondition(UsageLimit.used(.day, entries: usage, now: noon, calendar: calendar) == 60)
        precondition(UsageLimit.refusal(for: "video 9", minutes: 5, entries: usage, now: noon, calendar: calendar)?.contains("daily") == true, "Going past 60 minutes today must be refused")
        precondition(UsageLimit.refusal(for: "video 1", minutes: 20, entries: usage, now: noon, calendar: calendar) == nil, "A video already used today is free to make again")
        precondition(UsageLimit.recorded("video 1", minutes: 20, in: usage, now: noon, calendar: calendar).count == 3, "The same video is counted once a day")
        for day in 1..<5 {
            usage = UsageLimit.recorded("day \(day) video", minutes: 60, in: usage, now: monday.addingTimeInterval(Double(day) * 86_400), calendar: calendar)
        }
        let saturday = monday.addingTimeInterval(5 * 86_400 + 3_600)
        precondition(UsageLimit.used(.weekOfYear, entries: usage, now: saturday, calendar: calendar) == 300)
        precondition(UsageLimit.refusal(for: "new", minutes: 5, entries: usage, now: saturday, calendar: calendar)?.contains("weekly") == true, "Going past 300 minutes this week must be refused")
        precondition(UsageLimit.refusal(for: "video 0", minutes: 20, entries: usage, now: saturday, calendar: calendar) == nil, "A video already used this week doesn't count again")
        precondition(UsageLimit.refusal(for: "new", minutes: 5, entries: usage, now: monday.addingTimeInterval(7 * 86_400 + 60), calendar: calendar) == nil, "A new week starts fresh")
        print("PASS usage limit: 60 minutes a day, 300 a week, each video counted once")
        // Account: signed out means no sign-in state and no network call for exports; sign-out clears the saved email.
        UserDefaults.standard.set("tester@example.com", forKey: "account.email")
        let signedIn = Account()
        precondition(signedIn.email == "tester@example.com" && signedIn.isSignedIn, "The email is read from defaults at launch, without the Keychain")
        signedIn.signOut()
        precondition(!signedIn.isSignedIn && UserDefaults.standard.string(forKey: "account.email") == nil, "Sign-out clears the account")
        await Account().recordExport(shortCount: 3, seconds: 90, quality: "full")
        print("PASS account: launch reads only the saved email, and sign-out clears it")
        // Supabase gets a 64-character hash of the video, never its name; the day is sent as yyyy-MM-dd.
        let sample = MediaItem(path: "/private/secret/Interview.mov", kind: "video", duration: 1_234.4)
        precondition(UsageLimit.serverKey(sample).count == 64 && !UsageLimit.serverKey(sample).contains("Interview"), "The file name must not leave the Mac")
        precondition(UsageLimit.serverKey(sample) == UsageLimit.serverKey(sample), "The same video gives the same key")
        var utc = Calendar(identifier: .gregorian); utc.timeZone = TimeZone(identifier: "UTC")!
        precondition(Account.dayString(Date(timeIntervalSince1970: 1_793_059_200)).count == 10, "Days are sent as yyyy-MM-dd")
        print("PASS usage on Supabase: video names are hashed and days are yyyy-MM-dd")

        precondition(ShortMaker.autoCount(seconds: 30) == 1 && ShortMaker.autoCount(seconds: 1_260) == 20 && ShortMaker.autoCount(seconds: 600) == 10 && ShortMaker.autoCount(seconds: 7_200) == 20)
        var scored = EditSegment(mediaID: UUID(), duration: 20)
        scored.score = 87
        let reloaded = try! JSONDecoder().decode(EditSegment.self, from: JSONEncoder().encode(scored))
        precondition(reloaded.score == 87, "A Short's Gemini score must survive saving the project")
        precondition(try! JSONDecoder().decode(EditSegment.self, from: Data(#"{"mediaID":"\#(UUID().uuidString)","duration":5}"#.utf8)).score == nil)
        precondition(model.isShortCountAuto, "Auto is the default Short count")
        precondition(model.shortDuration == 0 && GeminiSelection.lengthRange(0) == (15, 60), "Auto length lets each Short run 15–60 seconds")
        precondition(GeminiSelection.lengthRange(30) == (19.5, 45), "A fixed length keeps its old 0.65–1.5× range")
        let autoLength = try! GeminiSelection.validate([.init(start: 10, end: 62, score: 8, layout: "track"), .init(start: 100, end: 112, score: 9, layout: "track")],
                                                       interval: (0, 600), targetDuration: 0, count: 5)
        precondition(autoLength.map(\.start) == [10], "Auto length keeps a 52 s story and drops a 12 s fragment")
        let many = (0..<25).map { GeminiSelection.Clip(start: Double($0) * 50, end: Double($0) * 50 + 30, score: 8, layout: "track") }
        let capped = try! GeminiSelection.validate(many, interval: (0, 1_260), targetDuration: 0, count: 25)
        precondition(capped.count == 20, "One run keeps up to 20 distinct Shorts")
        print("PASS auto Shorts: count scales with length, Auto length allows 15–60 s, Gemini score is saved with each Short")
        // Manual clips keep their saved framing; this does not make API calls.
        model.shortDuration = 3
        model.addManualClip()
        await waitForPreview(model)
        precondition(model.project?.segments.count == 1 && model.activeSegment?.duration == 3)
        let first = model.activeSegment!.id
        model.addManualClip()
        await waitForPreview(model)
        let second = model.activeSegment!.id
        precondition(first != second && model.project?.segments.count == 2)
        model.updateSelectedEdit(start: 0.5, duration: 2, caption: "Inspector test", captionStart: 0.5, captionDuration: 1)
        await waitForPreview(model)
        precondition(model.project?.segments.first?.duration == 3)
        precondition(model.activeSegment?.start == 0.5 && model.activeSegment?.caption == "Inspector test")
        model.updateSelectedEdit(start: 0.5, duration: 2, caption: "Inspector test", captionStart: 0.5, captionDuration: 1, cropPosition: 0.85)
        precondition(abs((model.activeSegment?.cropPosition ?? 0) - 0.85) < 0.001, "Crop position was not applied")
        let saved = try store.load(ProjectData.self, key: "project")
        precondition(saved?.segments.last?.caption == "Inspector test" && abs((saved?.segments.last?.cropPosition ?? 0) - 0.85) < 0.001,
                     "Crop position was not persisted")
        // Focus points land where they are clicked despite the tracking offset, and edits keep scene cuts.
        let focusIndex = model.project!.segments.firstIndex { $0.id == model.activeSegment!.id }!
        model.project!.segments[focusIndex].cropKeyframes = [CropKeyframe(time: 0, position: 0.5),
                                                             CropKeyframe(time: 1, position: 0.2, isSceneCut: true), CropKeyframe(time: 2, position: 0.2)]
        model.adjustCropKeyframe(from: 1.5, to: 1.5, position: 0.6, insert: true)
        await waitForPreview(model)
        let focused = model.activeSegment!
        let clicked = focused.cropKeyframes?.first { abs($0.time - 1.5) < 0.01 }
        precondition(clicked.map { abs($0.position + (focused.cropPosition ?? 0.5) - 0.5 - 0.6) < 0.001 } == true,
                     "A focus point must show where it was clicked, offset included")
        precondition(focused.cropKeyframes?.contains { $0.time == 1 && $0.isSceneCut == true } == true, "Adding a focus point must keep scene cuts")
        model.adjustCropKeyframe(from: 1.5, to: 1.5, position: 0.05, insert: false)
        let edgeFocused = model.activeSegment!
        let edge = edgeFocused.cropKeyframes!.first { abs($0.time - 1.5) < 0.01 }!
        precondition(abs(edge.position + (edgeFocused.cropPosition ?? 0.5) - 0.5 - 0.05) < 0.001,
                     "The left edge must stay reachable with a strong crop offset")
        model.adjustCropKeyframe(from: 1.5, to: 1, position: 0.4, insert: false)
        precondition(model.activeSegment?.cropKeyframes?.contains { $0.time == 1 && $0.isSceneCut == true } == true,
                     "Merging focus points must preserve the scene cut")
        await waitForPreview(model)
        print("PASS focus points honor the tracking offset and keep scene cuts")
        let trackingSnapshot = model.project!.segments
        precondition(sqlite3_open(root.appendingPathComponent("project.sqlite").path, &database) == SQLITE_OK)
        precondition(sqlite3_exec(database, "CREATE TRIGGER test_save_failure BEFORE INSERT ON state BEGIN SELECT RAISE(ABORT, 'injected failure'); END", nil, nil, nil) == SQLITE_OK)
        model.retrackSelectedSubject()
        precondition(model.project?.segments == trackingSnapshot && model.message.hasPrefix("Could not refresh subject tracking:"),
                     "Failed re-tracking saves must keep the prior framing")
        precondition(sqlite3_exec(database, "DROP TRIGGER test_save_failure", nil, nil, nil) == SQLITE_OK)
        sqlite3_close(database)
        print("PASS failed re-tracking preserves saved framing")
        let legacySegment = try JSONDecoder().decode(EditSegment.self, from: Data("{\"mediaID\":\"\(media.id.uuidString)\",\"duration\":3}".utf8))
        precondition(legacySegment.cropPosition == 0.5, "Legacy project crop position should default to center")
        model.updateSelectedEdit(start: -1, duration: 2, caption: "Invalid", captionStart: 0, captionDuration: 1)
        precondition(model.activeSegment?.caption == "Inspector test")
        // Captions tab: the style survives clip edits; text edits keep timing and drop cleared lines.
        let captionedID = model.activeSegment!.id
        let captionedIndex = model.project!.segments.firstIndex { $0.id == captionedID }!
        model.project!.segments[captionedIndex].captions = [TimedCaption(text: "hello there", start: 0, duration: 0.5),
                                                            TimedCaption(text: "remove me", start: 0.5, duration: 0.5)]
        model.setSelectedCaptionStyle(.viral)
        await waitForPreview(model)
        model.updateSelectedEdit(start: 0.5, duration: 2, caption: "Inspector test", captionStart: 0.5, captionDuration: 1, cropPosition: 0.85)
        await waitForPreview(model)
        precondition(model.activeSegment?.captionStyle == .viral, "Clip edits must not reset the caption style")
        model.updateSelectedCaptionTexts(["Hello there!", "  "])
        await waitForPreview(model)
        precondition(model.activeSegment?.captions == [TimedCaption(text: "Hello there!", start: 0, duration: 0.5)],
                     "Caption text edits must keep timing and remove cleared lines")
        let captionSaved = try store.load(ProjectData.self, key: "project")?.segments.first { $0.id == captionedID }
        precondition(captionSaved?.captionStyle == .viral && captionSaved?.captions?.map(\.text) == ["Hello there!"],
                     "Caption style and text must be persisted")
        print("PASS captions tab: style survives clip edits, text edits keep timing and persist")
        model.toggleSelectedAudio()
        await waitForPreview(model)
        precondition(model.activeSegment?.isMuted == true)
        model.setFraming(fit: true)
        await waitForPreview(model)
        precondition(model.activeSegment?.fitToFrame == true)
        model.undoFromEditor()
        await waitForPreview(model)
        precondition(model.project?.segments.last?.fitToFrame != true && model.activeSegment?.id == second)
        let undone = model.project!.segments
        model.undoFromEditor()
        precondition(model.activeSegment?.isMuted != true && model.redoHistory.count == 2)
        model.redoFromEditor()
        model.redoFromEditor()
        await waitForPreview(model)
        precondition(model.activeSegment?.fitToFrame == true && model.activeSegment?.isMuted == true && model.activeSegment?.id == second,
                     "Multiple redos must restore audio, framing and the selected Short")
        let redone = try store.load(ProjectData.self, key: "project")
        precondition(redone?.segments == model.project?.segments, "Redo must save the restored edits")
        model.undoFromEditor()
        precondition(model.project?.segments == undone)
        let redoCount = model.redoHistory.count
        model.updateSelectedEdit(start: -1, duration: 2, caption: "Invalid", captionStart: 0, captionDuration: 1)
        do {
            _ = try model.appendGeneratedShorts([EditSegment(mediaID: media.id, start: .nan, duration: 1)])
            preconditionFailure("Unencodable edits must fail")
        } catch { }
        precondition(model.redoHistory.count == redoCount && model.project?.segments == undone,
                     "Rejected and unsaved edits must preserve redo history")
        // Encoding failure exercises rollback without depending on filesystem permissions.
        let validRedo = model.redoHistory.last!
        model.redoHistory[model.redoHistory.count - 1][0].start = .nan
        let undoCountBeforeFailure = model.editHistory.count
        model.redoFromEditor()
        precondition(model.project?.segments == undone && model.redoHistory.count == redoCount
                     && model.editHistory.count == undoCountBeforeFailure && model.message.contains("Could not save redo"),
                     "Failed redo must keep the current project and both history stacks")
        model.redoHistory[model.redoHistory.count - 1] = validRedo
        model.isBusy = true
        model.redoFromEditor()
        precondition(model.project?.segments == undone && model.redoHistory.count == redoCount, "Redo must wait while a task runs")
        model.isBusy = false
        model.setFraming(fit: false)
        precondition(model.redoHistory.isEmpty, "A saved edit after Undo must discard the old redo branch")
        let branch = model.project!.segments
        model.redoFromEditor()
        precondition(model.project?.segments == branch, "Discarded redo branches must stay unavailable")
        model.removeShort(second)
        precondition(model.project?.segments.count == 1)
        model.undoFromEditor()
        precondition(model.project?.segments == branch, "Undo must restore a removed Short with its original ID and edits")
        model.redoFromEditor()
        precondition(model.project?.segments.count == 1, "Redo must remove that Short again")
        model.undoFromEditor()
        await waitForPreview(model)
        print("PASS redo: generated batches, multiple edits, persistence, failure rollback, busy guards, branching and removal")
        model.selectPreview(second)
        await waitForPreview(model)
        model.seekPreview(to: 0.75)
        try await Task.sleep(for: .milliseconds(300))
        precondition(abs((model.player?.currentTime().seconds ?? -10) - 0.75) < 0.1)
        model.isBusy = true
        model.addManualClip()
        model.toggleSelectedAudio()
        model.undoFromEditor()
        precondition(model.project?.segments.count == 2 && model.activeSegment?.isMuted == true)
        model.isBusy = false
        model.chooseExport()
        precondition(model.exportChoice?.shortIDs.count == 2 && model.exportChoice?.includeSource == false
                     && model.exportChoice?.folder.path.contains("/Downloads/Prism/") == true, "Export must default to every Short in Downloads › Prism")
        model.chooseExport(only: second)
        precondition(model.exportChoice?.shortIDs == [second], "Export this Short must tick only that Short")
        // A folder that can't be created keeps the card open with the reason, and nothing starts.
        try Data("not a folder".utf8).write(to: root.appendingPathComponent("blocker"))
        model.chooseExport()
        model.exportChoice?.folder = root.appendingPathComponent("blocker").appendingPathComponent("Exports")
        model.export(model.exportChoice!)
        precondition(!model.isBusy && model.exportChoice?.error?.contains("Could not use this folder") == true,
                     "An unusable export folder must be explained on the card")
        model.chooseExport()
        model.exportChoice?.folder = root.appendingPathComponent("Exports")
        model.exportChoice?.includeSource = true
        model.export(model.exportChoice!)
        precondition(model.exportChoice == nil, "The export card must close when exporting starts")
        let deadline = Date().addingTimeInterval(45)
        while model.isBusy && Date() < deadline { try await Task.sleep(for: .milliseconds(100)) }
        precondition(!model.isBusy && model.message.contains("Exported"), model.message)
        let outputs = try FileManager.default.contentsOfDirectory(at: root.appendingPathComponent("Exports"), includingPropertiesForKeys: nil)
        precondition(outputs.filter { $0.pathExtension == "mp4" }.count == 2 && outputs.contains { $0.lastPathComponent == source.lastPathComponent },
                     "Both Shorts and the main video must be exported: \(outputs.map(\.lastPathComponent))")
        for output in outputs {
            let asset = AVURLAsset(url: output)
            let duration = try await asset.load(.duration).seconds
            precondition(duration > 0)
            if output.lastPathComponent.contains("Short 2") {
                let audio = try await asset.loadTracks(withMediaType: .audio)
                precondition(audio.isEmpty, "Muted clip contains audio")
            } else if media.hasAudio == true {
                let audio = try await asset.loadTracks(withMediaType: .audio)
                precondition(!audio.isEmpty, "Source audio was lost")
            }
        }
        model.player?.pause()
        model.player = nil
        print("PASS editor actions: add clips, select second clip, trim/text, crop position persistence and legacy default, reject invalid range, mute, framing, undo, seek, busy guards, save/reopen, export both clips")
        // Renaming the open project changes it in memory too, so a later save keeps the new name.
        let revision = model.projectListRevision
        model.renameProject(at: root.path, to: "  My oil Shorts  ")
        try model.save()
        precondition(model.project?.displayTitle == "My oil Shorts" && model.projectListRevision == revision + 1,
                     "Rename must trim the name and refresh the project card")
        let renamed = try store.load(ProjectData.self, key: "project")
        precondition(renamed?.displayTitle == "My oil Shorts", "Rename must persist")
        model.renameProject(at: root.path, to: "   ")
        precondition(model.project?.title == "My oil Shorts", "A blank name must not replace the project name")
        print("PASS rename the open project: trimmed, saved, kept after later saves, blank names ignored")
        let beforeTrash = model.project!
        let beforeTrashHistory = model.editHistory
        model.deleteProject(at: root.path, moveToTrash: { _ in throw CocoaError(.fileWriteNoPermission) })
        precondition(model.project?.id == beforeTrash.id && model.project?.segments == beforeTrash.segments
                     && model.projectURL == root && model.editHistory == beforeTrashHistory && model.message.hasPrefix("Could not delete project:"),
                     "A failed Trash operation must keep the current project and undo history")
        try model.save()
        print("PASS failed Trash keeps the open project editable with its history")
        precondition(model.lastExportFolder != nil)
        model.open(root)
        precondition(model.project != nil && model.lastExportFolder == nil, "Opening a project must forget the previous project's export folder")
        precondition(model.editHistory.isEmpty && model.redoHistory.isEmpty, "Opening a project must clear Undo and Redo")
        print("PASS opening a project resets where Exports points")
        let managedVideo = root.appendingPathComponent("Media/clip.mov")
        try FileManager.default.createDirectory(at: managedVideo.deletingLastPathComponent(), withIntermediateDirectories: true)
        try await ShortMaker.copySource(source, to: managedVideo)
        model.project?.media[0].path = "C:\\Prism\\Library\\Example.relio\\Media\\clip.mov"
        try model.save()
        model.open(root)
        precondition(model.project?.media[0].path == managedVideo.path && model.project?.media[0].name == "clip.mov",
                     "Projects copied from Windows must resolve their managed media on macOS")
        precondition(MediaItem.fileName(in: "C:\\Thumbnails\\poster.jpg") == "poster.jpg")
        print("PASS Windows project paths resolve to managed media on macOS")
        // Folding: the real Captions panel, rendered off screen, gets shorter when its sections fold and keeps the chosen style.
        let folded = EditSegment(mediaID: media.id, start: 3, duration: 1, captions: (0..<6).map { TimedCaption(text: "Caption line \($0)", start: Double($0) * 0.15, duration: 0.15) })
        _ = try model.appendGeneratedShorts([folded])
        model.previewShortID = folded.id
        func panelHeight(textFolded: Bool, styleFolded: Bool) -> CGFloat {
            UserDefaults.standard.set(textFolded, forKey: "editor.captionTextCollapsed")
            UserDefaults.standard.set(styleFolded, forKey: "editor.captionStyleCollapsed")
            let renderer = ImageRenderer(content: EditorCaptionsPanel(model: model).frame(width: 300).padding(14).background(Prism.surface1))
            renderer.scale = 2
            // PRISM_RENDER_DIR keeps the renders for a look at the real layout.
            if let directory = ProcessInfo.processInfo.environment["PRISM_RENDER_DIR"], let image = renderer.nsImage,
               let tiff = image.tiffRepresentation, let png = NSBitmapImageRep(data: tiff)?.representation(using: .png, properties: [:]) {
                try? png.write(to: URL(fileURLWithPath: directory).appendingPathComponent("captions-\(textFolded ? "text-folded" : "text-open")-\(styleFolded ? "style-folded" : "style-open").png"))
            }
            return (renderer.nsImage?.size.height ?? 0) / 1
        }
        let open = panelHeight(textFolded: false, styleFolded: false)
        let textFolded = panelHeight(textFolded: true, styleFolded: false)
        let bothFolded = panelHeight(textFolded: true, styleFolded: true)
        precondition(open > 0 && textFolded < open - 150 && bothFolded < textFolded - 150,
                     "Folding must shrink the panel: open \(open), caption text folded \(textFolded), both folded \(bothFolded)")
        UserDefaults.standard.removeObject(forKey: "editor.captionTextCollapsed")
        UserDefaults.standard.removeObject(forKey: "editor.captionStyleCollapsed")
        print("PASS folding: Caption text and Caption style fold the real panel small and open it big (\(Int(open)) → \(Int(textFolded)) → \(Int(bothFolded)) pt)")
        // The media panel's Shorts and Main video sections fold too.
        func binImage(shortsFolded: Bool, videoFolded: Bool) -> NSImage? {
            UserDefaults.standard.set(shortsFolded, forKey: "editor.shortsCollapsed")
            UserDefaults.standard.set(videoFolded, forKey: "editor.mainVideoCollapsed")
            let renderer = ImageRenderer(content: VStack(alignment: .leading, spacing: 16) { EditorMediaBin(model: model).shortsContent }
                .frame(width: 300).padding(14).background(Prism.surface1))
            renderer.scale = 2
            if let directory = ProcessInfo.processInfo.environment["PRISM_RENDER_DIR"], let image = renderer.nsImage,
               let tiff = image.tiffRepresentation, let png = NSBitmapImageRep(data: tiff)?.representation(using: .png, properties: [:]) {
                try? png.write(to: URL(fileURLWithPath: directory).appendingPathComponent("media-\(shortsFolded ? "shorts-folded" : "shorts-open")-\(videoFolded ? "video-folded" : "video-open").png"))
            }
            return renderer.nsImage
        }
        let binOpen = binImage(shortsFolded: false, videoFolded: false)?.size.height ?? 0
        let shortsOnlyFolded = binImage(shortsFolded: true, videoFolded: false)?.size.height ?? 0
        let binFolded = binImage(shortsFolded: true, videoFolded: true)?.size.height ?? 0
        precondition(binOpen > 0 && shortsOnlyFolded < binOpen - 50 && binFolded < shortsOnlyFolded - 50,
                     "Folding Shorts and Main video must hide their cards: \(binOpen) → \(shortsOnlyFolded) → \(binFolded)")
        UserDefaults.standard.removeObject(forKey: "editor.shortsCollapsed")
        UserDefaults.standard.removeObject(forKey: "editor.mainVideoCollapsed")
        print("PASS folding: Shorts and Main video fold their cards away in the real media panel (\(Int(binOpen)) → \(Int(shortsOnlyFolded)) → \(Int(binFolded)) pt)")
        // A live click: the real Shorts panel in a window, clicked with mouse events at its fold headings.
        _ = NSApplication.shared
        UserDefaults.standard.set(false, forKey: "editor.shortsCollapsed")
        UserDefaults.standard.set(false, forKey: "editor.mainVideoCollapsed")
        // The whole left panel, as the editor shows it, so its remembered fold settings drive what is drawn.
        let host = NSHostingView(rootView: EditorMediaBin(model: model).frame(width: 300, height: 900))
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 300, height: 900), styleMask: [.borderless], backing: .buffered, defer: false)
        window.contentView = host
        window.orderFront(nil)
        func settle() { RunLoop.main.run(until: Date().addingTimeInterval(0.5)) }
        /// Clicks a point given from the panel's top-left corner, as a person would with the mouse.
        func click(x: CGFloat, fromTop y: CGFloat) {
            let point = NSPoint(x: x, y: window.frame.height - y)
            for type in [NSEvent.EventType.leftMouseDown, .leftMouseUp] {
                if let event = NSEvent.mouseEvent(with: type, location: point, modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime,
                                                  windowNumber: window.windowNumber, context: nil, eventNumber: 0, clickCount: 1, pressure: 1) {
                    window.sendEvent(event)
                }
            }
            settle()
        }
        /// Walks the clicks down a strip until `key` flips, which is where that heading is; nil when none lands on it.
        func headingRow(_ key: String, from top: CGFloat, to bottom: CGFloat, upward: Bool = false) -> CGFloat? {
            for y in upward ? Array(stride(from: bottom, through: top, by: -5)) : Array(stride(from: top, through: bottom, by: 5)) {
                click(x: 40, fromTop: y)
                if UserDefaults.standard.bool(forKey: key) { return y }
            }
            return nil
        }
        func snapshot(_ name: String) {
            guard let directory = ProcessInfo.processInfo.environment["PRISM_RENDER_DIR"], let view = window.contentView,
                  let rep = view.bitmapImageRepForCachingDisplay(in: view.bounds) else { return }
            view.cacheDisplay(in: view.bounds, to: rep)
            try? rep.representation(using: .png, properties: [:])?.write(to: URL(fileURLWithPath: directory).appendingPathComponent(name))
        }
        settle()
        snapshot("live-open.png")
        guard let shortsRow = headingRow("editor.shortsCollapsed", from: 5, to: 160) else { preconditionFailure("Clicking the Shorts heading must fold Shorts") }
        snapshot("live-shorts-folded.png")
        click(x: 40, fromTop: shortsRow)
        precondition(!UserDefaults.standard.bool(forKey: "editor.shortsCollapsed"), "Clicking the Shorts heading again must open Shorts")
        click(x: 40, fromTop: shortsRow)
        guard let videoRow = headingRow("editor.mainVideoCollapsed", from: shortsRow + 20, to: shortsRow + 160) else { preconditionFailure("Clicking the Main video heading must fold it") }
        snapshot("live-both-folded.png")
        // The right sidebar's captions: the Caption style and Caption text headings, clicked the same way.
        UserDefaults.standard.set(false, forKey: "editor.captionStyleCollapsed")
        UserDefaults.standard.set(false, forKey: "editor.captionTextCollapsed")
        window.contentView = NSHostingView(rootView: VStack(alignment: .leading, spacing: 16) { EditorCaptionsPanel(model: model) }
            .padding(14).frame(width: 300, height: 900, alignment: .top))
        settle()
        guard let styleRow = headingRow("editor.captionStyleCollapsed", from: 5, to: 160) else { preconditionFailure("Clicking the Caption style heading must fold it") }
        // Upward from below, so the clicks cross only caption lines, never the Position, Size or Pop-in controls above.
        let layout = (model.activeSegment?.captionPosition, model.activeSegment?.captionSize, model.activeSegment?.captionAnimated)
        guard let textRow = headingRow("editor.captionTextCollapsed", from: styleRow + 200, to: styleRow + 420, upward: true) else { preconditionFailure("Clicking the Caption text heading must fold it") }
        precondition(model.activeSegment?.captionPosition == layout.0 && model.activeSegment?.captionSize == layout.1 && model.activeSegment?.captionAnimated == layout.2,
                     "Finding the heading must not change the caption layout")
        snapshot("live-captions-folded.png")
        click(x: 40, fromTop: textRow)
        precondition(!UserDefaults.standard.bool(forKey: "editor.captionTextCollapsed"), "Clicking Caption text again must open it")
        UserDefaults.standard.removeObject(forKey: "editor.captionStyleCollapsed")
        UserDefaults.standard.removeObject(forKey: "editor.captionTextCollapsed")
        window.orderOut(nil)
        UserDefaults.standard.removeObject(forKey: "editor.shortsCollapsed")
        UserDefaults.standard.removeObject(forKey: "editor.mainVideoCollapsed")
        print("PASS folding: mouse clicks on all four headings fold and open them in a live window (Shorts \(Int(shortsRow)), Main video \(Int(videoRow)), Caption style \(Int(styleRow)), Caption text \(Int(textRow)) pt)")
        print("This tests model actions directly; it does not automate desktop clicks.")
    }
    @MainActor static func waitForPreview(_ model: AppModel) async {
        let deadline = Date().addingTimeInterval(30)
        while model.isPreviewLoading && Date() < deadline { try? await Task.sleep(for: .milliseconds(100)) }
        precondition(!model.isPreviewLoading && model.previewError == nil, model.previewError ?? "Preview timed out")
    }
}
