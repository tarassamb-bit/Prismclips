import Foundation
import AVFoundation
import CryptoKit
import AppKit
import CoreImage
import CoreText
import os

struct ShortResult {
    let start: Double
    let duration: Double
    let caption: String
    let captions: [TimedCaption]
    let cropKeyframes: [CropKeyframe]
    let speechWords: [TimedSpeechWord]
    var analysisWarning: String? = nil
    var suggestedTitle: String? = nil
    var selectionReason: String? = nil
    var fitToFrame: Bool = false
    /// Prism AI's 0–10 clip score on a 0–100 scale.
    var score: Int? = nil
    /// The kind of video, as chosen or detected for this run.
    var videoType: VideoType? = nil
}

enum CaptionGenerationIssue {
    case noSpeech

    var message: String {
        switch self {
        case .noSpeech:
            "No speech was detected in this Short. Check the audio and spoken language."
        }
    }
}

struct CaptionGenerationResult {
    var cues: [TimedCaption]
    var issue: CaptionGenerationIssue?
    var words: [TimedSpeechWord] = []
    var notice: String? = nil
}

enum ShortMaker {
    enum SourceRegion: String, CaseIterable, Identifiable {
        case entireVideo, firstHalf, lastHalf, custom
        var id: String { rawValue }
        var title: String {
            switch self {
            case .entireVideo: "Entire video"
            case .firstHalf: "First half"
            case .lastHalf: "Last half"
            case .custom: "Custom range"
            }
        }
        func interval(videoDuration: Double, customStart: Double? = nil, customEnd: Double? = nil) throws -> (start: Double, end: Double) {
            guard videoDuration.isFinite, videoDuration > 0 else { throw Failure.invalidRange }
            switch self {
            case .entireVideo: return (0, videoDuration)
            case .firstHalf: return (0, videoDuration / 2)
            case .lastHalf: return (videoDuration / 2, videoDuration)
            case .custom:
                guard let start = customStart, let end = customEnd,
                      start.isFinite, end.isFinite, start >= 0, end > start,
                      end <= videoDuration else { throw Failure.invalidRange }
                return (start, end)
            }
        }
    }

    enum Failure: LocalizedError {
        case noVideo, cannotExport, invalidRange, destinationExists
        var errorDescription: String? {
            switch self {
            case .noVideo: "No playable video track was found."
            case .cannotExport: "The video encoder could not complete the render."
            case .invalidRange: "The edit contains an invalid time range. Choose a range within the source video."
            case .destinationExists: "A file already exists at the export destination. Choose another filename."
            }
        }
    }

    static func analyze(
        _ url: URL,
        requestedDuration: Double,
        count: Int,
        sourceRegion: SourceRegion,
        customStart: Double? = nil,
        customEnd: Double? = nil,
        excluding: [SourceInterval] = [],
        gemini: GeminiConfiguration,
        videoType: VideoType = .general,
        cachedTranscript: SentenceTranscript? = nil,
        onTranscript: @escaping @Sendable (SentenceTranscript) -> Void = { _ in },
        generationProgress: @escaping @Sendable (Double, String) -> Void = { _, _ in }
    ) async throws -> [ShortResult] {
        let asset = AVURLAsset(url: url)
        let duration = try await asset.load(.duration).seconds
        guard duration.isFinite, duration > 0, !(try await asset.loadTracks(withMediaType: .video)).isEmpty else { throw Failure.noVideo }
        let interval = try sourceRegion.interval(videoDuration: duration, customStart: customStart, customEnd: customEnd)
        guard !excluding.contains(where: { $0.start <= interval.start && $0.end >= interval.end }) else { throw GeminiSelection.Failure.noDistinctClips }
        // 0 is Auto length; Prism AI sizes each clip within GeminiSelection.lengthRange.
        let clipDuration = requestedDuration > 0 ? min(max(1, requestedDuration), interval.end - interval.start) : 0
        // A count of 0 means Auto: room for one Short per few minutes, and only clips Prism AI scores as strong fill it.
        let targetCount = count > 0 ? min(count, maxShorts) : autoCount(seconds: interval.end - interval.start)
        let hasAudio = !(try await asset.loadTracks(withMediaType: .audio)).isEmpty
        generationProgress(0, "Preparing audio for Prism AI")
        let transcript: [TimedCaption]
        if !hasAudio {
            transcript = []
        } else if let saved = cachedTranscript?.cues(covering: interval) {
            // Saved by an earlier run on this video: no audio upload and no transcription cost.
            generationProgress(0.55, "Using the saved transcript")
            transcript = saved
        } else {
            // An earlier run that failed partway saved the stretch it finished; only the rest is transcribed again.
            let resumed = cachedTranscript.flatMap { saved -> SentenceTranscript? in
                guard saved.start <= interval.start + 0.01, saved.end > interval.start + 1, saved.end < interval.end else { return nil }
                return saved.cues(covering: (interval.start, saved.end)).map { SentenceTranscript(start: interval.start, end: saved.end, cues: $0) }
            }
            let from = resumed?.end ?? interval.start
            let kept = resumed?.cues ?? []
            let fresh = try await GeminiSelection.transcribeSentences(url: url, interval: (from, interval.end), configuration: gemini, progress: { fraction in
                let overall = (from - interval.start + fraction * (interval.end - from)) / (interval.end - interval.start)
                generationProgress(0.55 * overall, "Prism AI · transcribing audio · \(Int(overall * 100))%")
            }, finished: { cues, end in
                onTranscript(SentenceTranscript(start: interval.start, end: end, cues: kept + cues))
            })
            transcript = kept + fresh
            onTranscript(SentenceTranscript(start: interval.start, end: interval.end, cues: transcript))
        }
        generationProgress(0.55, "Selecting distinct moments")
        var videoType = videoType
        if videoType == .auto {
            generationProgress(0.55, "Prism AI · recognizing the kind of video")
            // Detection reads the transcript; a silent source keeps the general behavior.
            videoType = transcript.isEmpty ? .general : await GeminiSelection.detectVideoType(cues: transcript, configuration: gemini)
            generationProgress(0.55, "Prism AI · \(videoType.title)")
        }
        generationProgress(0.55, "Prism AI · choosing complete stories and layouts")
        let clips = try await GeminiSelection.select(url: url, cues: transcript, interval: interval,
                                                    targetDuration: clipDuration, count: targetCount, configuration: gemini, excluding: excluding,
                                                    guidance: videoType.selectionGuidance, progress: { fraction, stage in
                                                        generationProgress(0.55 + 0.15 * fraction, stage)
                                                    })
        // Auto keeps only strong picks; when Prism AI found none, the single best weaker one beats failing.
        let strong = clips.filter { $0.reason?.hasPrefix("Weaker pick") != true }
        let kept = count > 0 ? clips : (strong.isEmpty ? Array(clips.prefix(1)) : strong)
        var planned = kept.map { (start: $0.start, duration: $0.end - $0.start, fit: $0.layout == "fit", title: $0.title, reason: $0.reason, score: $0.score) }
        // Screens and gameplay lose their edges in a vertical crop, whatever the picker suggested.
        if videoType.forcesFit { planned = planned.map { ($0.start, $0.duration, true, $0.title, $0.reason, $0.score) } }
        let picks = planned
        let sentenceTimingNote = GeminiSelection.sentenceTimingNotice
        let finished = OSAllocatedUnfairLock(initialState: 0)
        let reportStep: @Sendable (String) -> Void = { stage in
            let done = finished.withLock { $0 += 1; return $0 }
            generationProgress(0.70 + 0.29 * min(1, Double(done) / Double(targetCount * 2)), stage)
        }
        // Picks are prepared a wave at a time, side by side: exact boundaries, word timing and the nearest pauses.
        // They are accepted in Prism AI's order; a pick that now overlaps an earlier one gives way to the next backup.
        var accepted: [(candidate: Int, range: PreparedShort)] = []
        var wordAlignmentAvailable = true
        var next = 0
        while accepted.count < targetCount, next < planned.count {
            try Task.checkCancellation()
            let wave = Array(next..<min(planned.count, next + targetCount - accepted.count))
            next += wave.count
            let aligning = wordAlignmentAvailable
            let prepared = try await concurrentMap(wave, limit: parallelRequests) { index in
                let candidate = picks[index]
                let shot = try await prepareShort(url: url, start: candidate.start, duration: candidate.duration, transcript: transcript,
                                                  interval: interval, clipDuration: clipDuration, aligning: aligning, gemini: gemini)
                reportStep("Aligning speech and pauses · Short \(index + 1)")
                return (index, shot)
            }
            for (index, shot) in prepared {
                if shot.alignmentFailed { wordAlignmentAvailable = false }
                guard excluding.allSatisfy({ !TranscriptSelection.overlaps(start: shot.start, duration: shot.duration, otherStart: $0.start, otherDuration: $0.end - $0.start) }),
                      accepted.allSatisfy({ !TranscriptSelection.overlaps(start: shot.start, duration: shot.duration, otherStart: $0.range.start, otherDuration: $0.range.duration) })
                else { continue }
                accepted.append((index, shot))
                if accepted.count == targetCount { break }
            }
        }
        let detectedType = videoType
        let results: [ShortResult] = try await concurrentMap(accepted, limit: parallelRequests) { candidateIndex, shot in
            let candidate = picks[candidateIndex]
            let start = shot.start, actualDuration = shot.duration
            let captionSource = !shot.words.isEmpty ? GeminiSelection.captionCues(shot.words, interval: (start, start + actualDuration)) : TranscriptSelection.sentenceCaptionGroups(shot.referenceCues)
            let captions = captionSource.compactMap { cue -> TimedCaption? in
                let cueEnd = cue.start + cue.duration
                let clipEnd = start + actualDuration
                guard cueEnd > start, cue.start < clipEnd else { return nil }
                let clippedStart = max(0, cue.start - start)
                let clippedEnd = min(actualDuration, cueEnd - start)
                return TimedCaption(text: cue.text, start: clippedStart, duration: max(0.15, clippedEnd - clippedStart))
            }
            let words = shot.words.compactMap { word -> TimedSpeechWord? in
                guard word.start >= start - 0.01, word.start + word.duration <= start + actualDuration + 0.01 else { return nil }
                return .init(text: word.text, start: word.start - start, duration: word.duration)
            }
            let cropKeyframes: [CropKeyframe] = candidate.fit
                ? [.init(time: 0, position: 0.5, preserveWholeFrame: true), .init(time: actualDuration, position: 0.5, preserveWholeFrame: true)]
                : await SubjectFramer.analyze(url, start: start, duration: actualDuration, zoom: 1.08, configuration: gemini, speech: captions)
            reportStep("Prism AI · framing the subject")
            let warning = shot.referenceCues.isEmpty || !shot.words.isEmpty ? nil : sentenceTimingNote
            let title = candidate.title.map { String($0.prefix(100)) } ?? captions.first.map { String($0.text.prefix(100)) }
            return ShortResult(start: start, duration: actualDuration, caption: "", captions: captions,
                cropKeyframes: cropKeyframes, speechWords: words, analysisWarning: warning,
                suggestedTitle: title, selectionReason: candidate.reason.map { String($0.prefix(400)) }, fitToFrame: candidate.fit,
                score: Int((min(10, max(0, candidate.score)) * 10).rounded()), videoType: detectedType)
        }
        if results.isEmpty {
            // Returning the beginning of the source here made a failed analysis
            // look like a successful Short, even when that opening was filler.
            // Keep the user's existing edits intact and ask them to retry with a
            // different range instead of silently inventing a selection.
            if !excluding.isEmpty { throw GeminiSelection.Failure.noDistinctClips }
            throw GeminiSelection.Failure.noStrongClips
        }
        try Task.checkCancellation()
        generationProgress(1, "Shorts ready")
        return results.sorted { $0.start < $1.start }
    }

    /// The most Shorts one run makes.
    static let maxShorts = 20
    /// Prism AI requests that run side by side. Rate limits are retried, so this trades quota bursts for speed.
    static let parallelRequests = 6
    /// How many Shorts Auto makes room for: one per minute of source, 1 to 20. Only strong picks fill them.
    static func autoCount(seconds: Double) -> Int { min(maxShorts, max(1, Int(seconds / 60))) }

    /// A pick's final source range with the word timing and sentence captions found for it.
    struct PreparedShort: Sendable {
        let start: Double
        let duration: Double
        let words: [TimedSpeechWord]
        let referenceCues: [TimedCaption]
        let alignmentFailed: Bool
    }

    /// Turns Prism AI's rough clip into exact boundaries: whole sentences, no filler at the edges, a little breathing room,
    /// no cut word, and both ends moved into the nearest pause in the audio.
    static func prepareShort(url: URL, start: Double, duration: Double, transcript: [TimedCaption], interval: (start: Double, end: Double),
                             clipDuration: Double, aligning: Bool, gemini: GeminiConfiguration) async throws -> PreparedShort {
        let phraseCut = TranscriptSelection.phraseRange(start: start, duration: duration, cues: transcript, interval: interval)
        // Cloud cues are whole sentences, so a Short never starts or stops in the middle of one.
        let sentences = TranscriptSelection.completeSentences(
            start: phraseCut.start, duration: phraseCut.duration, cues: transcript, interval: interval,
            minDuration: GeminiSelection.lengthRange(clipDuration).min, maxDuration: GeminiSelection.lengthRange(clipDuration).max)
        let snapped = TranscriptSelection.trimmedFiller(start: sentences.start, duration: sentences.duration, cues: transcript,
                                                        minDuration: GeminiSelection.lengthRange(clipDuration).min)
        let phrase = TranscriptSelection.paddedPhraseRange(start: snapped.start, duration: snapped.duration, cues: transcript, interval: interval)
        let referenceCues = transcript.filter { cue in
            let middle = cue.start + cue.duration / 2
            return middle >= snapped.start && middle <= snapped.start + snapped.duration
        }
        var clipWords: [TimedSpeechWord] = []
        var alignmentFailed = false
        if !referenceCues.isEmpty, aligning {
            do {
                let proposed = try await GeminiSelection.transcribe(url: url,
                    interval: (max(interval.start, phrase.start - 0.5), min(interval.end, phrase.start + phrase.duration + 0.5)),
                    configuration: gemini, reference: referenceCues)
                let inside = proposed.filter { $0.start >= phrase.start - 0.01 && $0.start + $0.duration <= phrase.start + phrase.duration + 0.01 }
                if TranscriptSelection.alignmentIsReliable(inside, reference: referenceCues) { clipWords = inside }
            } catch {
                try Task.checkCancellation()
                alignmentFailed = true
            }
        }
        let whole = speechSafeRange(start: phrase.start, duration: phrase.duration, words: clipWords, interval: interval)
        let safe = strongOpening(start: whole.start, duration: whole.duration, words: clipWords, minDuration: GeminiSelection.lengthRange(clipDuration).min)
        let quiet = await silenceSnapped(url: url, start: safe.start, duration: safe.duration, interval: interval, words: clipWords)
        return PreparedShort(start: quiet.start, duration: quiet.duration, words: clipWords, referenceCues: referenceCues, alignmentFailed: alignmentFailed)
    }

    /// Runs `transform` on every item, at most `limit` at a time, and returns the results in the items' order.
    static func concurrentMap<T: Sendable, R: Sendable>(_ items: [T], limit: Int = 3,
                                                        _ transform: @escaping @Sendable (T) async throws -> R) async throws -> [R] {
        var results = [R?](repeating: nil, count: items.count)
        try await withThrowingTaskGroup(of: (Int, R).self) { group in
            var next = 0
            func startNext() {
                guard next < items.count else { return }
                let index = next, item = items[next]
                next += 1
                group.addTask { (index, try await transform(item)) }
            }
            for _ in 0..<max(1, limit) { startNext() }
            while let (index, result) = try await group.next() {
                results[index] = result
                startNext()
            }
        }
        return results.compactMap { $0 }
    }

    /// Moves a Short's start and end into the nearest pause in its audio, so it never opens or closes on a clipped sound.
    /// The start may move up to 0.5 s earlier or 0.15 s later, the end 0.15 s earlier or 0.5 s later, never past `interval`
    /// or into a timed word. Without audio or a clear pause nearby, the range stays as it is.
    static func silenceSnapped(url: URL, start: Double, duration: Double, interval: (start: Double, end: Double),
                               words: [TimedSpeechWord] = []) async -> (start: Double, duration: Double) {
        let end = start + duration
        let from = max(interval.start, start - 0.6), to = min(interval.end, end + 0.6)
        guard to > from, let levels = await audioLevels(url: url, from: from, to: to), levels.count > 20 else { return (start, duration) }
        let frame = 0.01
        // 50 ms smoothing ignores the tiny gaps inside a word.
        let smooth = levels.indices.map { index in
            let window = levels[max(0, index - 2)...min(levels.count - 1, index + 2)]
            return window.reduce(0, +) / Float(window.count)
        }
        let median = smooth.sorted()[smooth.count / 2]
        let threshold = max(0.003, median * 0.2)
        func time(_ index: Int) -> Double { from + (Double(index) + 0.5) * frame }
        func insideWord(_ t: Double) -> Bool { words.contains { $0.start + 0.02 < t && $0.start + $0.duration - 0.02 > t } }
        func nearestQuiet(to target: Double, from low: Double, to high: Double) -> Double? {
            smooth.indices.filter { time($0) >= low && time($0) <= high && smooth[$0] <= threshold && !insideWord(time($0)) }
                .min { abs(time($0) - target) < abs(time($1) - target) }.map(time)
        }
        let newStart = nearestQuiet(to: start, from: max(interval.start, start - 0.5), to: start + 0.15) ?? start
        let newEnd = nearestQuiet(to: end, from: end - 0.15, to: min(interval.end, end + 0.5)) ?? end
        guard newEnd - newStart > 0.5 else { return (start, duration) }
        return (newStart, newEnd - newStart)
    }

    /// Loudness (RMS) of the audio in 10 ms frames, read as 16 kHz mono; nil when the file has no readable audio.
    static func audioLevels(url: URL, from: Double, to: Double) async -> [Float]? {
        let asset = AVURLAsset(url: url)
        guard let track = try? await asset.loadTracks(withMediaType: .audio).first, let reader = try? AVAssetReader(asset: asset) else { return nil }
        let output = AVAssetReaderTrackOutput(track: track, outputSettings: [
            AVFormatIDKey: kAudioFormatLinearPCM, AVSampleRateKey: 16_000, AVNumberOfChannelsKey: 1,
            AVLinearPCMBitDepthKey: 32, AVLinearPCMIsFloatKey: true, AVLinearPCMIsBigEndianKey: false, AVLinearPCMIsNonInterleaved: false
        ])
        reader.timeRange = CMTimeRange(start: CMTime(seconds: from, preferredTimescale: 16_000), end: CMTime(seconds: to, preferredTimescale: 16_000))
        guard reader.canAdd(output) else { return nil }
        reader.add(output)
        guard reader.startReading() else { return nil }
        var samples: [Float] = []
        while let buffer = output.copyNextSampleBuffer(), let block = CMSampleBufferGetDataBuffer(buffer) {
            let length = CMBlockBufferGetDataLength(block)
            var chunk = [Float](repeating: 0, count: length / MemoryLayout<Float>.size)
            _ = chunk.withUnsafeMutableBytes { CMBlockBufferCopyDataBytes(block, atOffset: 0, dataLength: length, destination: $0.baseAddress!) }
            samples += chunk
        }
        guard reader.status == .completed, !samples.isEmpty else { return nil }
        return stride(from: 0, to: samples.count, by: 160).map { first in
            let frame = samples[first..<min(samples.count, first + 160)]
            return (frame.reduce(0) { $0 + $1 * $1 } / Float(frame.count)).squareRoot()
        }
    }

    /// Drops up to three throat-clearing words ("So", "Um", "And", "Okay") from a Short's first line, so it opens on its
    /// hook. Needs real word timing; the cut lands 0.08 s before the next word and the Short keeps `minDuration`.
    // shortcut: English filler words only; add per-language lists if non-English sources matter.
    static func strongOpening(start: Double, duration: Double, words: [TimedSpeechWord], minDuration: Double) -> (start: Double, duration: Double) {
        // Only words that are filler at the start of a line; "like", "now", "then" and "right" often carry meaning there.
        let weak: Set<String> = ["so", "and", "but", "um", "uh", "erm", "okay", "ok", "well", "anyway", "alright", "yeah"]
        let end = start + duration
        let spoken = words.filter { $0.start >= start - 0.05 && $0.start < end }.sorted { $0.start < $1.start }
        func bare(_ word: TimedSpeechWord) -> String { word.text.lowercased().filter { $0.isLetter } }
        var dropped = 0
        while dropped < min(3, spoken.count - 1), weak.contains(bare(spoken[dropped])) { dropped += 1 }
        guard dropped > 0 else { return (start, duration) }
        let newStart = max(start, spoken[dropped].start - 0.08)
        guard end - newStart >= minDuration else { return (start, duration) }
        return (newStart, end - newStart)
    }

    static func speechSafeRange(
        start: Double,
        duration: Double,
        words: [TimedSpeechWord],
        interval: (start: Double, end: Double)
    ) -> (start: Double, duration: Double) {
        guard !words.isEmpty else { return (start, duration) }
        var safeStart = start
        if let cutWord = words.first(where: { $0.start + 0.02 < safeStart && $0.start + $0.duration - 0.02 > safeStart }) {
            let wordEnd = cutWord.start + cutWord.duration
            safeStart = cutWord.start >= interval.start ? max(interval.start, cutWord.start - 0.025) : min(interval.end, wordEnd + 0.025)
        }
        var safeEnd = min(interval.end, start + duration)
        if let cutWord = words.first(where: { $0.start + 0.02 < safeEnd && $0.start + $0.duration - 0.02 > safeEnd }) {
            let wordEnd = cutWord.start + cutWord.duration
            safeEnd = wordEnd <= interval.end ? min(interval.end, wordEnd + 0.04) : max(safeStart + 0.1, cutWord.start)
        }
        guard safeEnd > safeStart else { return (start, duration) }
        return (safeStart, safeEnd - safeStart)
    }

    static func analyzeSubjectPath(_ url: URL, start: Double, duration: Double, zoom: Double = 1.08, configuration: GeminiConfiguration,
                                   speech: [TimedCaption] = []) async -> [CropKeyframe] {
        await SubjectFramer.analyze(url, start: start, duration: duration, zoom: zoom, configuration: configuration, speech: speech)
    }

    /// Renders kept between edits (finished previews and Fit backgrounds), so repeats don't re-render.
    /// The README generator points it at its own work folder so it never touches the app's cache.
    nonisolated(unsafe) static var renderCacheDirectory = FileManager.default.temporaryDirectory.appendingPathComponent("RelioRenderCache")

    static func renderCacheURL(_ key: String, prefix: String) -> URL {
        let digest = SHA256.hash(data: Data(key.utf8)).map { String(format: "%02x", $0) }.joined()
        return renderCacheDirectory.appendingPathComponent("\(prefix)-\(digest).mp4")
    }

    /// Each cached file is a full-length Short, so keep only the newest ones.
    static func pruneRenderCache(keeping limit: Int = 24) {
        guard let files = try? FileManager.default.contentsOfDirectory(at: renderCacheDirectory, includingPropertiesForKeys: [.contentModificationDateKey]) else { return }
        let finished = files.filter { ($0.lastPathComponent.hasPrefix("fit-") || $0.lastPathComponent.hasPrefix("split-")) && $0.pathExtension == "mp4" }
        let dated = finished.map { ($0, (try? $0.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate) ?? .distantPast) }
        for (file, _) in dated.sorted(by: { $0.1 > $1.1 }).dropFirst(max(0, limit)) { try? FileManager.default.removeItem(at: file) }
    }

    /// Output quality for exported Shorts. Every Short is composed at 1080×1920; the preset sets the file's size and codec.
    enum ExportQuality: String, CaseIterable, Identifiable, Sendable {
        case full, compact, small
        var id: String { rawValue }
        var title: String {
            switch self {
            case .full: "1080p · H.264"
            case .compact: "1080p · HEVC"
            case .small: "720p · H.264"
            }
        }
        var detail: String {
            switch self {
            case .full: "Best quality. Plays everywhere."
            case .compact: "Same quality, smaller files. Plays on recent phones and apps."
            case .small: "Smallest files, fastest to send."
            }
        }
        var resolution: String { self == .small ? "720 × 1280" : "1080 × 1920" }
        var preset: String {
            switch self {
            case .full: AVAssetExportPreset1920x1080
            case .compact: AVAssetExportPresetHEVC1920x1080
            case .small: AVAssetExportPreset1280x720
            }
        }
    }

    static func export(source: URL, segment: EditSegment, destination: URL, quality: ExportQuality = .full) async throws {
        guard !FileManager.default.fileExists(atPath: destination.path) else { throw Failure.destinationExists }
        let (composition, videoComposition) = try await makeComposition(source: source, segment: segment, live: false)
        if let captions = captionLayer(for: segment) {
            let parent = CALayer(); parent.frame = captions.frame
            let video = CALayer(); video.frame = parent.frame
            parent.addSublayer(video)
            parent.addSublayer(captions)
            videoComposition.animationTool = AVVideoCompositionCoreAnimationTool(postProcessingAsVideoLayer: video, in: parent)
        }
        try FileManager.default.createDirectory(at: destination.deletingLastPathComponent(), withIntermediateDirectories: true)
        let temporary = destination.deletingLastPathComponent().appendingPathComponent(".relio-\(UUID()).mp4")
        defer { try? FileManager.default.removeItem(at: temporary) }
        guard let session = AVAssetExportSession(asset: composition, presetName: quality.preset) else { throw Failure.cannotExport }
        session.videoComposition = videoComposition
        session.outputURL = temporary
        session.outputFileType = .mp4
        nonisolated(unsafe) let running = session
        await withTaskCancellationHandler { await running.export() } onCancel: { running.cancelExport() }
        try Task.checkCancellation()
        if session.status != .completed { throw session.error ?? Failure.cannotExport }
        try FileManager.default.moveItem(at: temporary, to: destination)
    }

    /// Copy originals through a temporary file so a failed or cancelled copy never leaves a partial export.
    static func copySource(_ source: URL, to destination: URL) async throws {
        try Task.checkCancellation()
        guard !FileManager.default.fileExists(atPath: destination.path) else { throw Failure.destinationExists }
        let temporary = destination.deletingLastPathComponent().appendingPathComponent(".relio-copy-\(UUID())")
        defer { try? FileManager.default.removeItem(at: temporary) }
        // copyItem uses an APFS clone when possible, keeping same-drive copies fast.
        try await Task.detached(priority: .userInitiated) {
            try FileManager.default.copyItem(at: source, to: temporary)
        }.value
        try Task.checkCancellation()
        try FileManager.default.moveItem(at: temporary, to: destination)
    }

    /// A live preview of `export`: the same composition, played at once instead of rendering a file first.
    /// Captions are shown separately with `captionLayer(for:)`, because players can't use an animation tool.
    @MainActor static func previewItem(source: URL, segment: EditSegment) async throws -> AVPlayerItem {
        let (composition, videoComposition) = try await makeComposition(source: source, segment: segment, live: true)
        let item = AVPlayerItem(asset: composition)
        item.videoComposition = videoComposition
        return item
    }

    /// The picture and sound of a Short. `live` draws the Fit background frame by frame during playback;
    /// export pre-renders it to a cached file instead. Both use `blurredFitFrame`.
    private static func makeComposition(source: URL, segment: EditSegment, live: Bool) async throws
        -> sending (AVMutableComposition, AVMutableVideoComposition) {
        let asset = AVURLAsset(url: source)
        let sourceDuration = try await asset.load(.duration).seconds
        guard segment.start.isFinite, segment.duration.isFinite, segment.start >= 0,
              segment.duration > 0, sourceDuration.isFinite,
              segment.start + segment.duration <= sourceDuration + 0.001,
              (segment.captionStart ?? 0).isFinite,
              (segment.captionDuration ?? segment.duration).isFinite else { throw Failure.invalidRange }
        guard let videoTrack = try await asset.loadTracks(withMediaType: .video).first else { throw Failure.noVideo }
        let composition = AVMutableComposition()
        guard let composedVideo = composition.addMutableTrack(withMediaType: .video, preferredTrackID: kCMPersistentTrackID_Invalid) else { throw Failure.cannotExport }
        let range = CMTimeRange(start: CMTime(seconds: segment.start, preferredTimescale: 600), duration: CMTime(seconds: segment.duration, preferredTimescale: 600))
        try composedVideo.insertTimeRange(range, of: videoTrack, at: .zero)
        if segment.isMuted != true,
           let audioTrack = try await asset.loadTracks(withMediaType: .audio).first,
           let composedAudio = composition.addMutableTrack(withMediaType: .audio, preferredTrackID: kCMPersistentTrackID_Invalid) {
            try composedAudio.insertTimeRange(range, of: audioTrack, at: .zero)
        }
        let natural = try await videoTrack.load(.naturalSize)
        let preferred = try await videoTrack.load(.preferredTransform)
        let transformed = CGRect(origin: .zero, size: natural).applying(preferred)
        let oriented = CGSize(width: abs(transformed.width), height: abs(transformed.height))
        let target = CGSize(width: 1080, height: 1920)
        guard oriented.width > 0, oriented.height > 0 else { throw Failure.noVideo }
        let isSplit = segment.splitScreen == true
        let usesBlurredFitBackground = !isSplit && segment.fitToFrame == true && oriented.width / oriented.height > target.width / target.height
        // Split and blurred Fit frames are drawn with Core Image instead of a layer transform.
        let drawsFrames = isSplit || usesBlurredFitBackground
        let draw: @Sendable (CIImage) -> CIImage
        let centers = segment.splitCenters ?? []
        // preferredTransform is in y-down video space; Core Image is y-up, so mirror it or rotated
        // phone video comes out upside down. The drawing code re-normalizes the translation.
        let upright = CGAffineTransform(a: preferred.a, b: -preferred.b, c: -preferred.c, d: preferred.d, tx: preferred.tx, ty: -preferred.ty)
        if isSplit { draw = { image in ShortMaker.splitScreenFrame(image, transform: upright, centers: centers) } }
        else { draw = { image in ShortMaker.blurredFitFrame(image, transform: upright) } }
        if drawsFrames && !live {
            // The drawn picture depends only on the layout and source range, so caption and style edits reuse it.
            let cached = isSplit
                ? renderCacheURL("split-v3|\(source.path)|\(segment.start)|\(segment.duration)|\(centers)", prefix: "split")
                : renderCacheURL("fit-v3|\(source.path)|\(segment.start)|\(segment.duration)", prefix: "fit")
            if !FileManager.default.fileExists(atPath: cached.path) {
                try FileManager.default.createDirectory(at: renderCacheDirectory, withIntermediateDirectories: true)
                let intermediate = renderCacheDirectory.appendingPathComponent(".relio-fit-\(UUID()).mp4")
                defer { try? FileManager.default.removeItem(at: intermediate) }
                try await renderFrames(asset: asset, track: videoTrack, range: range, outputURL: intermediate, draw: draw)
                do { try FileManager.default.moveItem(at: intermediate, to: cached) }
                catch { if !FileManager.default.fileExists(atPath: cached.path) { throw error } }
                pruneRenderCache()
            }
            let blurredAsset = AVURLAsset(url: cached)
            guard let blurredTrack = try await blurredAsset.loadTracks(withMediaType: .video).first else { throw Failure.cannotExport }
            composedVideo.removeTimeRange(CMTimeRange(start: .zero, duration: range.duration))
            try composedVideo.insertTimeRange(CMTimeRange(start: .zero, duration: range.duration), of: blurredTrack, at: .zero)
        }
        let baseScale = segment.fitToFrame == true
            ? min(target.width / oriented.width, target.height / oriented.height)
            : max(target.width / oriented.width, target.height / oriented.height)
        let scale = baseScale * (segment.fitToFrame == true ? 1 : min(2, max(1, segment.cropZoom ?? 1.08)))
        let normalized = preferred.concatenating(CGAffineTransform(translationX: -transformed.minX, y: -transformed.minY))
        let baseTransform = normalized.concatenating(CGAffineTransform(scaleX: scale, y: scale)).concatenating(CGAffineTransform(translationX: (target.width - oriented.width * scale) / 2, y: (target.height - oriented.height * scale) / 2))
        let instruction = AVMutableVideoCompositionInstruction()
        instruction.timeRange = CMTimeRange(start: .zero, duration: CMTime(seconds: segment.duration, preferredTimescale: 600))
        let layer = AVMutableVideoCompositionLayerInstruction(assetTrack: composedVideo)
        let panDistance = drawsFrames || segment.fitToFrame == true || oriented.width / oriented.height < 1.2
            ? 0 : max(0, oriented.width * scale - target.width)
        if panDistance > 2 {
            if let trackedPath = segment.cropKeyframes {
                let bias = (segment.cropPosition ?? 0.5) - 0.5
                let path = trackedPath
                    .filter { $0.time.isFinite && $0.position.isFinite }
                    .map { CropKeyframe(time: min(segment.duration, max(0, $0.time)), position: min(1, max(0, $0.position + bias)), isSceneCut: $0.isSceneCut, preserveWholeFrame: $0.preserveWholeFrame) }
                    .sorted { $0.time < $1.time }
                if path.isEmpty {
                    let position = min(1, max(0, segment.cropPosition ?? 0.5))
                    let offset = panDistance * (0.5 - position)
                    layer.setTransform(baseTransform.concatenating(CGAffineTransform(translationX: offset, y: 0)), at: .zero)
                } else {
                    var completePath = path
                    if let first = path.first, first.time > 0 { completePath.insert(.init(time: 0, position: first.position, preserveWholeFrame: first.preserveWholeFrame), at: 0) }
                    if let last = path.last, last.time < segment.duration { completePath.append(.init(time: segment.duration, position: last.position, preserveWholeFrame: last.preserveWholeFrame)) }
                    // Eased at render time, so saved paths, older Shorts and hand-set focus points all move smoothly.
                    let smoothPath = SubjectFramer.eased(completePath)
                    for pair in zip(smoothPath, smoothPath.dropFirst()) where pair.1.time > pair.0.time {
                        let fromOffset = panDistance * (0.5 - pair.0.position)
                        let toOffset = panDistance * (0.5 - pair.1.position)
                        let fitScale = min(target.width / oriented.width, target.height / oriented.height)
                        let fitTransform = normalized.concatenating(CGAffineTransform(scaleX: fitScale, y: fitScale)).concatenating(CGAffineTransform(translationX: (target.width - oriented.width * fitScale) / 2, y: (target.height - oriented.height * fitScale) / 2))
                        let from = pair.0.preserveWholeFrame == true ? fitTransform : baseTransform.concatenating(CGAffineTransform(translationX: fromOffset, y: 0))
                        let to = pair.1.preserveWholeFrame == true ? fitTransform : baseTransform.concatenating(CGAffineTransform(translationX: toOffset, y: 0))
                        if pair.1.isSceneCut == true {
                            layer.setTransform(from, at: CMTime(seconds: pair.0.time, preferredTimescale: 600))
                            layer.setTransform(to, at: CMTime(seconds: pair.1.time, preferredTimescale: 600))
                        } else {
                            layer.setTransformRamp(fromStart: from, toEnd: to, timeRange: CMTimeRange(
                                start: CMTime(seconds: pair.0.time, preferredTimescale: 600),
                                duration: CMTime(seconds: pair.1.time - pair.0.time, preferredTimescale: 600)
                            ))
                        }
                    }
                }
            } else {
                let position = min(1, max(0, segment.cropPosition ?? 0.5))
                let offset = panDistance * (0.5 - position)
                layer.setTransform(baseTransform.concatenating(CGAffineTransform(translationX: offset, y: 0)), at: .zero)
            }
        } else {
            layer.setTransform(drawsFrames ? .identity : baseTransform, at: .zero)
        }
        let videoComposition = AVMutableVideoComposition()
        instruction.layerInstructions = [layer]
        videoComposition.instructions = [instruction]
        videoComposition.renderSize = target
        videoComposition.frameDuration = CMTime(value: 1, timescale: 30)
        if drawsFrames && live {
            let fit = AVMutableVideoComposition(asset: composition) { request in
                request.finish(with: draw(request.sourceImage), context: nil)
            }
            fit.renderSize = target
            fit.frameDuration = videoComposition.frameDuration
            return (composition, fit)
        }
        return (composition, videoComposition)
    }

    /// Captions and the text overlay as layers in 1080×1920 video coordinates, timed from AVCoreAnimationBeginTimeAtZero.
    static func captionLayer(for segment: EditSegment) -> CALayer? {
        guard !(segment.captions ?? []).isEmpty || !segment.caption.isEmpty else { return nil }
        let parent = CALayer(); parent.frame = CGRect(x: 0, y: 0, width: 1080, height: 1920)
        let captions = segment.captions ?? []
        let position = segment.captionPosition ?? .bottom
        let scale = (segment.captionSize ?? .medium).scale
        let pops = segment.captionPops
        // The on-screen text overlay moves out of the subtitles' way.
        let overlayY: CGFloat = captions.isEmpty ? 330 : position == .top ? 470 : 1560
        let style = segment.resolvedCaptionStyle
        for page in captionPages(captions, words: segment.speechWords ?? [], style: style) {
            guard style.highlightsWords, page.words.count > 1 else {
                addCaption(page.text, start: page.start, duration: page.end - page.start, total: segment.duration, centerY: position.centerY,
                           style: style, scale: scale, pops: pops, to: parent)
                continue
            }
            for (index, word) in page.words.enumerated() {
                let from = index == 0 ? page.start : word.start
                let to = index + 1 < page.words.count ? page.words[index + 1].start : page.end
                // Only a new page pops; the moving highlight inside it must not bounce on every word.
                addCaption(page.text, start: from, duration: max(0.01, to - from), total: segment.duration, centerY: position.centerY,
                           highlightedWord: index, style: style, scale: scale, pops: pops && index == 0, to: parent)
            }
        }
        if !segment.caption.isEmpty {
            addCaption(segment.caption, start: segment.captionStart ?? 0,
                       duration: segment.captionDuration ?? segment.duration, total: segment.duration,
                       centerY: overlayY, to: parent)
        }
        return parent
    }

    /// What one caption shows at a time: a few words, their timing, and how long the page stays up.
    struct CaptionPage: Equatable {
        var words: [TimedSpeechWord]
        var start: Double
        var end: Double
        var text: String
    }

    /// Splits captions into short pages the way Shorts are captioned: a few words at a time, breaking at sentence ends,
    /// commas and pauses. Exact word timings are used where they match a line's text; otherwise each word's timing is
    /// estimated from the line, so every style still moves with the speech.
    static func captionPages(_ cues: [TimedCaption], words: [TimedSpeechWord], style: CaptionStyle) -> [CaptionPage] {
        let (maxWords, maxCharacters): (Int, Int) = switch style.resolved {
        case .oneWord: (1, 16)
        case .boldCaps: (2, 16)
        case .viral, .highlightBox: (3, 20)
        case .podcast: (4, 26)
        case .minimal: (7, 40)
        default: (5, 26)
        }
        var pages: [CaptionPage] = []
        for cue in cues {
            let exact = words.filter { $0.start >= cue.start - 0.02 && $0.start + $0.duration <= cue.start + cue.duration + 0.02 }
                .sorted { $0.start < $1.start }
            let cueWords = !exact.isEmpty && normalizedCaptionWords(exact.map(\.text)) == normalizedCaptionWords([cue.text])
                ? exact : estimatedWords(cue)
            var group: [TimedSpeechWord] = []
            func flush() {
                guard let first = group.first, let last = group.last else { return }
                pages.append(.init(words: group, start: first.start, end: last.start + last.duration,
                                   text: pageText(group.map(\.text), style: style)))
                group.removeAll()
            }
            for word in cueWords {
                if let last = group.last {
                    let characters = (group.map(\.text) + [word.text]).joined(separator: " ").count
                    let pause = word.start - (last.start + last.duration)
                    if group.count >= maxWords || characters > maxCharacters || pause > 0.45 { flush() }
                }
                group.append(word)
                if let mark = word.text.last, ".!?".contains(mark) || (",;:".contains(mark) && group.count >= 2) { flush() }
            }
            flush()
        }
        // A page stays up until the next one starts, or briefly after its last word when a pause follows.
        for index in pages.indices {
            let hold = pages[index].end + 0.35
            let next = index + 1 < pages.count ? pages[index + 1].start : .infinity
            pages[index].end = max(pages[index].start + 0.05, min(hold, next))
        }
        return pages
    }

    /// Word timings spread across a line by length, for lines without exact timings.
    static func estimatedWords(_ cue: TimedCaption) -> [TimedSpeechWord] {
        let texts = cue.text.split(whereSeparator: \.isWhitespace).map(String.init)
        let weights = texts.map { Double($0.count) + 2 }
        let total = weights.reduce(0, +)
        guard total > 0, cue.duration > 0 else { return [] }
        var start = cue.start
        return zip(texts, weights).map { text, weight in
            let duration = cue.duration * weight / total
            defer { start += duration }
            return TimedSpeechWord(text: text, start: start, duration: duration)
        }
    }

    /// Short punchy pages drop trailing commas and periods; questions and exclamations keep their mark.
    private static func pageText(_ words: [String], style: CaptionStyle) -> String {
        let text = words.joined(separator: " ")
        guard ![.classic, .minimal].contains(style.resolved) else { return text }
        return text.trimmingCharacters(in: CharacterSet(charactersIn: ".,;:"))
    }

    /// One Fit frame at 1080×1920: the whole source, centered over a blurred, zoomed copy of itself.
    static func blurredFitFrame(_ source: CIImage, transform: CGAffineTransform) -> CIImage {
        let renderSize = CGSize(width: 1080, height: 1920)
        let canvas = CGRect(origin: .zero, size: renderSize)
        let transformed = source.transformed(by: transform)
        let transformedBounds = CGRect(origin: .zero, size: source.extent.size).applying(transform)
        let normalized = transformed.transformed(by: CGAffineTransform(translationX: -transformedBounds.minX,
                                                                          y: -transformedBounds.minY))
        let extent = CGRect(origin: .zero, size: CGSize(width: transformedBounds.width, height: transformedBounds.height))
        // A heavy blur keeps no fine detail, so blur at 1/8 size and scale up: same look, far less GPU work.
        let blurScale: CGFloat = 0.125
        let backgroundScale = max(renderSize.width / extent.width, renderSize.height / extent.height) * 1.08 * blurScale
        let background = normalized
            .transformed(by: CGAffineTransform(scaleX: backgroundScale, y: backgroundScale))
            .transformed(by: CGAffineTransform(translationX: (renderSize.width * blurScale - extent.width * backgroundScale) / 2,
                                                y: (renderSize.height * blurScale - extent.height * backgroundScale) / 2))
            .clampedToExtent()
            .applyingGaussianBlur(sigma: 36 * blurScale)
            .cropped(to: CGRect(x: 0, y: 0, width: renderSize.width * blurScale, height: renderSize.height * blurScale))
            .transformed(by: CGAffineTransform(scaleX: 1 / blurScale, y: 1 / blurScale))
            .clampedToExtent()
            .cropped(to: canvas)
            .applyingFilter("CIColorControls", parameters: [kCIInputSaturationKey: 0.68, kCIInputContrastKey: 1.04, kCIInputBrightnessKey: -0.08])
        let foregroundScale = min(renderSize.width / extent.width, renderSize.height / extent.height)
        let foreground = normalized
            .transformed(by: CGAffineTransform(scaleX: foregroundScale, y: foregroundScale))
            .transformed(by: CGAffineTransform(translationX: (renderSize.width - extent.width * foregroundScale) / 2,
                                                y: (renderSize.height - extent.height * foregroundScale) / 2))
        return foreground.composited(over: background).cropped(to: canvas)
    }

    /// Face centers from sampled frames → the two speakers' horizontal centers, left first; nil unless two clear groups exist.
    static func splitCenters(fromFaceXs xs: [Double]) -> [Double]? {
        let sorted = xs.filter { $0.isFinite && (0...1).contains($0) }.sorted()
        guard sorted.count >= 2 else { return nil }
        let gaps = zip(sorted, sorted.dropFirst()).enumerated().map { ($0.offset, $0.element.1 - $0.element.0) }
        guard let widest = gaps.max(by: { $0.1 < $1.1 }), widest.1 >= 0.15 else { return nil }
        let left = sorted[...widest.0], right = sorted[(widest.0 + 1)...]
        return [left.reduce(0, +) / Double(left.count), right.reduce(0, +) / Double(right.count)]
    }

    /// Asks Prism AI where the two people sit across a Short, left first; nil unless two clear groups of faces exist.
    static func findSplitCenters(_ url: URL, start: Double, duration: Double, configuration: GeminiConfiguration) async -> [Double]? {
        let images = await Task.detached(priority: .utility) { () -> [CGImage] in
            let generator = AVAssetImageGenerator(asset: AVURLAsset(url: url))
            generator.appliesPreferredTrackTransform = true
            generator.maximumSize = CGSize(width: 512, height: 512)
            return (0..<8).compactMap { index in
                try? generator.copyCGImage(at: CMTime(seconds: start + duration * (Double(index) + 0.5) / 8, preferredTimescale: 600), actualTime: nil)
            }
        }.value
        guard !images.isEmpty, let located = await SubjectFramer.locate(images, configuration: configuration) else { return nil }
        return splitCenters(fromFaceXs: located.frames.flatMap(\.faces))
    }

    /// One split-screen frame at 1080×1920: the left speaker fills the top, the right speaker the bottom.
    /// Each panel shows a half-width window centered on its speaker (`centers`), or on the left/right quarter.
    static func splitScreenFrame(_ source: CIImage, transform: CGAffineTransform, centers: [Double] = []) -> CIImage {
        let canvas = CGRect(x: 0, y: 0, width: 1080, height: 1920)
        let bounds = CGRect(origin: .zero, size: source.extent.size).applying(transform)
        let oriented = source.transformed(by: transform)
            .transformed(by: CGAffineTransform(translationX: -bounds.minX, y: -bounds.minY))
        let half = CGSize(width: bounds.width / 2, height: bounds.height)
        let panel = CGSize(width: 1080, height: 960)
        let scale = max(panel.width / half.width, panel.height / half.height)
        // Core Image's origin is bottom-left, so the top panel starts at y 960.
        func windowX(_ center: Double) -> CGFloat {
            min(bounds.width - half.width, max(0, CGFloat(center) * bounds.width - half.width / 2))
        }
        func place(fromX x: CGFloat, atY y: CGFloat) -> CIImage {
            oriented.cropped(to: CGRect(x: x, y: 0, width: half.width, height: half.height))
                .transformed(by: CGAffineTransform(translationX: -x, y: 0))
                .transformed(by: CGAffineTransform(scaleX: scale, y: scale))
                .transformed(by: CGAffineTransform(translationX: (panel.width - half.width * scale) / 2,
                                                   y: y + (panel.height - half.height * scale) / 2))
                .cropped(to: CGRect(x: 0, y: y, width: panel.width, height: panel.height))
        }
        let top = centers.count == 2 ? windowX(centers[0]) : 0
        let bottom = centers.count == 2 ? windowX(centers[1]) : half.width
        return place(fromX: top, atY: 960)
            .composited(over: place(fromX: bottom, atY: 0))
            .composited(over: CIImage(color: .black).cropped(to: canvas))
            .cropped(to: canvas)
    }

    private static func renderFrames(asset: AVAsset, track: AVAssetTrack, range: CMTimeRange,
                                     outputURL: URL, draw: (CIImage) -> CIImage) async throws {
        let renderSize = CGSize(width: 1080, height: 1920)
        let reader = try AVAssetReader(asset: asset)
        reader.timeRange = range
        let output = AVAssetReaderTrackOutput(track: track, outputSettings: [
            kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA
        ])
        output.alwaysCopiesSampleData = false
        guard reader.canAdd(output) else { throw Failure.cannotExport }
        reader.add(output)

        let writer = try AVAssetWriter(outputURL: outputURL, fileType: .mp4)
        let input = AVAssetWriterInput(mediaType: .video, outputSettings: [
            AVVideoCodecKey: AVVideoCodecType.h264,
            AVVideoWidthKey: Int(renderSize.width),
            AVVideoHeightKey: Int(renderSize.height),
            AVVideoCompressionPropertiesKey: [AVVideoAverageBitRateKey: 8_000_000]
        ])
        input.expectsMediaDataInRealTime = false
        let adaptor = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: input, sourcePixelBufferAttributes: [
            kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
            kCVPixelBufferWidthKey as String: Int(renderSize.width),
            kCVPixelBufferHeightKey as String: Int(renderSize.height),
            kCVPixelBufferCGImageCompatibilityKey as String: true,
            kCVPixelBufferCGBitmapContextCompatibilityKey as String: true,
            kCVPixelBufferIOSurfacePropertiesKey as String: [:] as [String: Any],
            kCVPixelBufferMetalCompatibilityKey as String: true
        ])
        guard writer.canAdd(input) else { throw Failure.cannotExport }
        writer.add(input)
        guard writer.startWriting() else { throw writer.error ?? Failure.cannotExport }
        guard reader.startReading() else { throw reader.error ?? Failure.cannotExport }
        writer.startSession(atSourceTime: .zero)

        let ciContext = CIContext(options: [.cacheIntermediates: false])
        let canvas = CGRect(origin: .zero, size: renderSize)
        var frameCount = 0
        // The final Short is 30 fps; drawing every frame of a 60 fps source would double the work for nothing.
        let frameInterval = 1.0 / 30
        var nextOutputTime = 0.0
        while let sample = output.copyNextSampleBuffer() {
            if Task.isCancelled { reader.cancelReading(); writer.cancelWriting(); throw CancellationError() }
            let outputSeconds = CMTimeSubtract(CMSampleBufferGetPresentationTimeStamp(sample), range.start).seconds
            if outputSeconds < nextOutputTime - frameInterval * 0.25 { continue }
            nextOutputTime += frameInterval
            while nextOutputTime <= outputSeconds { nextOutputTime += frameInterval }
            while !input.isReadyForMoreMediaData {
                if Task.isCancelled { reader.cancelReading(); writer.cancelWriting(); throw CancellationError() }
                try await Task.sleep(for: .milliseconds(4))
            }
            guard let sourceBuffer = CMSampleBufferGetImageBuffer(sample), let pool = adaptor.pixelBufferPool else {
                reader.cancelReading(); writer.cancelWriting(); throw Failure.cannotExport
            }
            var destinationBuffer: CVPixelBuffer?
            let allocation = CVPixelBufferPoolCreatePixelBuffer(kCFAllocatorDefault, pool, &destinationBuffer)
            guard allocation == kCVReturnSuccess, let destinationBuffer else {
                reader.cancelReading(); writer.cancelWriting(); throw Failure.cannotExport
            }
            ciContext.render(draw(CIImage(cvPixelBuffer: sourceBuffer)), to: destinationBuffer,
                             bounds: canvas, colorSpace: CGColorSpaceCreateDeviceRGB())
            let sourceTime = CMSampleBufferGetPresentationTimeStamp(sample)
            let outputTime = CMTimeSubtract(sourceTime, range.start)
            guard adaptor.append(destinationBuffer, withPresentationTime: outputTime) else {
                reader.cancelReading(); writer.cancelWriting(); throw writer.error ?? Failure.cannotExport
            }
            frameCount += 1
        }
        guard reader.status == .completed, frameCount > 0 else {
            writer.cancelWriting(); throw reader.error ?? Failure.cannotExport
        }
        input.markAsFinished()
        await withCheckedContinuation { continuation in writer.finishWriting { continuation.resume() } }
        guard writer.status == .completed else { throw writer.error ?? Failure.cannotExport }
    }

    private static func addCaption(_ text: String, start: Double, duration: Double, total: Double, centerY: CGFloat,
                                   highlightedWord: Int? = nil, style: CaptionStyle = .classic, scale: CGFloat = 1,
                                   pops: Bool = false, to parent: CALayer) {
        guard start.isFinite, duration.isFinite, total.isFinite, total > 0, start < total, duration > 0 else { return }
        let overlayStart = max(0, min(start, total))
        let overlayDuration = min(total, start + duration) - overlayStart
        guard overlayDuration > 0,
              let image = captionImage(text, highlightedWord: highlightedWord, style: style, scale: scale) else { return }
        let captionLayer = CALayer()
        let height = CGFloat(image.height)
        // Centered on the position line, and kept inside the frame however many lines it has.
        captionLayer.frame = CGRect(x: 70, y: min(1920 - height, max(0, centerY - height / 2)), width: 940, height: height)
        captionLayer.contents = image
        captionLayer.opacity = 0
        let visibility = CAKeyframeAnimation(keyPath: "opacity")
        visibility.values = [0, 1, 0, 0]
        visibility.keyTimes = [0, NSNumber(value: overlayStart / total), NSNumber(value: (overlayStart + overlayDuration) / total), 1]
        visibility.calculationMode = .discrete
        visibility.beginTime = AVCoreAnimationBeginTimeAtZero
        visibility.duration = total
        visibility.fillMode = .both
        visibility.isRemovedOnCompletion = false
        captionLayer.add(visibility, forKey: "captionVisibility")
        if pops {
            let pop = CAKeyframeAnimation(keyPath: "transform.scale")
            pop.values = [0.7, 1.1, 1]
            pop.keyTimes = [0, 0.55, 1]
            pop.duration = min(0.18, overlayDuration)
            // Zero means "now" to Core Animation; video timelines need the AVFoundation constant instead.
            pop.beginTime = overlayStart > 0 ? overlayStart : AVCoreAnimationBeginTimeAtZero
            pop.fillMode = .both
            pop.isRemovedOnCompletion = false
            captionLayer.add(pop, forKey: "captionPop")
        }
        parent.addSublayer(captionLayer)
    }

    /// A sample of each subtitle style, drawn by the same code as exported captions so the picker matches the video.
    static func captionPreview(_ style: CaptionStyle) -> CGImage? {
        let sample = captionPages([TimedCaption(text: "Wait until you see this", start: 0, duration: 2)], words: [], style: style).first?.text ?? "Hello"
        let image = captionImage(sample, highlightedWord: style.resolved.highlightsWords ? 1 : nil, style: style)
        return image.flatMap { trimmedToContent($0, padding: 14) } ?? image
    }

    /// Crops away the transparent margin so a small preview shows the text large.
    private static func trimmedToContent(_ image: CGImage, padding: Int) -> CGImage? {
        let width = image.width, height = image.height
        var pixels = [UInt8](repeating: 0, count: width * height * 4)
        guard let context = CGContext(data: &pixels, width: width, height: height, bitsPerComponent: 8, bytesPerRow: width * 4,
                                      space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return nil }
        context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
        var minX = width, minY = height, maxX = -1, maxY = -1
        for y in 0..<height {
            for x in 0..<width where pixels[(y * width + x) * 4 + 3] > 8 {
                minX = min(minX, x); maxX = max(maxX, x); minY = min(minY, y); maxY = max(maxY, y)
            }
        }
        guard maxX >= minX, maxY >= minY else { return nil }
        // The buffer's rows run top-down, which matches CGImage cropping.
        let box = CGRect(x: max(0, minX - padding), y: max(0, minY - padding),
                         width: min(width, maxX + padding + 1) - max(0, minX - padding),
                         height: min(height, maxY + padding + 1) - max(0, minY - padding))
        return image.cropping(to: box)
    }

    /// How a style looks: type, outline, shadow and the spoken word's color.
    private struct CaptionLook {
        var size: CGFloat
        var weight: NSFont.Weight = .black
        var uppercase = false
        var outline: CGFloat = 0
        var shadow: CGFloat = 0
        var highlight: NSColor? = nil
        var band = false
        var box = false

        init(_ style: CaptionStyle) {
            let yellow = NSColor(srgbRed: 1, green: 0.85, blue: 0.1, alpha: 1)
            switch style.resolved {
            case .viral: self.init(size: 92, uppercase: true, outline: 9, shadow: 14, highlight: yellow)
            case .highlightBox: self.init(size: 88, uppercase: true, outline: 8, shadow: 12, highlight: .black, box: true)
            case .boldCaps: self.init(size: 118, uppercase: true, outline: 11, shadow: 16)
            case .oneWord: self.init(size: 138, uppercase: true, outline: 12, shadow: 18)
            case .podcast: self.init(size: 72, weight: .heavy, shadow: 18, highlight: NSColor(srgbRed: 0.24, green: 0.9, blue: 0.5, alpha: 1))
            case .minimal: self.init(size: 52, weight: .semibold, band: true)
            default: self.init(size: 74, weight: .heavy, outline: 7, shadow: 10)
            }
        }
        private init(size: CGFloat, weight: NSFont.Weight = .black, uppercase: Bool = false, outline: CGFloat = 0, shadow: CGFloat = 0,
                     highlight: NSColor? = nil, band: Bool = false, box: Bool = false) {
            self.size = size; self.weight = weight; self.uppercase = uppercase; self.outline = outline; self.shadow = shadow
            self.highlight = highlight; self.band = band; self.box = box
        }
    }

    /// One caption image, 940 px wide and as tall as its lines, for any subtitle style. `highlightedWord` marks the spoken word.
    private static func captionImage(_ text: String, highlightedWord: Int? = nil, style: CaptionStyle = .classic, scale k: CGFloat = 1) -> CGImage? {
        let look = CaptionLook(style)
        let shown = look.uppercase ? text.uppercased() : text
        let font = NSFont.systemFont(ofSize: look.size * k, weight: look.weight)
        let paragraph = NSMutableParagraphStyle()
        paragraph.alignment = .center
        paragraph.lineHeightMultiple = 0.9
        func styled(_ color: NSColor) -> NSMutableAttributedString {
            NSMutableAttributedString(string: shown, attributes: [.font: font, .foregroundColor: color, .paragraphStyle: paragraph,
                                                                  .kern: -0.01 * look.size * k])
        }
        let fill = styled(.white)
        let wordRange: NSRange? = highlightedWord.flatMap { index in
            let ranges = (try? NSRegularExpression(pattern: "\\S+"))?.matches(in: shown, range: NSRange(location: 0, length: (shown as NSString).length)) ?? []
            return ranges.indices.contains(index) ? ranges[index].range : nil
        }
        if let wordRange, let color = look.highlight { fill.addAttribute(.foregroundColor, value: color, range: wordRange) }

        // Room around the text for the outline, shadow, highlight box or band, so nothing is clipped.
        let margin = ceil((look.outline + look.shadow + (look.box ? 18 : 0) + (look.band ? 30 : 0) + 12) * k)
        let textWidth = 940 - 2 * margin
        let framesetter = CTFramesetterCreateWithAttributedString(fill)
        let fitted = CTFramesetterSuggestFrameSizeWithConstraints(framesetter, CFRange(), nil, CGSize(width: textWidth, height: .greatestFiniteMagnitude), nil)
        let textHeight = ceil(fitted.height) + 2
        let height = Int(textHeight + 2 * margin)
        // Draw at exactly the pixels export uses; NSImage focus would render 2× on Retina and scale down.
        guard let context = CGContext(data: nil, width: 940, height: height, bitsPerComponent: 8, bytesPerRow: 0,
                                      space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return nil }
        let textRect = CGRect(x: margin, y: margin, width: textWidth, height: textHeight)
        let frame = CTFramesetterCreateFrame(framesetter, CFRange(), CGPath(rect: textRect, transform: nil), nil)

        if look.band {
            let band = CGRect(x: 470 - ceil(fitted.width) / 2 - 26 * k, y: margin - 12 * k, width: ceil(fitted.width) + 52 * k, height: textHeight + 24 * k)
            context.setFillColor(NSColor.black.withAlphaComponent(0.6).cgColor)
            context.addPath(CGPath(roundedRect: band, cornerWidth: 22 * k, cornerHeight: 22 * k, transform: nil))
            context.fillPath()
        }
        // The outline is a wide, round-joined stroke under the fill, with the shadow cast from it.
        if look.outline > 0 || look.shadow > 0 {
            context.saveGState()
            if look.shadow > 0 {
                context.setShadow(offset: CGSize(width: 0, height: -4 * k), blur: look.shadow * k, color: NSColor.black.withAlphaComponent(0.75).cgColor)
            }
            context.setLineJoin(.round)
            context.setLineWidth(max(1, look.outline * 2 * k))
            context.setTextDrawingMode(look.outline > 0 ? .fillStroke : .fill)
            let under = styled(NSColor.black)
            under.addAttribute(.strokeColor, value: NSColor.black, range: NSRange(location: 0, length: under.length))
            CTFrameDraw(CTFramesetterCreateFrame(CTFramesetterCreateWithAttributedString(under), CFRange(), CGPath(rect: textRect, transform: nil), nil), context)
            context.restoreGState()
        }
        // The box covers the outline, so the spoken word reads as dark text on a bright box.
        if look.box, let wordRange {
            context.setFillColor(NSColor(srgbRed: 1, green: 0.85, blue: 0.1, alpha: 1).cgColor)
            for rect in wordRects(wordRange, in: frame, origin: textRect.origin) {
                let padded = rect.insetBy(dx: -14 * k, dy: -6 * k)
                context.addPath(CGPath(roundedRect: padded, cornerWidth: 16 * k, cornerHeight: 16 * k, transform: nil))
            }
            context.fillPath()
        }
        if look.box, let wordRange { fill.addAttribute(.foregroundColor, value: NSColor.black, range: wordRange) }
        context.setTextDrawingMode(.fill)
        CTFrameDraw(look.box ? CTFramesetterCreateFrame(CTFramesetterCreateWithAttributedString(fill), CFRange(), CGPath(rect: textRect, transform: nil), nil) : frame, context)
        return context.makeImage()
    }

    /// The boxes a range of text covers, one per line, in the caption image's coordinates.
    private static func wordRects(_ range: NSRange, in frame: CTFrame, origin: CGPoint) -> [CGRect] {
        let lines = CTFrameGetLines(frame) as! [CTLine]
        var origins = [CGPoint](repeating: .zero, count: lines.count)
        CTFrameGetLineOrigins(frame, CFRange(), &origins)
        return zip(lines, origins).compactMap { line, lineOrigin in
            let lineRange = CTLineGetStringRange(line)
            let start = max(range.location, lineRange.location), end = min(range.location + range.length, lineRange.location + lineRange.length)
            guard start < end else { return nil }
            var ascent: CGFloat = 0, descent: CGFloat = 0
            CTLineGetTypographicBounds(line, &ascent, &descent, nil)
            let x1 = CTLineGetOffsetForStringIndex(line, start, nil), x2 = CTLineGetOffsetForStringIndex(line, end, nil)
            return CGRect(x: origin.x + lineOrigin.x + x1, y: origin.y + lineOrigin.y - descent, width: x2 - x1, height: ascent + descent)
        }
    }

    private static func normalizedCaptionWords(_ words: [String]) -> [String] {
        words.flatMap { $0.lowercased().split { !$0.isLetter && !$0.isNumber }.map(String.init) }
    }
}

private extension NSShadow {
    func also(_ configure: (NSShadow) -> Void) -> NSShadow { configure(self); return self }
}
