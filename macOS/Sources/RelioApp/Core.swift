import Foundation
import AVFoundation
import AppKit
import CSQLite
import Darwin.Mach
import CryptoKit

struct MediaItem: Identifiable, Codable, Hashable {
    var id: UUID = UUID()
    var path: String
    var kind: String
    var duration: Double = 0
    var width: Int = 0
    var height: Int = 0
    var thumbnail: String? = nil
    var hasAudio: Bool? = nil
    var note: String = ""
    var priority: Int = 50
    var created: Date = .now
    var name: String { Self.fileName(in: path) }
    static func fileName(in path: String) -> String { path.replacingOccurrences(of: "\\", with: "/").split(separator: "/").last.map(String.init) ?? "" }
}

struct EditSegment: Identifiable, Codable, Hashable {
    var id: UUID = UUID()
    var mediaID: UUID
    var start: Double = 0
    var duration: Double
    var caption: String = ""
    var isMuted: Bool? = false
    var captionStart: Double? = 0
    var captionDuration: Double? = nil
    var fitToFrame: Bool? = nil
    var captions: [TimedCaption]? = nil
    var cropZoom: Double? = 1.08
    /// Horizontal crop center as a fraction of the available pan range (0 = left, 0.5 = center, 1 = right).
    var cropPosition: Double? = 0.5
    /// Time-stamped horizontal framing positions; nil means the path has not been analyzed yet.
    var cropKeyframes: [CropKeyframe]? = nil
    /// Tracker algorithm version used to create cropKeyframes; old paths are regenerated on next preview/export.
    var cropTrackingVersion: Int? = nil
    /// Prism AI word timings, relative to this Short, used to keep trims from clipping speech.
    var speechWords: [TimedSpeechWord]? = nil

    var suggestedTitle: String? = nil
    var selectionReason: String? = nil
    /// Prism AI's rating of this Short, 0–100; nil for Shorts added by hand or made before scores were kept.
    var score: Int? = nil
    /// The kind of video this Short was cut from, as chosen or detected; Auto captions pick their style from it.
    var videoType: VideoType? = nil
    var captionNotice: String? = nil
    var captionStyle: CaptionStyle? = nil
    /// Where subtitles sit; nil is the bottom.
    var captionPosition: CaptionPosition? = nil
    /// Subtitle size; nil is medium.
    var captionSize: CaptionSize? = nil
    /// New subtitle text pops in with a quick scale bounce.
    var captionAnimated: Bool? = nil
    /// Two-person layout: the source's left half fills the top of the Short, its right half the bottom.
    var splitScreen: Bool? = nil
    /// Horizontal centers (0–1) of the top and bottom speakers in the source; nil uses the left and right quarters.
    var splitCenters: [Double]? = nil

    private enum CodingKeys: String, CodingKey {
        case id, mediaID, start, duration, caption, isMuted, captionStart, captionDuration
        case fitToFrame, captions, cropZoom, cropPosition, cropKeyframes, cropTrackingVersion, speechWords, suggestedTitle, selectionReason, captionNotice, captionStyle
        case captionPosition, captionSize, captionAnimated, splitScreen, splitCenters, score, videoType
    }

    init(id: UUID = UUID(), mediaID: UUID, start: Double = 0, duration: Double, caption: String = "",
         isMuted: Bool? = false, captionStart: Double? = 0, captionDuration: Double? = nil,
         fitToFrame: Bool? = nil, captions: [TimedCaption]? = nil, cropZoom: Double? = 1.08,
         cropPosition: Double? = 0.5, cropKeyframes: [CropKeyframe]? = nil, cropTrackingVersion: Int? = nil, speechWords: [TimedSpeechWord]? = nil,
         suggestedTitle: String? = nil, selectionReason: String? = nil, captionNotice: String? = nil, captionStyle: CaptionStyle? = nil) {
        self.id = id; self.mediaID = mediaID; self.start = start; self.duration = duration; self.caption = caption
        self.isMuted = isMuted; self.captionStart = captionStart; self.captionDuration = captionDuration
        self.fitToFrame = fitToFrame; self.captions = captions; self.cropZoom = cropZoom; self.cropPosition = cropPosition
        self.cropKeyframes = cropKeyframes
        self.cropTrackingVersion = cropTrackingVersion
        self.speechWords = speechWords
        self.suggestedTitle = suggestedTitle; self.selectionReason = selectionReason; self.captionNotice = captionNotice
        self.captionStyle = captionStyle
    }

    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        id = try values.decodeIfPresent(UUID.self, forKey: .id) ?? UUID()
        mediaID = try values.decode(UUID.self, forKey: .mediaID)
        start = try values.decodeIfPresent(Double.self, forKey: .start) ?? 0
        duration = try values.decode(Double.self, forKey: .duration)
        caption = try values.decodeIfPresent(String.self, forKey: .caption) ?? ""
        isMuted = try values.decodeIfPresent(Bool.self, forKey: .isMuted) ?? false
        captionStart = try values.decodeIfPresent(Double.self, forKey: .captionStart) ?? 0
        captionDuration = try values.decodeIfPresent(Double.self, forKey: .captionDuration)
        fitToFrame = try values.decodeIfPresent(Bool.self, forKey: .fitToFrame)
        captions = try values.decodeIfPresent([TimedCaption].self, forKey: .captions)
        cropZoom = try values.decodeIfPresent(Double.self, forKey: .cropZoom) ?? 1.08
        cropPosition = try values.decodeIfPresent(Double.self, forKey: .cropPosition) ?? 0.5
        cropKeyframes = try values.decodeIfPresent([CropKeyframe].self, forKey: .cropKeyframes)
        cropTrackingVersion = try values.decodeIfPresent(Int.self, forKey: .cropTrackingVersion)
        speechWords = try values.decodeIfPresent([TimedSpeechWord].self, forKey: .speechWords)
        suggestedTitle = try values.decodeIfPresent(String.self, forKey: .suggestedTitle)
        selectionReason = try values.decodeIfPresent(String.self, forKey: .selectionReason)
        captionNotice = try values.decodeIfPresent(String.self, forKey: .captionNotice)
        captionPosition = try values.decodeIfPresent(CaptionPosition.self, forKey: .captionPosition)
        captionSize = try values.decodeIfPresent(CaptionSize.self, forKey: .captionSize)
        captionAnimated = try values.decodeIfPresent(Bool.self, forKey: .captionAnimated)
        captionStyle = try values.decodeIfPresent(CaptionStyle.self, forKey: .captionStyle)
        splitScreen = try values.decodeIfPresent(Bool.self, forKey: .splitScreen)
        splitCenters = try values.decodeIfPresent([Double].self, forKey: .splitCenters)
        score = try values.decodeIfPresent(Int.self, forKey: .score)
        videoType = try? values.decodeIfPresent(VideoType.self, forKey: .videoType)
    }

    /// The style captions are drawn in: Auto becomes the style that fits this Short's video.
    var resolvedCaptionStyle: CaptionStyle { (captionStyle ?? .classic).resolved(for: videoType, splitScreen: splitScreen == true) }
    /// New caption pages pop in; unless set, the lively word-by-word styles pop and the calm ones don't.
    var captionPops: Bool { captionAnimated ?? [.viral, .boldCaps, .oneWord, .highlightBox].contains(resolvedCaptionStyle) }
}

/// A Home-screen folder: a name and the project folders inside it. Projects stay where they are on disk.
struct ProjectFolder: Codable, Identifiable, Hashable {
    var id = UUID()
    var name: String
    var projectPaths: [String] = []
}

struct CropKeyframe: Codable, Hashable {
    var time: Double
    var position: Double
    /// A source edit boundary: hold the previous framing until this time, then switch.
    var isSceneCut: Bool? = nil
    var preserveWholeFrame: Bool? = nil
}

struct SourceInterval: Sendable {
    let start: Double
    let end: Double
}

struct TimedCaption: Codable, Hashable {
    var text: String
    var start: Double
    var duration: Double
}

struct TimedSpeechWord: Codable, Hashable {
    var text: String
    var start: Double
    var duration: Double
}

enum CaptionStyle: String, Codable, CaseIterable, Identifiable {
    /// Picks the style that fits the video; see `resolved(for:splitScreen:)`.
    case auto
    case classic
    case viral
    /// Retired boxed style. Kept so saved projects still decode; it renders as Simple.
    case clean
    case highlightBox
    case boldCaps
    case minimal
    case oneWord
    case podcast

    static let allCases: [CaptionStyle] = [.auto, .viral, .highlightBox, .boldCaps, .oneWord, .podcast, .classic, .minimal]
    var id: String { rawValue }
    /// Old projects saved the retired boxed style; it is shown and drawn as Simple. Auto without a video is Viral highlight.
    var resolved: CaptionStyle { resolved(for: nil, splitScreen: false) }
    /// Auto's pick: green-word captions for conversations, big caps for games, a calm band over screens, and the
    /// word-by-word yellow highlight that holds viewers on everything else.
    func resolved(for videoType: VideoType?, splitScreen: Bool) -> CaptionStyle {
        switch self {
        case .clean: return .classic
        case .auto:
            if splitScreen || videoType == .podcast { return .podcast }
            switch videoType {
            case .gaming: return .boldCaps
            case .tutorial: return .minimal
            default: return .viral
            }
        default: return self
        }
    }
    var title: String {
        switch self {
        case .auto: "Auto"
        case .classic, .clean: "Simple"
        case .viral: "Viral highlight"
        case .highlightBox: "Highlight box"
        case .boldCaps: "Bold caps"
        case .minimal: "Minimal"
        case .oneWord: "One word"
        case .podcast: "Podcast"
        }
    }
    var detail: String {
        switch self {
        case .auto: "Prism picks the style that fits this video."
        case .classic, .clean: "Short lines of white text with a bold outline."
        case .viral: "Three words at a time; the spoken word turns yellow."
        case .highlightBox: "The spoken word sits on a bright box."
        case .boldCaps: "Huge all-caps text, two words at a time."
        case .minimal: "Calm text on a soft dark band."
        case .oneWord: "One big word at a time."
        case .podcast: "Soft-shadowed text; the spoken word turns green."
        }
    }
    /// Styles that follow each spoken word need exact word timing; without it the timing is estimated from sentences.
    var usesWordTiming: Bool { [.auto, .viral, .highlightBox, .boldCaps, .oneWord, .podcast].contains(self) }
    /// Styles that color the word being spoken.
    var highlightsWords: Bool { [.viral, .highlightBox, .podcast].contains(self) }
}

enum CaptionPosition: String, Codable, CaseIterable, Identifiable {
    case top, middle, bottom
    var id: String { rawValue }
    var title: String { rawValue.capitalized }
    /// Center line of the captions in the 1080×1920 frame (origin at the bottom). Bottom sits above the caption,
    /// buttons and progress bar that TikTok, Reels and Shorts draw over the lowest quarter of the video.
    var centerY: CGFloat { switch self { case .top: 1520; case .middle: 960; case .bottom: 620 } }
}

enum CaptionSize: String, Codable, CaseIterable, Identifiable {
    case small, medium, large
    var id: String { rawValue }
    var title: String { rawValue.capitalized }
    var scale: CGFloat { switch self { case .small: 0.8; case .medium: 1; case .large: 1.25 } }
}

/// What kind of video a Short is cut from. It steers what the AI looks for, the layout and the default subtitles.
enum VideoType: String, Codable, CaseIterable, Identifiable {
    case auto, general, informational, podcast, tutorial, vlog, gaming
    var id: String { rawValue }
    var title: String {
        switch self {
        case .auto: "Auto-detect"
        case .general: "Any video"
        case .informational: "Informational / explainer"
        case .podcast: "Podcast / interview"
        case .tutorial: "Tutorial / screen"
        case .vlog: "Vlog / talking head"
        case .gaming: "Gaming / stream"
        }
    }
    var detail: String {
        switch self {
        case .auto: "Prism decides from what is said in the video."
        case .general: "No special rules. Good for mixed content."
        case .informational: "Facts and explanations. Each Short keeps one idea with its setup and payoff."
        case .podcast: "Two people talking. Split screen: one person on top, one on the bottom, captions in the middle."
        case .tutorial: "Screen recordings and lessons. The whole screen stays visible."
        case .vlog: "One person talking to camera. The crop follows them."
        case .gaming: "Gameplay and streams. The whole game stays visible."
        }
    }
    var icon: String {
        switch self {
        case .auto: "sparkles"
        case .general: "film"
        case .informational: "lightbulb"
        case .podcast: "person.2"
        case .tutorial: "display"
        case .vlog: "person.crop.square"
        case .gaming: "gamecontroller"
        }
    }
    /// Screen recordings and gameplay lose their edges in a vertical crop, so they always show the whole frame.
    var forcesFit: Bool { self == .tutorial || self == .gaming }
    /// Added to the AI's instructions: what makes a strong Short for this kind of video.
    var selectionGuidance: String {
        switch self {
        case .auto, .general: ""
        case .informational: "This is an informational or explainer video. Favor one clear fact, insight or explanation per clip, with the setup that makes it understandable and its payoff. Prefer the 'track' layout on the speaker."
        case .podcast: "This is a podcast or interview. Favor strong opinions, surprising answers, complete stories and quotable lines; keep the question when the answer needs it. Prefer the 'track' layout so the speaker stays in frame."
        case .tutorial: "This is a tutorial or screen recording. Favor one complete step, tip or result per clip, including what it achieves. Use the 'fit' layout so the whole screen stays readable."
        case .vlog: "This is a vlog or talking-head video. Favor clear hooks, personal moments, reactions and payoffs told to camera. Prefer the 'track' layout on the person."
        case .gaming: "This is gameplay or a stream. Favor wins, fails, clutch plays, funny reactions and hype moments, with enough lead-up to understand them. Use the 'fit' layout so the game and facecam stay visible."
        }
    }
}

/// Prism AI's sentence transcript of one source range.
struct SentenceTranscript: Codable, Sendable {
    var start: Double
    var end: Double
    var cues: [TimedCaption]

    /// The cues inside `interval`, or nil when this transcript doesn't cover all of it.
    func cues(covering interval: (start: Double, end: Double)) -> [TimedCaption]? {
        guard start <= interval.start + 0.01, end >= interval.end - 0.01 else { return nil }
        return cues.filter { $0.start >= interval.start - 0.001 && $0.start + $0.duration <= interval.end + 0.001 }
    }
}

struct ProjectData: Codable {
    var id: UUID = UUID()
    var name: String
    var media: [MediaItem] = []
    var segments: [EditSegment] = []
    var memory: String = ""
    var created: Date = .now
    /// A name the person chose; older projects have none.
    var title: String? = nil
    /// Cloud sentence transcripts by media ID, so later runs on the same video skip transcription.
    var transcripts: [String: SentenceTranscript]? = nil

    /// What people see: their chosen name, else the first Short's title, else the video's name, else the dated folder name.
    var displayTitle: String {
        if let title, !title.isEmpty { return title }
        if let clipTitle = segments.first(where: { $0.suggestedTitle?.isEmpty == false })?.suggestedTitle { return clipTitle }
        if let video = media.first(where: { $0.kind == "video" }) { return URL(fileURLWithPath: video.name).deletingPathExtension().lastPathComponent }
        return name
    }
}

struct MachineProfile {
    let memoryGB: Int
    let memoryUsedGB: Double
    let cpu: String
    let os: String
    let freeGB: Int
    let storageGB: Int
    let isAppleSilicon: Bool
    var memoryUsage: Double { min(1, max(0, memoryUsedGB / Double(max(memoryGB, 1)))) }
    var freeStorageRatio: Double { min(1, max(0, Double(freeGB) / Double(max(storageGB, 1)))) }
    var tier: String {
        memoryGB >= 24 ? "Relio AI Pro" : memoryGB >= 16 ? "Relio AI Standard" : "Relio AI Lite"
    }
    static func detect() -> Self {
        let bytes = ProcessInfo.processInfo.physicalMemory
        let totalMemoryGB = Int((Double(bytes) / 1_073_741_824).rounded())
        let storage = try? URL(fileURLWithPath: NSHomeDirectory()).resourceValues(forKeys: [.volumeAvailableCapacityForImportantUsageKey, .volumeTotalCapacityKey])
        let freeBytes = max(0, storage?.volumeAvailableCapacityForImportantUsage ?? 0)
        let storageBytes = max(0, storage?.volumeTotalCapacity ?? 0)
        return .init(
            memoryGB: totalMemoryGB,
            memoryUsedGB: usedMemoryGB(totalBytes: bytes),
            cpu: ProcessInfo.processInfo.processorCount.description + " cores",
            os: ProcessInfo.processInfo.operatingSystemVersionString,
            freeGB: Int(freeBytes / 1_073_741_824),
            storageGB: Int(storageBytes / 1_073_741_824),
            isAppleSilicon: Self.detectAppleSilicon()
        )
    }

    private static func detectAppleSilicon() -> Bool {
        var arm64: Int32 = 0
        var size = MemoryLayout<Int32>.size
        return sysctlbyname("hw.optional.arm64", &arm64, &size, nil, 0) == 0 && arm64 == 1
    }

    private static func usedMemoryGB(totalBytes: UInt64) -> Double {
        var statistics = vm_statistics64()
        var count = mach_msg_type_number_t(MemoryLayout<vm_statistics64_data_t>.size / MemoryLayout<integer_t>.size)
        let result = withUnsafeMutablePointer(to: &statistics) { pointer in
            pointer.withMemoryRebound(to: integer_t.self, capacity: Int(count)) {
                host_statistics64(mach_host_self(), HOST_VM_INFO64, $0, &count)
            }
        }
        guard result == KERN_SUCCESS else { return 0 }
        // Activity Monitor's "Memory Used": app memory, wired and compressed. File cache is free for the taking,
        // so counting it as used showed nearly every Mac at 95–99%.
        let pageSize = UInt64(getpagesize())
        let appPages = UInt64(statistics.internal_page_count) - min(UInt64(statistics.internal_page_count), UInt64(statistics.purgeable_count))
        let usedBytes = (appPages + UInt64(statistics.wire_count) + UInt64(statistics.compressor_page_count)) * pageSize
        return min(Double(totalBytes) / 1_073_741_824, Double(usedBytes) / 1_073_741_824)
    }
}

final class ProjectStore {
    let root: URL
    private var db: OpaquePointer?
    /// `create: false` opens only an existing project, so reading a moved, deleted or wrong folder never leaves a database behind.
    init(root: URL, create: Bool = true) throws {
        self.root = root
        let file = root.appendingPathComponent("project.sqlite").path
        if create {
            try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        } else if !FileManager.default.fileExists(atPath: file) {
            throw StoreError.notAProject
        }
        guard sqlite3_open_v2(file, &db, SQLITE_OPEN_READWRITE | (create ? SQLITE_OPEN_CREATE : 0), nil) == SQLITE_OK else {
            sqlite3_close(db); db = nil
            throw StoreError.database
        }
        do {
            try execute("PRAGMA journal_mode=WAL")
            if create { try execute("CREATE TABLE IF NOT EXISTS state (key TEXT PRIMARY KEY, value BLOB NOT NULL)") }
        } catch {
            sqlite3_close(db); db = nil
            throw error
        }
    }
    deinit { sqlite3_close(db) }
    enum StoreError: LocalizedError {
        case database, notAProject
        var errorDescription: String? {
            switch self {
            case .database: "The project database could not be read or saved."
            case .notAProject: "This folder is not a Prism project."
            }
        }
    }
    private func execute(_ sql: String) throws {
        guard sqlite3_exec(db, sql, nil, nil, nil) == SQLITE_OK else { throw StoreError.database }
    }
    func save<T: Encodable>(_ value: T, key: String) throws {
        let data = try JSONEncoder().encode(value)
        var statement: OpaquePointer?
        defer { sqlite3_finalize(statement) }
        guard sqlite3_prepare_v2(db, "INSERT OR REPLACE INTO state(key,value) VALUES(?,?)", -1, &statement, nil) == SQLITE_OK else { throw StoreError.database }
        sqlite3_bind_text(statement, 1, key, -1, unsafeBitCast(-1, to: sqlite3_destructor_type.self))
        _ = data.withUnsafeBytes { bytes in sqlite3_bind_blob(statement, 2, bytes.baseAddress, Int32(data.count), unsafeBitCast(-1, to: sqlite3_destructor_type.self)) }
        guard sqlite3_step(statement) == SQLITE_DONE else { throw StoreError.database }
    }
    func load<T: Decodable>(_ type: T.Type, key: String) throws -> T? {
        var statement: OpaquePointer?
        defer { sqlite3_finalize(statement) }
        guard sqlite3_prepare_v2(db, "SELECT value FROM state WHERE key=?", -1, &statement, nil) == SQLITE_OK else { throw StoreError.database }
        sqlite3_bind_text(statement, 1, key, -1, unsafeBitCast(-1, to: sqlite3_destructor_type.self))
        let result = sqlite3_step(statement)
        if result == SQLITE_DONE { return nil }
        guard result == SQLITE_ROW, let bytes = sqlite3_column_blob(statement, 0) else { throw StoreError.database }
        return try JSONDecoder().decode(T.self, from: Data(bytes: bytes, count: Int(sqlite3_column_bytes(statement, 0))))
    }
}

enum MediaEngine {
    static func inspect(_ url: URL, thumbnailDirectory: URL) async -> MediaItem? {
        let ext = url.pathExtension.lowercased()
        let kind = ["mov", "mp4", "m4v", "avi"].contains(ext) ? "video" : (["jpg", "jpeg", "png", "heic", "tiff"].contains(ext) ? "photo" : (["mp3", "wav", "m4a", "aiff"].contains(ext) ? "audio" : ""))
        guard !kind.isEmpty else { return nil }
        var item = MediaItem(path: url.path, kind: kind)
        if kind == "video" || kind == "audio" {
            let asset = AVURLAsset(url: url)
            item.duration = (try? await asset.load(.duration).seconds) ?? 0
            if kind == "video" {
                item.hasAudio = (try? await asset.loadTracks(withMediaType: .audio))?.isEmpty == false
                if let track = try? await asset.loadTracks(withMediaType: .video).first {
                    let size = (try? await track.load(.naturalSize)) ?? .zero
                    let transform = (try? await track.load(.preferredTransform)) ?? .identity
                    let bounds = CGRect(origin: .zero, size: size).applying(transform)
                    item.width = Int(abs(bounds.width)); item.height = Int(abs(bounds.height))
                }
                let generator = AVAssetImageGenerator(asset: asset)
                generator.appliesPreferredTrackTransform = true
                // A few seconds in, past the black frame or fade most videos open with.
                if let cg = try? generator.copyCGImage(at: CMTime(seconds: min(item.duration / 2, 3), preferredTimescale: 600), actualTime: nil) {
                    item.thumbnail = saveThumbnail(NSImage(cgImage: cg, size: .zero), id: item.id, directory: thumbnailDirectory)
                }
            }
        } else if let image = NSImage(contentsOf: url) {
            item.width = Int(image.size.width); item.height = Int(image.size.height)
            item.thumbnail = saveThumbnail(image, id: item.id, directory: thumbnailDirectory)
            if min(item.width, item.height) < 720 { item.priority = 25; item.note = "Low resolution · low priority" }
        }
        if kind == "video", (!item.duration.isFinite || item.duration <= 0 || item.width <= 0 || item.height <= 0) { return nil }
        return item
    }
    private static func saveThumbnail(_ image: NSImage, id: UUID, directory: URL) -> String? {
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        guard let tiff = image.tiffRepresentation, let rep = NSBitmapImageRep(data: tiff), let data = rep.representation(using: .jpeg, properties: [.compressionFactor: 0.7]) else { return nil }
        let path = directory.appendingPathComponent("\(id).jpg")
        try? data.write(to: path, options: .atomic)
        return path.path
    }
}

/// How much video Shorts can be made from: 60 minutes a calendar day and 300 a week. A video already counted that day
/// or week costs nothing extra, and a run that makes no Shorts isn't counted. Each video counts once, at its length.
// shortcut: counted on this Mac in UserDefaults; the account's copy in Supabase decides when signed in.
enum UsageLimit {
    static let perDayMinutes = 60.0
    static let perWeekMinutes = 300.0
    static let storageKey = "usage.videos"

    struct Entry: Codable, Equatable {
        var video: String
        var date: Date
        var minutes: Double
    }

    /// Two imports of the same file count as one video.
    static func videoKey(_ media: MediaItem) -> String { "\(media.name)|\(Int(media.duration.rounded()))" }
    /// What Supabase stores: a SHA-256 of the video key, so the file name never leaves the Mac.
    static func serverKey(_ media: MediaItem) -> String {
        SHA256.hash(data: Data(videoKey(media).utf8)).map { String(format: "%02x", $0) }.joined()
    }
    static func minutes(of media: MediaItem) -> Double { media.duration / 60 }

    static func load() -> [Entry] {
        (UserDefaults.standard.data(forKey: storageKey)).flatMap { try? JSONDecoder().decode([Entry].self, from: $0) } ?? []
    }

    /// Minutes of different videos used in the day or week that contains `now`.
    static func used(_ period: Calendar.Component, entries: [Entry], now: Date = .now, calendar: Calendar = .current) -> Double {
        var longest: [String: Double] = [:]
        for entry in entries where calendar.isDate(entry.date, equalTo: now, toGranularity: period) {
            longest[entry.video] = max(longest[entry.video] ?? 0, entry.minutes)
        }
        return longest.values.reduce(0, +)
    }

    /// Why a video of `minutes` length can't be used now, or nil when it can.
    static func refusal(for video: String, minutes: Double, entries: [Entry], now: Date = .now, calendar: Calendar = .current) -> String? {
        func counted(_ period: Calendar.Component) -> Bool {
            entries.contains { $0.video == video && calendar.isDate($0.date, equalTo: now, toGranularity: period) }
        }
        if !counted(.weekOfYear), used(.weekOfYear, entries: entries, now: now, calendar: calendar) + minutes > perWeekMinutes {
            let reset = calendar.dateInterval(of: .weekOfYear, for: now)?.end ?? now
            return "You've reached your weekly limit of \(Int(perWeekMinutes)) minutes of video. You can start new videos again \(reset.formatted(.dateTime.weekday(.wide)))."
        }
        if !counted(.day), used(.day, entries: entries, now: now, calendar: calendar) + minutes > perDayMinutes {
            return "You've reached your daily limit of \(Int(perDayMinutes)) minutes of video. You can start new videos again tomorrow."
        }
        return nil
    }

    /// Counts `video` once for today; entries older than two weeks are dropped.
    static func recorded(_ video: String, minutes: Double, in entries: [Entry], now: Date = .now, calendar: Calendar = .current) -> [Entry] {
        var kept = entries.filter { now.timeIntervalSince($0.date) < 14 * 86_400 }
        if !kept.contains(where: { $0.video == video && calendar.isDate($0.date, inSameDayAs: now) }) {
            kept.append(.init(video: video, date: now, minutes: minutes))
        }
        return kept
    }

    static func record(_ video: String, minutes: Double) {
        UserDefaults.standard.set(try? JSONEncoder().encode(recorded(video, minutes: minutes, in: load())), forKey: storageKey)
    }
}
