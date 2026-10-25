import Foundation
import AVFoundation

/// A video for requests in these tests; the server counts each request against it.
let testUsage = GeminiConfiguration.Usage(video: String(repeating: "a", count: 64), minutes: 1, day: "2026-10-26")

final class GeminiMockProtocol: URLProtocol, @unchecked Sendable {
    nonisolated(unsafe) static var status = 200
    nonisolated(unsafe) static var finish = "STOP"
    nonisolated(unsafe) static var statuses: [Int] = []
    nonisolated(unsafe) static var payloads: [String] = []
    /// Every request body sent, so tests can check what the prompts contain.
    nonisolated(unsafe) static var bodies: [String] = []
    /// Sent instead of a Gemini answer when the status isn't 200, like a real quota error body.
    nonisolated(unsafe) static var errorBody: String?
    /// The model each request was sent to, from the URL.
    nonisolated(unsafe) static var models: [String] = []
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        // URLSession hands the body over as a stream inside a protocol.
        var body = request.httpBody ?? Data()
        if body.isEmpty, let stream = request.httpBodyStream {
            stream.open()
            var buffer = [UInt8](repeating: 0, count: 65_536)
            while stream.hasBytesAvailable {
                let count = stream.read(&buffer, maxLength: buffer.count)
                if count <= 0 { break }
                body.append(buffer, count: count)
            }
            stream.close()
        }
        Self.bodies.append(String(decoding: body, as: UTF8.self))
        Self.models.append(String(request.url!.lastPathComponent.split(separator: ":")[0]))
        precondition(request.url?.query == nil, "Credentials must not be put in the URL")
        precondition(request.value(forHTTPHeaderField: "Authorization") == "Bearer test-token")
        let response = HTTPURLResponse(url: request.url!, statusCode: Self.statuses.isEmpty ? Self.status : Self.statuses.removeFirst(), httpVersion: nil, headerFields: nil)!
        let data: Data
        if response.statusCode != 200, let errorBody = Self.errorBody {
            data = Data(errorBody.utf8)
        } else {
            let payload = Self.payloads.isEmpty ? "{\"ok\":true}" : Self.payloads.removeFirst()
            data = try! JSONSerialization.data(withJSONObject: ["candidates": [["finishReason": Self.finish,
                "content": ["parts": [["thought": true, "text": "ignore"], ["text": payload]]]]]])
        }
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: data)
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}

/// Collects the transcript the pipeline hands back for saving.
final class TranscriptBox: @unchecked Sendable {
    var value: SentenceTranscript?
}

/// Collects retry announcements; one request retries sequentially, so there is no concurrent access.
final class NoteBox: @unchecked Sendable {
    var values: [String] = []
}

@main struct GeminiSelectionTests {
    static func main() async throws {
        typealias Clip = GeminiSelection.Clip
        let valid = try GeminiSelection.validate([
            Clip(start: 300, end: 330, score: 8, layout: "track"),
            Clip(start: 305, end: 335, score: 9, layout: "fit"),
            Clip(start: 550, end: 580, score: 7, layout: "fit"),
            Clip(start: 590, end: 620, score: 10, layout: "track"),
            Clip(start: .nan, end: 30, score: 10, layout: "fit")
        ], interval: (300, 600), targetDuration: 30, count: 3)
        precondition(valid.count == 2 && valid[0].start == 305 && valid[1].start == 550)
        let unused = try GeminiSelection.validate([
            Clip(start: 300, end: 330, score: 10, layout: "track"), Clip(start: 550, end: 580, score: 7, layout: "fit")
        ], interval: (300, 600), targetDuration: 30, count: 2, excluding: [.init(start: 300, end: 330)])
        precondition(unused.count == 1 && unused[0].start == 550, "Existing source spans must not be selected again")
        do {
            _ = try GeminiSelection.validate([], interval: (0, 60), targetDuration: 30, count: 3)
            preconditionFailure("Empty plans must fail")
        } catch GeminiSelection.Failure.invalidResponse {}
        do {
            _ = try GeminiSelection.validate([Clip(start: 5, end: 35, score: 5.9, layout: "fit")],
                interval: (0, 60), targetDuration: 30, count: 1)
            preconditionFailure("Weak moments must not be returned as finished Shorts")
        } catch GeminiSelection.Failure.noStrongClips {}
        do {
            _ = try GeminiSelection.validate([Clip(start: 5, end: 35, score: 6.9, layout: "fit")],
                interval: (0, 60), targetDuration: 30, count: 1)
            preconditionFailure("Borderline moments must not be returned as finished Shorts")
        } catch GeminiSelection.Failure.noStrongClips {}
        let fallback = try GeminiSelection.strongestOrBest([Clip(start: 5, end: 35, score: 6, layout: "fit", reason: "Good hook.")],
            interval: (0, 100), targetDuration: 30, count: 1, excluding: [])
        precondition(fallback.count == 1 && fallback[0].reason?.hasPrefix("Weaker pick") == true && fallback[0].reason?.hasSuffix("Good hook.") == true,
                     "With no clip scoring 7, the best 5–6 clip must be used and labeled, not fail the run")
        do {
            _ = try GeminiSelection.strongestOrBest([Clip(start: 5, end: 35, score: 4, layout: "fit")],
                interval: (0, 100), targetDuration: 30, count: 1, excluding: [])
            fatalError("A clip scoring below 5 must still be rejected")
        } catch GeminiSelection.Failure.noStrongClips {}
        let ranking = try GeminiSelection.rankedWindowIDs([
            .init(id: 0, score: 20), .init(id: 1, score: 10), .init(id: 2, score: 95)
        ], expected: [0, 1, 2])
        precondition(ranking == [2, 0, 1], "Late moments must win by quality, not position")
        let rated = try JSONDecoder().decode([GeminiSelection.WindowScore].self, from: Data("""
            [{"id":0,"hook":9,"payoff":8,"standalone":9,"emotion":5,"novelty":6},
             {"id":1,"hook":10,"payoff":9,"standalone":3,"emotion":9,"novelty":9},
             {"id":2,"score":55}]
            """.utf8))
        precondition(abs(rated[0].score - 80.5) < 0.01 && rated[1].score < 70 && rated[2].score == 55,
                     "Criteria must combine into one score, and a window that doesn't stand alone must fall below the clip line: \(rated.map(\.score))")
        do {
            _ = try JSONDecoder().decode(GeminiSelection.WindowScore.self, from: Data(#"{"id":0,"hook":11,"payoff":8,"standalone":9,"emotion":5,"novelty":6}"#.utf8))
            preconditionFailure("Out-of-range criteria must be rejected")
        } catch {}
        do {
            _ = try GeminiSelection.rankedWindowIDs([.init(id: 0, score: 50), .init(id: 0, score: 90)], expected: [0, 1])
            preconditionFailure("Duplicate or missing scoring ids must fail the complete pass")
        } catch GeminiSelection.Failure.invalidResponse {}
        let words = try GeminiSelection.validatedWords([
            .init(text: "Hello", start: 0.1, end: 0.5), .init(text: "world.", start: 0.6, end: 1)
        ], offset: 300, duration: 60)
        let cues = GeminiSelection.captionCues(words)
        precondition(cues.count == 1 && cues[0].text == "Hello world." && cues[0].start == 300.1)
        let boundedCaptions = GeminiSelection.captionCues([
            .init(text: "Outside", start: 0, duration: 0.5), .init(text: "Inside.", start: 1, duration: 1)
        ], interval: (1, 3))
        precondition(boundedCaptions.count == 1 && boundedCaptions[0].text == "Inside.",
                     "Captions must not contain words outside the selected audio range")
        do {
            _ = try GeminiSelection.validatedWords([.init(text: "bad", start: 2, end: 1)], offset: 0, duration: 60)
            preconditionFailure("Invalid timing must fail")
        } catch GeminiSelection.Failure.invalidTiming {}
        do {
            _ = try GeminiSelection.validatedWords([.init(text: "outside", start: 61, end: 62)], offset: 0, duration: 60)
            preconditionFailure("Out of range speech must fail")
        } catch GeminiSelection.Failure.invalidTiming {}
        let approximate = try GeminiSelection.validatedWords([
            .init(text: "First", start: 0.1, end: 0.6), .init(text: "word.", start: 0.5, end: 1)
        ], offset: 120, duration: 60)
        precondition(approximate.count == 2 && abs(approximate[0].start + approximate[0].duration - approximate[1].start) < 0.001)
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [GeminiMockProtocol.self]
        let session = URLSession(configuration: config)
        defer { session.invalidateAndCancel() }
        struct Check: Decodable { let ok: Bool }
        var configuration = GeminiConfiguration()
        configuration.accessToken = { "test-token" }
        configuration.usage = testUsage
        do {
            _ = try await GeminiSelection.select(url: URL(fileURLWithPath: "/tmp/relio-mock-missing.mov"), cues: [],
                interval: (0, 60), targetDuration: 30, count: 1, configuration: configuration,
                excluding: [.init(start: 0, end: 60)], session: session)
            preconditionFailure("Fully used regions must stop before any cloud calls")
        } catch GeminiSelection.Failure.noDistinctClips { }
        let result: Check = try await GeminiSelection.generate(parts: [["text": "check"]], schema: [:], configuration: configuration, session: session)
        precondition(result.ok)
        // An overloaded model gets several growing waits (shortened here), each announced; one that stays busy still fails.
        GeminiSelection.retryWaits = [0.01, 0.01, 0.01, 0.01, 0.01]
        let notes = NoteBox()
        var announcing = configuration
        announcing.onRetry = { notes.values.append($0) }
        GeminiMockProtocol.statuses = [503, 503, 503, 500, 200]
        let recovered: Check = try await GeminiSelection.generate(parts: [], schema: [:], configuration: announcing, session: session)
        precondition(recovered.ok && GeminiMockProtocol.statuses.isEmpty && notes.values.count == 4
                     && notes.values.allSatisfy { $0.hasPrefix("Prism AI is busy") }, "A busy streak must be retried and shown: \(notes.values)")
        // Every request names its video and needs a signed-in session: nothing runs free.
        var noVideo = GeminiConfiguration()
        noVideo.accessToken = { "test-token" }
        do {
            let _: Check = try await GeminiSelection.generate(parts: [], schema: [:], configuration: noVideo, session: session)
            preconditionFailure("A request without a video must not reach the server")
        } catch GeminiSelection.Failure.signInUnavailable { }
        var signedOut = GeminiConfiguration()
        signedOut.usage = testUsage
        do {
            let _: Check = try await GeminiSelection.generate(parts: [], schema: [:], configuration: signedOut, session: session)
            preconditionFailure("A request without a session must not reach the server")
        } catch GeminiSelection.Failure.signInUnavailable { }
        print("PASS busy servers are retried and the wait is shown")
        let audioURL = FileManager.default.temporaryDirectory.appendingPathComponent("relio-audio-test-\(UUID()).caf")
        defer { try? FileManager.default.removeItem(at: audioURL) }
        let format = AVAudioFormat(standardFormatWithSampleRate: 16_000, channels: 1)!
        let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: 960_000)!
        buffer.frameLength = 960_000
        buffer.floatChannelData![0].initialize(repeating: 0, count: Int(buffer.frameLength))
        let audio = try AVAudioFile(forWriting: audioURL, settings: format.settings)
        try audio.write(from: buffer)
        GeminiMockProtocol.payloads = [
            "{\"words\":[{\"text\":\"bad\",\"start\":0,\"end\":16}]}",
            "{\"words\":[{\"text\":\"First.\",\"start\":0.1,\"end\":1}]}",
            "{\"words\":[{\"text\":\"Second.\",\"start\":0.1,\"end\":1}]}",
            "{\"words\":[{\"text\":\"Third.\",\"start\":0.1,\"end\":1}]}"
        ]
        let stretches = NoteBox()
        let recoveredWords = try await GeminiSelection.transcribe(url: audioURL, interval: (0, 30), configuration: configuration, session: session,
                                                                  concurrency: 1, finished: { words, end in stretches.values.append("\(words.count)@\(end)") })
        precondition(recoveredWords.count == 3 && abs(recoveredWords[1].start - 7.6) < 0.001 && abs(recoveredWords[2].start - 15.1) < 0.001 && GeminiMockProtocol.payloads.isEmpty,
                     "Invalid long-chunk timing must recover in smaller chunks without losing absolute offsets: \(recoveredWords)")
        precondition(stretches.values == ["2@15.0", "3@30.0"], "Each finished stretch from the start must be handed back for saving: \(stretches.values)")
        // Chunks run side by side, yet words come back in source order.
        GeminiMockProtocol.payloads = (0..<4).map { _ in "{\"words\":[{\"text\":\"Word.\",\"start\":1,\"end\":2}]}" }
        let parallelWords = try await GeminiSelection.transcribe(url: audioURL, interval: (0, 60), configuration: configuration, session: session)
        precondition(parallelWords.map(\.start) == [1, 16, 31, 46] && GeminiMockProtocol.payloads.isEmpty, "Parallel chunks must keep source order: \(parallelWords.map(\.start))")
        GeminiMockProtocol.payloads = ["{\"segments\":[{\"text\":\"One complete sentence.\",\"start\":0.1,\"end\":10}]}"]
        let sentences = try await GeminiSelection.transcribeSentences(url: audioURL, interval: (0, 60), configuration: configuration, session: session)
        precondition(sentences.count == 1 && sentences[0].text == "One complete sentence." && sentences[0].start == 0.1,
                     "Coarse narration analysis must retain complete sentence text without word-level output")
        GeminiMockProtocol.finish = "MAX_TOKENS"
        do {
            let _: Check = try await GeminiSelection.generate(parts: [], schema: [:], configuration: configuration, session: session)
            preconditionFailure("Truncated responses must fail")
        } catch GeminiSelection.Failure.invalidResponse {}
        GeminiMockProtocol.status = 429
        do {
            let _: Check = try await GeminiSelection.generate(parts: [], schema: [:], configuration: configuration, session: session)
            preconditionFailure("Quota errors must fail")
        } catch GeminiSelection.Failure.server(let code, _) { precondition(code == 429) }
        GeminiMockProtocol.status = 200
        GeminiMockProtocol.finish = "STOP"
        let longCues = (0..<120).map { TimedCaption(text: "Complete story \($0).", start: Double($0 * 10), duration: 8) }
        let windows = TranscriptSelection.windows(longCues, interval: (0, 1200))
        for ids in TranscriptSelection.batches(Array(windows.indices), size: 6) {
            let payload: [String: Any] = ["windows": ids.map { ["id": $0, "score": Double($0)] }]
            GeminiMockProtocol.payloads.append(String(decoding: try JSONSerialization.data(withJSONObject: payload), as: UTF8.self))
        }
        // Must match the shortlist size in GeminiSelection.select for a 1200-second source.
        let shortlistSize = min(16, Int(1200.0 / 90) + 2)
        let bestIDs = Array(windows.indices.reversed().prefix(shortlistSize))
        for ids in TranscriptSelection.batches(bestIDs, size: 3) {
            let id = ids[0]
            // The best clip drifts 1s before its window; it must be clamped, not dropped.
            let payload: [String: Any] = ["clips": [["start": windows[id].start - (id == windows.count - 1 ? 1 : 0), "end": windows[id].start + 30,
                "score": id == windows.count - 1 ? 10 : 7, "layout": "fit"]]]
            GeminiMockProtocol.payloads.append(String(decoding: try JSONSerialization.data(withJSONObject: payload), as: UTF8.self))
        }
        let planned = try await GeminiSelection.select(url: URL(fileURLWithPath: "/tmp/relio-mock-missing.mov"), cues: longCues,
            interval: (0, 1200), targetDuration: 30, count: 1, configuration: configuration, detailConcurrency: 1, session: session)
        precondition(planned.first?.start == windows.last!.start, "Multi-batch cloud selection must preserve the strongest late moment")
        precondition(planned.count == 4, "Distinct runner-up finalists must follow the picks as backups")
        precondition(GeminiMockProtocol.payloads.isEmpty, "Every scoring and detail batch must run")
        // Final editor pass: it may pick a lower-scored finalist, and ignores repeated or unknown ids.
        let finalists = [Clip(start: 0, end: 30, score: 10, layout: "fit", title: "Same story"),
                         Clip(start: 100, end: 130, score: 8, layout: "fit", title: "Different story")]
        GeminiMockProtocol.payloads = ["{\"ids\":[1,1,7]}"]
        let cut = await GeminiSelection.finalCut(finalists, cues: [], count: 2, guidance: "", configuration: configuration, session: session)
        precondition(cut?.map(\.title) == ["Different story"], "Final cut keeps the editor's order and drops duplicate or invalid ids")
        GeminiMockProtocol.payloads = ["not json"]
        let failedCut = await GeminiSelection.finalCut(finalists, cues: [], count: 1, guidance: "", configuration: configuration, session: session)
        precondition(failedCut == nil, "A failed final cut must fall back to score order")
        // A per-minute quota error with a short retryDelay is waited out; without one it still fails.
        for invalid in ["-1", "-Infinity", "NaN", "Infinity"] {
            let http = HTTPURLResponse(url: URL(string: "https://example.invalid")!, statusCode: 429, httpVersion: nil, headerFields: ["Retry-After": invalid])!
            let body = try JSONSerialization.data(withJSONObject: ["error": ["details": [["retryDelay": "\(invalid)s"]]]])
            precondition(GeminiSelection.retryDelay(http: http, body: body) == nil, "Malformed retry delays must never reach sleep or integer conversion")
        }
        GeminiMockProtocol.errorBody = "{\"error\":{\"code\":429,\"details\":[{\"retryDelay\":\"0s\"}]}}"
        GeminiMockProtocol.statuses = [429, 200]
        let waited: Check = try await GeminiSelection.generate(parts: [], schema: [:], configuration: configuration, session: session)
        precondition(waited.ok && GeminiMockProtocol.statuses.isEmpty, "Short per-minute quota waits must retry")
        GeminiMockProtocol.errorBody = "{\"error\":{\"code\":429,\"details\":[{\"retryDelay\":\"3600s\"}]}}"
        GeminiMockProtocol.statuses = [429]
        do {
            let _: Check = try await GeminiSelection.generate(parts: [], schema: [:], configuration: configuration, session: session)
            preconditionFailure("Long quota waits must fail instead of hanging")
        } catch GeminiSelection.Failure.server(let code, _) { precondition(code == 429) }
        GeminiMockProtocol.errorBody = nil
        // One failed detail batch must not sink the batches that found clips.
        GeminiMockProtocol.payloads = []
        for ids in TranscriptSelection.batches(Array(windows.indices), size: 6) {
            let payload: [String: Any] = ["windows": ids.map { ["id": $0, "score": Double($0)] }]
            GeminiMockProtocol.payloads.append(String(decoding: try JSONSerialization.data(withJSONObject: payload), as: UTF8.self))
        }
        let scoringCount = GeminiMockProtocol.payloads.count
        GeminiMockProtocol.statuses = Array(repeating: 200, count: scoringCount) + [400]
        GeminiMockProtocol.payloads.append("{}") // consumed by the failing batch's 400 response
        for (index, ids) in TranscriptSelection.batches(bestIDs, size: 3).enumerated() where index > 0 {
            let id = ids[0]
            let payload: [String: Any] = ["clips": [["start": windows[id].start, "end": windows[id].start + 30, "score": 8, "layout": "fit"]]]
            GeminiMockProtocol.payloads.append(String(decoding: try JSONSerialization.data(withJSONObject: payload), as: UTF8.self))
        }
        let survived = try await GeminiSelection.select(url: URL(fileURLWithPath: "/tmp/relio-mock-missing.mov"), cues: longCues,
            interval: (0, 1200), targetDuration: 30, count: 1, configuration: configuration, detailConcurrency: 1, session: session)
        precondition(!survived.isEmpty, "A failed detail batch must not fail the whole run")
        GeminiMockProtocol.payloads = []; GeminiMockProtocol.statuses = []
        let pipelineURL = FileManager.default.temporaryDirectory.appendingPathComponent("relio-cloud-pipeline-\(UUID()).mp4")
        defer { try? FileManager.default.removeItem(at: pipelineURL) }
        let pictures = AVURLAsset(url: URL(fileURLWithPath: "test-output/pictures.mov"))
        let audioAsset = AVURLAsset(url: audioURL)
        let composition = AVMutableComposition()
        let videoTrack = composition.addMutableTrack(withMediaType: .video, preferredTrackID: kCMPersistentTrackID_Invalid)!
        let audioTrack = composition.addMutableTrack(withMediaType: .audio, preferredTrackID: kCMPersistentTrackID_Invalid)!
        let inputVideo = try await pictures.loadTracks(withMediaType: .video)[0]
        let inputAudio = try await audioAsset.loadTracks(withMediaType: .audio)[0]
        let videoLength = try await pictures.load(.duration)
        var position = CMTime.zero
        let fixtureDuration = CMTime(seconds: 20, preferredTimescale: 600)
        while position < fixtureDuration {
            let length = CMTimeMinimum(videoLength, fixtureDuration - position)
            try videoTrack.insertTimeRange(CMTimeRange(start: .zero, duration: length), of: inputVideo, at: position)
            position = position + length
        }
        try audioTrack.insertTimeRange(CMTimeRange(start: .zero, duration: fixtureDuration), of: inputAudio, at: .zero)
        let export = AVAssetExportSession(asset: composition, presetName: AVAssetExportPreset640x480)!
        export.outputURL = pipelineURL; export.outputFileType = .mp4
        await export.export()
        precondition(export.status == .completed)
        // Gemini framing: a subject reported on the right moves the crop right; a failed request holds the crop steady.
        let framed: [String: Any] = ["wholeFrame": false, "frames": (0..<8).map { ["index": $0, "found": true, "center": 0.8, "width": 0.1, "faces": [0.8]] }]
        GeminiMockProtocol.payloads = [String(decoding: try JSONSerialization.data(withJSONObject: framed), as: UTF8.self)]
        GeminiMockProtocol.bodies = []
        let path = await SubjectFramer.analyze(pipelineURL, start: 0, duration: 4, zoom: 1.08, configuration: configuration,
                                               speech: [TimedCaption(text: "Who is talking now?", start: 0.5, duration: 2)], session: session)
        precondition(GeminiMockProtocol.bodies.last?.contains("Who is talking now?") == true && GeminiMockProtocol.bodies.last?.contains("Frame 1 at 1.0 s") == true,
                     "Framing must see who talks when and each frame's time")
        precondition(!path.isEmpty && path.allSatisfy { $0.position > 0.6 }, "Gemini's subject position must steer the crop: \(path)")
        GeminiMockProtocol.payloads = ["not json"]
        let steady = await SubjectFramer.analyze(pipelineURL, start: 0, duration: 4, zoom: 1.08, configuration: configuration, session: session)
        precondition(steady.isEmpty && GeminiMockProtocol.payloads.isEmpty, "A failed framing request must leave the crop steady")
        print("PASS Gemini framing steers the crop and falls back to a steady crop on failure")
        let knownText = "Here is a complete story with a useful ending."
        GeminiMockProtocol.statuses = [200, 200, 200, 429]
        GeminiMockProtocol.payloads = [
            "{\"segments\":[{\"text\":\"\(knownText)\",\"start\":1,\"end\":19}]}",
            "{\"windows\":[{\"id\":0,\"score\":90}]}",
            "{\"clips\":[{\"start\":1,\"end\":19,\"score\":9,\"layout\":\"fit\",\"title\":\"Complete story\",\"reason\":\"Hook and payoff.\"}]}",
            "{}"
        ]
        let cloudConfiguration: GeminiConfiguration = {
            var signedIn = GeminiConfiguration(session: session)
            signedIn.accessToken = { "test-token" }
            signedIn.usage = testUsage
            return signedIn
        }()
        let savedTranscript = TranscriptBox()
        let recoveredClips = try await ShortMaker.analyze(pipelineURL, requestedDuration: 15, count: 1,
            sourceRegion: .entireVideo, gemini: cloudConfiguration, onTranscript: { savedTranscript.value = $0 })
        precondition(recoveredClips.count == 1 && recoveredClips[0].speechWords.isEmpty && recoveredClips[0].fitToFrame)
        precondition(recoveredClips[0].captions.map(\.text).joined(separator: " ") == knownText)
        precondition(recoveredClips[0].analysisWarning?.contains("sentence timing") == true)
        precondition(GeminiMockProtocol.statuses.isEmpty && GeminiMockProtocol.payloads.isEmpty)
        precondition(savedTranscript.value?.cues.map(\.text) == [knownText], "A fresh transcription must be handed back for saving")
        // A second run on the same video reuses that transcript: the queue below has no transcription response,
        // so any transcription request would consume the scoring reply and fail the run.
        GeminiMockProtocol.statuses = [200, 200, 429]
        GeminiMockProtocol.payloads = [
            "{\"windows\":[{\"id\":0,\"score\":90}]}",
            "{\"clips\":[{\"start\":1,\"end\":19,\"score\":9,\"layout\":\"fit\",\"title\":\"Complete story\",\"reason\":\"Hook and payoff.\"}]}",
            "{}"
        ]
        GeminiMockProtocol.bodies = []
        let reused = try await ShortMaker.analyze(pipelineURL, requestedDuration: 15, count: 1,
            sourceRegion: .entireVideo, gemini: cloudConfiguration, videoType: .podcast, cachedTranscript: savedTranscript.value)
        precondition(GeminiMockProtocol.bodies.count >= 2 && GeminiMockProtocol.bodies.prefix(2).allSatisfy { $0.contains("This is a podcast or interview") },
                     "The video type's guidance must reach both the scoring and the clip-picking prompts")
        precondition(reused.count == 1 && reused[0].captions.map(\.text).joined(separator: " ") == knownText,
                     "A saved transcript must give the same Short without transcribing again")
        precondition(GeminiMockProtocol.statuses.isEmpty && GeminiMockProtocol.payloads.isEmpty)
        precondition(savedTranscript.value?.cues(covering: (0, 30)) == nil, "A transcript must not be reused for a longer range than it covers")
        print("PASS a saved transcript is reused on the next run, with no transcription request")
        // A run that failed partway saved its first stretch; the next run transcribes only the rest.
        GeminiMockProtocol.statuses = [200, 200, 200, 429]
        GeminiMockProtocol.payloads = [
            "{\"segments\":[{\"text\":\"With a useful ending.\",\"start\":0.5,\"end\":8}]}",
            "{\"windows\":[{\"id\":0,\"score\":90}]}",
            "{\"clips\":[{\"start\":1,\"end\":18,\"score\":9,\"layout\":\"fit\",\"title\":\"Complete story\",\"reason\":\"Hook and payoff.\"}]}",
            "{}"
        ]
        let partial = SentenceTranscript(start: 0, end: 10, cues: [TimedCaption(text: "Here is a complete story.", start: 1, duration: 8)])
        let resumedBox = TranscriptBox()
        let resumed = try await ShortMaker.analyze(pipelineURL, requestedDuration: 15, count: 1, sourceRegion: .entireVideo,
            gemini: cloudConfiguration, cachedTranscript: partial, onTranscript: { resumedBox.value = $0 })
        precondition(resumedBox.value?.cues.map(\.text) == ["Here is a complete story.", "With a useful ending."]
                     && resumedBox.value?.cues.last?.start == 10.5 && resumedBox.value?.end == 20 && GeminiMockProtocol.payloads.isEmpty,
                     "A partly saved transcript must be resumed, not redone: \(String(describing: resumedBox.value))")
        precondition(resumed.count == 1)
        print("PASS a transcription that failed partway resumes from its saved stretch")
        // Auto-detect asks once, then the detected type steers both picking prompts; a bad answer means "general".
        let windowsReply = "{\"windows\":[{\"id\":0,\"score\":90}]}"
        let clipsReply = "{\"clips\":[{\"start\":1,\"end\":19,\"score\":9,\"layout\":\"fit\",\"title\":\"Complete story\",\"reason\":\"Hook and payoff.\"}]}"
        for (answer, expectsPodcast) in [("podcast", true), ("cooking", false)] {
            GeminiMockProtocol.statuses = [200, 200, 200, 429]
            GeminiMockProtocol.payloads = ["{\"type\":\"\(answer)\"}", windowsReply, clipsReply, "{}"]
            GeminiMockProtocol.bodies = []
            let detected = try await ShortMaker.analyze(pipelineURL, requestedDuration: 15, count: 1, sourceRegion: .entireVideo,
                gemini: cloudConfiguration, videoType: .auto, cachedTranscript: savedTranscript.value)
            precondition(detected.count == 1 && GeminiMockProtocol.payloads.isEmpty, "Auto-detect must not break the run (\(answer))")
            let steered = GeminiMockProtocol.bodies.count >= 3 && GeminiMockProtocol.bodies[1...2].allSatisfy { $0.contains("This is a podcast or interview") }
            precondition(steered == expectsPodcast, "Detected type must steer the picks only when recognized (\(answer))")
        }
        print("PASS auto-detect classifies once, steers the picks, and falls back to general on an unknown answer")
        GeminiMockProtocol.statuses = [200, 429]
        GeminiMockProtocol.payloads = ["{\"segments\":[{\"text\":\"\(knownText)\",\"start\":1,\"end\":19}]}", "{}"]
        let regenerated = try await GeminiSelection.regenerateCaptions(url: audioURL, interval: (0, 20), configuration: cloudConfiguration)
        precondition(regenerated.words.isEmpty && regenerated.cues.map(\.text).joined(separator: " ") == knownText && regenerated.notice != nil,
                     "Subtitle regeneration must use the same complete, labelled fallback")
        precondition(GeminiMockProtocol.statuses.isEmpty && GeminiMockProtocol.payloads.isEmpty)
        print("PASS cloud pipeline keeps complete sentence captions when optional word alignment hits quota; no local AI or paid requests used")
        print("PASS Gemini range validation, duplicates, transcript offsets, invalid timing, credential transport, structured output, truncation and quota errors")
    }
}
