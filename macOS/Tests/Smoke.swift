import Foundation
import AVFoundation
import AppKit
import CSQLite

@main struct Smoke {
    /// The editor plays edits live: ready at once, with the Fit background drawn per frame like export.
    @MainActor static func checkLivePreview(source: URL, mediaID: UUID) async throws {
        let started = Date()
        let item = try await ShortMaker.previewItem(source: source, segment: EditSegment(mediaID: mediaID, duration: 3, fitToFrame: true))
        let elapsed = Date().timeIntervalSince(started)
        precondition(elapsed < 1, "Live preview must be ready in under a second, took \(elapsed)s")
        let generator = AVAssetImageGenerator(asset: item.asset)
        generator.videoComposition = item.videoComposition
        generator.requestedTimeToleranceBefore = .zero
        generator.requestedTimeToleranceAfter = .zero
        let frame = try generator.copyCGImage(at: CMTime(seconds: 1.5, preferredTimescale: 600), actualTime: nil)
        precondition(frame.width == 1080 && frame.height == 1920, "Live preview must be 1080×1920")
        let bitmap = NSBitmapImageRep(cgImage: frame)
        func pixel(_ x: Int, _ y: Int) -> NSColor { bitmap.colorAt(x: x, y: y)!.usingColorSpace(.deviceRGB)! }
        precondition(pixel(540, 100).greenComponent > 0.12 && pixel(540, 1820).greenComponent > 0.12,
                     "Live Fit preview must fill both portrait bars with the blurred source")
        precondition(pixel(900, 960).greenComponent > pixel(900, 960).redComponent * 1.3 && pixel(900, 960).greenComponent > 0.35,
                     "Live Fit preview must keep the sharp source in the center")
        try bitmap.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: "test-output/live-fit-preview-frame.png"))
        precondition(ShortMaker.captionLayer(for: EditSegment(mediaID: mediaID, duration: 3)) == nil &&
                     ShortMaker.captionLayer(for: EditSegment(mediaID: mediaID, duration: 3, caption: "Hi"))?.sublayers?.count == 1,
                     "Preview captions must come from the same layers as export")
        print(String(format: "PASS live preview ready in %.2fs and draws the Fit background like export", elapsed))
    }

    /// Phone video stores frames sideways with a 90° transform. Fit and Split draw with Core Image (y-up), so the
    /// transform must be mirrored or the picture comes out upside down. The frame generator's oriented frame is the truth.
    static func checkRotatedLayouts(in root: URL) async throws {
        let url = root.appendingPathComponent("rotated.mov")
        let writer = try AVAssetWriter(outputURL: url, fileType: .mov)
        let input = AVAssetWriterInput(mediaType: .video, outputSettings: [AVVideoCodecKey: AVVideoCodecType.h264, AVVideoWidthKey: 360, AVVideoHeightKey: 640])
        input.transform = CGAffineTransform(a: 0, b: 1, c: -1, d: 0, tx: 640, ty: 0)
        let attributes: [String: Any] = [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32ARGB, kCVPixelBufferWidthKey as String: 360, kCVPixelBufferHeightKey as String: 640]
        let adaptor = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: input, sourcePixelBufferAttributes: attributes)
        writer.add(input)
        guard writer.startWriting() else { throw writer.error ?? NSError(domain: "RelioSmoke", code: 4) }
        writer.startSession(atSourceTime: .zero)
        for frame in 0..<60 {
            while !input.isReadyForMoreMediaData { try await Task.sleep(for: .milliseconds(10)) }
            var buffer: CVPixelBuffer?
            CVPixelBufferCreate(kCFAllocatorDefault, 360, 640, kCVPixelFormatType_32ARGB, attributes as CFDictionary, &buffer)
            guard let pixel = buffer else { fatalError("No pixel buffer") }
            CVPixelBufferLockBaseAddress(pixel, [])
            let context = CGContext(data: CVPixelBufferGetBaseAddress(pixel), width: 360, height: 640, bitsPerComponent: 8, bytesPerRow: CVPixelBufferGetBytesPerRow(pixel), space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.noneSkipFirst.rawValue)!
            for (rect, color) in [(CGRect(x: 0, y: 320, width: 180, height: 320), NSColor.red), (CGRect(x: 180, y: 320, width: 180, height: 320), .green),
                                  (CGRect(x: 0, y: 0, width: 180, height: 320), .blue), (CGRect(x: 180, y: 0, width: 180, height: 320), .yellow)] {
                context.setFillColor(color.cgColor); context.fill(rect)
            }
            CVPixelBufferUnlockBaseAddress(pixel, [])
            guard adaptor.append(pixel, withPresentationTime: CMTime(value: Int64(frame), timescale: 30)) else { throw writer.error ?? NSError(domain: "RelioSmoke", code: 5) }
        }
        input.markAsFinished()
        await writer.finishWriting()
        func frame(_ asset: AVAsset, _ composition: AVVideoComposition? = nil) throws -> NSBitmapImageRep {
            let generator = AVAssetImageGenerator(asset: asset)
            generator.appliesPreferredTrackTransform = true
            generator.videoComposition = composition
            return NSBitmapImageRep(cgImage: try generator.copyCGImage(at: CMTime(seconds: 1, preferredTimescale: 600), actualTime: nil))
        }
        func colors(_ bitmap: NSBitmapImageRep, _ points: [(Double, Double)]) -> String {
            points.map { x, y in
                let c = bitmap.colorAt(x: Int(x), y: Int(y))!.usingColorSpace(.deviceRGB)!
                return "\(c.redComponent > 0.5 ? "R" : "")\(c.greenComponent > 0.5 ? "G" : "")\(c.blueComponent > 0.5 ? "B" : "")"
            }.joined(separator: ",")
        }
        // Oriented 640×360 corners: top-left, top-right, bottom-left, bottom-right.
        let truth = try frame(AVURLAsset(url: url))
        let corners = colors(truth, [(160, 90), (480, 90), (160, 270), (480, 270)])
        let parts = corners.split(separator: ",")
        // Fit shows the whole frame across 1080×607 in the middle; Split puts the left half on top, the right half below.
        let checks: [(EditSegment, [(Double, Double)], String)] = [
            (EditSegment(mediaID: UUID(), duration: 1.5, fitToFrame: true), [(270, 808), (810, 808), (270, 1112), (810, 1112)], corners),
            ({ var s = EditSegment(mediaID: UUID(), duration: 1.5); s.splitScreen = true; return s }(),
             [(540, 240), (540, 720), (540, 1200), (540, 1680)], [parts[0], parts[2], parts[1], parts[3]].joined(separator: ","))
        ]
        for (segment, points, expected) in checks {
            let preview = try await ShortMaker.previewItem(source: url, segment: segment)
            let exported = root.appendingPathComponent("rotated-\(UUID()).mp4")
            try await ShortMaker.export(source: url, segment: segment, destination: exported)
            for (name, bitmap) in [("preview", try frame(preview.asset, preview.videoComposition)), ("export", try frame(AVURLAsset(url: exported)))] {
                let got = colors(bitmap, points)
                precondition(got == expected, "Rotated video \(segment.splitScreen == true ? "Split" : "Fit") \(name) is misoriented: \(got), expected \(expected)")
            }
        }
        print("PASS rotated phone video keeps its orientation in Fit and Split, preview and export")
    }

    /// Tone with pauses at 2.0–2.4 s and 5.0–5.5 s: cuts placed inside the sound move into the nearest pause.
    static func checkSilenceSnapping(in root: URL) async throws {
        let url = root.appendingPathComponent("pauses.caf")
        let format = AVAudioFormat(standardFormatWithSampleRate: 16_000, channels: 1)!
        let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: 128_000)!
        buffer.frameLength = 128_000
        for index in 0..<128_000 {
            let t = Double(index) / 16_000
            let pause = (2.0..<2.4).contains(t) || (5.0..<5.5).contains(t)
            buffer.floatChannelData![0][index] = pause ? 0 : Float(0.4 * sin(2 * .pi * 220 * t))
        }
        try AVAudioFile(forWriting: url, settings: format.settings).write(from: buffer)
        // Real videos carry 48 kHz stereo AAC; the reader converts it to the 16 kHz mono it measures.
        let aac = root.appendingPathComponent("pauses.m4a")
        let stereo = AVAudioFormat(standardFormatWithSampleRate: 48_000, channels: 2)!
        let stereoBuffer = AVAudioPCMBuffer(pcmFormat: stereo, frameCapacity: 384_000)!
        stereoBuffer.frameLength = 384_000
        for index in 0..<384_000 {
            let value = buffer.floatChannelData![0][index / 3]
            stereoBuffer.floatChannelData![0][index] = value
            stereoBuffer.floatChannelData![1][index] = value
        }
        // The file is finished only when the AVAudioFile is released, so it is written in one statement.
        try AVAudioFile(forWriting: aac, settings: [AVFormatIDKey: kAudioFormatMPEG4AAC, AVSampleRateKey: 48_000, AVNumberOfChannelsKey: 2]).write(from: stereoBuffer)
        for file in [url, aac] {
            let snapped = await ShortMaker.silenceSnapped(url: file, start: 2.55, duration: 2.3, interval: (0, 8))
            precondition((2.0...2.42).contains(snapped.start) && (5.0...5.52).contains(snapped.start + snapped.duration),
                         "Cuts must move into the nearest pauses (\(file.pathExtension)): \(snapped)")
        }
        let solid = await ShortMaker.silenceSnapped(url: url, start: 0.8, duration: 0.7, interval: (0, 8))
        precondition(solid.start == 0.8 && solid.duration == 0.7, "Without a pause nearby the cut must stay")
        let protected = await ShortMaker.silenceSnapped(url: url, start: 2.55, duration: 2.3, interval: (0, 8),
                                                        words: [TimedSpeechWord(text: "pause", start: 1.9, duration: 0.6)])
        precondition(protected.start == 2.55, "A pause inside a timed word is not a real pause")
        func words(_ texts: [String]) -> [TimedSpeechWord] { texts.enumerated().map { TimedSpeechWord(text: $1, start: 10 + Double($0) * 0.4, duration: 0.3) } }
        let opened = ShortMaker.strongOpening(start: 9.9, duration: 20, words: words(["So,", "um,", "nobody", "expected", "this."]), minDuration: 5)
        precondition(abs(opened.start - 10.72) < 0.001 && abs(opened.start + opened.duration - 29.9) < 0.001, "Weak openers must be dropped: \(opened)")
        let kept = ShortMaker.strongOpening(start: 9.9, duration: 20, words: words(["Nobody", "expected", "this."]), minDuration: 5)
        precondition(kept.start == 9.9, "A strong opening must stay")
        let meaningful = ShortMaker.strongOpening(start: 9.9, duration: 20, words: words(["Like", "most", "people,", "I", "panicked."]), minDuration: 5)
        precondition(meaningful.start == 9.9, "Words that carry meaning at the start, like \"Like most people\", must stay")
        let short = ShortMaker.strongOpening(start: 9.9, duration: 1, words: words(["So", "go."]), minDuration: 1)
        precondition(short.start == 9.9, "Trimming must not break the minimum length")
        print("PASS cuts snap into the nearest audio pause, never into a word; weak openers are dropped")
    }

    static func main() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("RelioTest-\(UUID())")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        ShortMaker.renderCacheDirectory = root.appendingPathComponent("Render cache")
        try FileManager.default.createDirectory(at: ShortMaker.renderCacheDirectory, withIntermediateDirectories: true)
        for name in ["fit-finished.mp4", "split-finished.mp4", ".relio-fit-in-progress.mp4", "unrelated.txt"] {
            try Data().write(to: ShortMaker.renderCacheDirectory.appendingPathComponent(name))
        }
        ShortMaker.pruneRenderCache(keeping: 0)
        let kept = try FileManager.default.contentsOfDirectory(atPath: ShortMaker.renderCacheDirectory.path)
        precondition(Set(kept) == [".relio-fit-in-progress.mp4", "unrelated.txt"], "Pruning must preserve unfinished renders and unrelated files")
        print("PASS render cache pruning preserves in-progress renders")
        let source = root.appendingPathComponent("pictures.mov")
        try await makePictureVideo(at: source)
        let copiedSource = root.appendingPathComponent("original copy.mov")
        try await ShortMaker.copySource(source, to: copiedSource)
        let originalBytes = try Data(contentsOf: source)
        let copiedBytes = try Data(contentsOf: copiedSource)
        precondition(originalBytes == copiedBytes, "Original copies must keep every byte")
        do {
            try await ShortMaker.copySource(source, to: copiedSource)
            preconditionFailure("Copy must not replace an existing export")
        } catch ShortMaker.Failure.destinationExists { }
        let cancelledCopy = root.appendingPathComponent("cancelled copy.mov")
        let copyTask = Task {
            withUnsafeCurrentTask { $0?.cancel() }
            try await ShortMaker.copySource(source, to: cancelledCopy)
        }
        do { try await copyTask.value; preconditionFailure("Cancelled copies must fail") }
        catch is CancellationError { }
        precondition(!FileManager.default.fileExists(atPath: cancelledCopy.path))
        print("PASS original copies preserve bytes, existing destinations and cancellation")
        guard let imported = await MediaEngine.inspect(source, thumbnailDirectory: root.appendingPathComponent("Thumbnails")) else { fatalError("Import failed") }
        precondition(imported.kind == "video" && imported.width == 640 && imported.height == 360)
        precondition(imported.duration > 3.5 && imported.thumbnail != nil)
        print("PASS import and thumbnail: \(imported.duration)s")
        let store = try ProjectStore(root: root.appendingPathComponent("Picture project.relio"))
        let segment = EditSegment(mediaID: imported.id, start: 0, duration: 3, caption: "Three picture test")
        try store.save(ProjectData(name: "Picture project", media: [imported], segments: [segment]), key: "project")
        guard let reopened = try store.load(ProjectData.self, key: "project"), reopened.media.count == 1, reopened.segments.first?.caption == "Three picture test" else { fatalError("Persistence failed") }
        let notAProject = root.appendingPathComponent("Not a project")
        try FileManager.default.createDirectory(at: notAProject, withIntermediateDirectories: true)
        precondition((try? ProjectStore(root: notAProject, create: false)) == nil
                     && (try? FileManager.default.contentsOfDirectory(atPath: notAProject.path))?.isEmpty == true
                     && (try? ProjectStore(root: root.appendingPathComponent("Picture project.relio"), create: false)) != nil,
                     "Opening a folder that is not a project must fail without leaving a database in it")
        print("PASS project persistence")
        var database: OpaquePointer?
        precondition(sqlite3_open(store.root.appendingPathComponent("project.sqlite").path, &database) == SQLITE_OK)
        precondition(sqlite3_exec(database, "INSERT INTO state(key,value) VALUES('empty',X'')", nil, nil, nil) == SQLITE_OK)
        sqlite3_close(database)
        do {
            let _: ProjectData? = try store.load(ProjectData.self, key: "empty")
            preconditionFailure("An unreadable saved record must not be reported as a missing project")
        } catch ProjectStore.StoreError.database { }
        let clippedOverlay = EditSegment(mediaID: imported.id, duration: 4, caption: "Clipped", captionStart: -1, captionDuration: 2)
        let overlayLayer = ShortMaker.captionLayer(for: clippedOverlay)!.sublayers!.first!
        let visibility = overlayLayer.animation(forKey: "captionVisibility") as! CAKeyframeAnimation
        precondition(visibility.keyTimes![2].doubleValue == 0.25, "A caption crossing zero must end at its original end time")
        let expiredOverlay = EditSegment(mediaID: imported.id, duration: 4, caption: "Expired", captionStart: -3, captionDuration: 1)
        precondition(ShortMaker.captionLayer(for: expiredOverlay)?.sublayers?.isEmpty != false,
                     "A caption ending before the clip must not reappear at its start")
        print("PASS corrupt saved records are distinguished from missing keys, and captions clip to their actual interval")
        let invalidSource = root.appendingPathComponent("invalid.mp4")
        try Data("not a video".utf8).write(to: invalidSource)
        let invalidImport = await MediaEngine.inspect(invalidSource, thumbnailDirectory: root)
        precondition(invalidImport == nil)
        let safeSpeech = ShortMaker.speechSafeRange(start: 0.3, duration: 1, words: [.init(text: "Hello", start: 0.2, duration: 0.3)], interval: (0, 4))
        precondition(safeSpeech.start < 0.2 && abs(safeSpeech.start + safeSpeech.duration - 1.3) < 0.001,
                     "Protecting the opening word must not move the intended ending earlier")
        let firstHalf = try ShortMaker.SourceRegion.firstHalf.interval(videoDuration: 600)
        let lastHalf = try ShortMaker.SourceRegion.lastHalf.interval(videoDuration: 600)
        precondition(firstHalf.start == 0 && firstHalf.end == 300)
        precondition(lastHalf.start == 300 && lastHalf.end == 600)
        let oddHalf = try ShortMaker.SourceRegion.lastHalf.interval(videoDuration: 601)
        precondition(oddHalf.start == 300.5 && oddHalf.end == 601)
        let custom = try ShortMaker.SourceRegion.custom.interval(videoDuration: 600, customStart: 60, customEnd: 600)
        precondition(custom.start == 60 && custom.end == 600)
        for range in [(0.0, 60_000.0), (-1, 30), (30, 20), (30, 30), (0, Double.infinity), (Double.nan, 30)] {
            do {
                _ = try ShortMaker.SourceRegion.custom.interval(videoDuration: 600, customStart: range.0, customEnd: range.1)
                fatalError("Invalid custom source range accepted")
            } catch ShortMaker.Failure.invalidRange { }
        }
        // Both rejections happen before any Gemini request, so a placeholder key is never sent.
        let offline = GeminiConfiguration()
        do {
            _ = try await ShortMaker.analyze(source, requestedDuration: 1, count: 1, sourceRegion: .custom, customStart: 0, customEnd: 60_000, gemini: offline)
            fatalError("Analysis must reject a custom end past the actual media duration")
        } catch ShortMaker.Failure.invalidRange { }
        do {
            _ = try await ShortMaker.analyze(source, requestedDuration: 1, count: 1, sourceRegion: .entireVideo,
                excluding: [.init(start: 0, end: imported.duration)], gemini: offline)
            fatalError("An entirely used source region must not generate fallback duplicates")
        } catch GeminiSelection.Failure.noDistinctClips { }
        print("PASS first/last half, fractional midpoint, custom range validation and actual source duration enforcement")
        let rejected = root.appendingPathComponent("rejected.mp4")
        for bad in [EditSegment(mediaID: imported.id, start: -1, duration: 2),
                    EditSegment(mediaID: imported.id, duration: .nan),
                    EditSegment(mediaID: imported.id, start: 3, duration: 3)] {
            do {
                try await ShortMaker.export(source: source, segment: bad, destination: rejected)
                fatalError("Invalid range accepted")
            } catch ShortMaker.Failure.invalidRange { }
            precondition(!FileManager.default.fileExists(atPath: rejected.path))
        }
        try Data("preserve me".utf8).write(to: rejected)
        do {
            try await ShortMaker.export(source: source, segment: segment, destination: rejected)
            fatalError("Existing destination overwritten")
        } catch ShortMaker.Failure.destinationExists { }
        let preserved = try Data(contentsOf: rejected)
        precondition(preserved == Data("preserve me".utf8))
        print("PASS invalid import, invalid edits, and destination preservation")
        let output = root.appendingPathComponent("short.mp4")
        try await ShortMaker.export(source: source, segment: segment, destination: output)
        let plainURL = root.appendingPathComponent("plain.mp4")
        let timedURL = root.appendingPathComponent("timed.mp4")
        try await ShortMaker.export(source: source, segment: EditSegment(mediaID: imported.id, duration: 3), destination: plainURL)
        try await ShortMaker.export(source: source, segment: EditSegment(mediaID: imported.id, duration: 3, caption: "Timed caption", captionStart: 1, captionDuration: 1), destination: timedURL)
        let fitURL = root.appendingPathComponent("fit.mp4")
        try await ShortMaker.export(source: source, segment: EditSegment(mediaID: imported.id, duration: 3, fitToFrame: true), destination: fitURL)
        let fitGenerator = AVAssetImageGenerator(asset: AVURLAsset(url: fitURL))
        fitGenerator.requestedTimeToleranceBefore = .zero
        fitGenerator.requestedTimeToleranceAfter = .zero
        let fitFrame = try fitGenerator.copyCGImage(at: CMTime(seconds: 1.5, preferredTimescale: 600), actualTime: nil)
        let fitBitmap = NSBitmapImageRep(cgImage: fitFrame)
        func fitPixel(_ x: Int, _ y: Int) -> NSColor { fitBitmap.colorAt(x: x, y: y)!.usingColorSpace(.deviceRGB)! }
        let upperBackground = fitPixel(540, 100)
        let lowerBackground = fitPixel(540, 1820)
        let foreground = fitPixel(900, 960)
        precondition(upperBackground.greenComponent > 0.12 && lowerBackground.greenComponent > 0.12,
                     "Fit mode must fill both portrait bars with the blurred source")
        precondition(foreground.greenComponent > foreground.redComponent * 1.3 && foreground.greenComponent > 0.35,
                     "Fit mode must retain the sharp source in the center")
        let fitPreview = NSBitmapImageRep(cgImage: fitFrame).representation(using: .png, properties: [:])!
        try FileManager.default.createDirectory(atPath: "test-output", withIntermediateDirectories: true)
        try fitPreview.write(to: URL(fileURLWithPath: "test-output/fit-blur-frame.png"))
        try await checkRotatedLayouts(in: root)
        try await checkSilenceSnapping(in: root)
        print("PASS fit framing fills the top and bottom with a blurred source and keeps the centered video sharp")
        try await checkLivePreview(source: source, mediaID: imported.id)
        func pixels(_ url: URL, _ seconds: Double) throws -> [UInt8] {
            let generator = AVAssetImageGenerator(asset: AVURLAsset(url: url))
            generator.requestedTimeToleranceBefore = .zero
            generator.requestedTimeToleranceAfter = .zero
            let frame = try generator.copyCGImage(at: CMTime(seconds: seconds, preferredTimescale: 600), actualTime: nil)
            var bytes = [UInt8](repeating: 0, count: 4)
            bytes.withUnsafeMutableBytes { buffer in
                let context = CGContext(data: buffer.baseAddress, width: 1, height: 1, bitsPerComponent: 8, bytesPerRow: 4, space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
                context.draw(frame.cropping(to: CGRect(x: 90, y: 1550, width: 20, height: 20))!, in: CGRect(x: 0, y: 0, width: 1, height: 1))
            }
            return bytes
        }
        for time in [0.5, 1.5, 2.5] {
            let plain = try pixels(plainURL, time)
            let timed = try pixels(timedURL, time)
            let difference = zip(plain, timed).map { abs(Int($0) - Int($1)) }.reduce(0, +)
            precondition(time == 1.5 ? difference > 10 : difference < 60, "Caption visibility incorrect at \(time): \(difference)")
        }
        print("PASS caption visible only during its requested interval")
        let viralURL = root.appendingPathComponent("viral-caption.mp4")
        let viralCue = TimedCaption(text: "This is the viral caption", start: 0.5, duration: 1.5)
        let viralWords = [("This", 0.5, 0.2), ("is", 0.7, 0.2), ("the", 0.9, 0.2), ("viral", 1.1, 0.4), ("caption", 1.5, 0.5)]
            .map { TimedSpeechWord(text: $0.0, start: $0.1, duration: $0.2) }
        try await ShortMaker.export(source: source, segment: EditSegment(mediaID: imported.id, duration: 3,
            captions: [viralCue], speechWords: viralWords, captionStyle: .viral), destination: viralURL)
        // Yellow pixels mark the highlighted word; white and grey text do not match this test.
        func yellowPixels(_ url: URL) throws -> (Int, CGImage) {
            let generator = AVAssetImageGenerator(asset: AVURLAsset(url: url))
            generator.requestedTimeToleranceBefore = .zero
            generator.requestedTimeToleranceAfter = .zero
            let frame = try generator.copyCGImage(at: CMTime(seconds: 0.65, preferredTimescale: 600), actualTime: nil)
            let bitmap = NSBitmapImageRep(cgImage: frame)
            var count = 0
            for y in 1150..<1450 {
                for x in 70..<1010 {
                    guard let color = bitmap.colorAt(x: x, y: y)?.usingColorSpace(.deviceRGB) else { continue }
                    if color.redComponent > 0.8 && color.greenComponent > 0.75 && color.blueComponent < 0.35 { count += 1 }
                }
            }
            return (count, frame)
        }
        let (highlightPixels, viralFrame) = try yellowPixels(viralURL)
        let viralImage = NSBitmapImageRep(cgImage: viralFrame).representation(using: .png, properties: [:])!
        try FileManager.default.createDirectory(atPath: "test-output", withIntermediateDirectories: true)
        try viralImage.write(to: URL(fileURLWithPath: "test-output/viral-caption-frame.png"))
        precondition(highlightPixels > 20, "Viral style must highlight the spoken word in yellow when word timings exist")
        try viralImage.write(to: root.appendingPathComponent("viral-caption-frame.png"))
        print("PASS viral caption style highlights the current spoken word in yellow")
        let untimedURL = root.appendingPathComponent("viral-caption-untimed.mp4")
        try await ShortMaker.export(source: source, segment: EditSegment(mediaID: imported.id, duration: 3,
            captions: [viralCue], captionStyle: .viral), destination: untimedURL)
        let (untimedPixels, _) = try yellowPixels(untimedURL)
        precondition(untimedPixels > 20, "Without exact word timings, Viral style still highlights words from estimated timing")
        print("PASS viral captions follow the speech with estimated timing when exact word timings are unavailable")
        // Every subtitle style renders in short pages: "This is the | viral caption" for three-word styles, two words for
        // Bold caps, one for One word, a whole short line for Simple and Minimal. Highlighting styles add a layer per word.
        let layerCounts: [CaptionStyle: Int] = [.auto: 5, .viral: 5, .highlightBox: 5, .podcast: 5, .boldCaps: 3, .oneWord: 5, .classic: 1, .minimal: 1]
        for style in CaptionStyle.allCases {
            precondition(ShortMaker.captionPreview(style) != nil, "\(style.title) preview must render")
            let expected = layerCounts[style]!
            let layer = ShortMaker.captionLayer(for: EditSegment(mediaID: imported.id, duration: 3, captions: [viralCue],
                                                                 speechWords: viralWords, captionStyle: style))
            precondition(layer?.sublayers?.count == expected, "\(style.title) must make \(expected) caption layers, made \(layer?.sublayers?.count ?? 0)")
            let untimed = ShortMaker.captionLayer(for: EditSegment(mediaID: imported.id, duration: 3, captions: [viralCue], captionStyle: style))
            precondition(untimed?.sublayers?.count == expected, "\(style.title) without word timing must page the same way from estimated timing")
        }
        let pages = ShortMaker.captionPages([viralCue], words: viralWords, style: .viral)
        precondition(pages.map(\.text) == ["This is the", "viral caption"] && pages[0].end == pages[1].start,
                     "Viral pages are three words and the first stays up until the next begins")
        var podcastShort = EditSegment(mediaID: imported.id, duration: 3, captionStyle: .auto)
        podcastShort.videoType = .podcast
        var gamingShort = EditSegment(mediaID: imported.id, duration: 3, captionStyle: .auto)
        gamingShort.videoType = .gaming
        precondition(podcastShort.resolvedCaptionStyle == .podcast && gamingShort.resolvedCaptionStyle == .boldCaps
                     && EditSegment(mediaID: imported.id, duration: 3, captionStyle: .auto).resolvedCaptionStyle == .viral,
                     "Auto picks Podcast for conversations, Bold caps for games and Viral highlight otherwise")
        let boxURL = root.appendingPathComponent("highlight-box.mp4")
        try await ShortMaker.export(source: source, segment: EditSegment(mediaID: imported.id, duration: 3,
            captions: [viralCue], speechWords: viralWords, captionStyle: .highlightBox), destination: boxURL)
        let (boxPixels, _) = try yellowPixels(boxURL)
        precondition(boxPixels > highlightPixels * 2, "Highlight box must fill a yellow box behind the word, not only color its letters")
        precondition(VideoType.tutorial.forcesFit && VideoType.gaming.forcesFit && !VideoType.podcast.forcesFit && !VideoType.vlog.forcesFit)
        precondition(VideoType.general.selectionGuidance.isEmpty && !VideoType.informational.selectionGuidance.isEmpty)
        // Split screen: the source's left person fills the top half, the right person the bottom half.
        let twoPeople = CIImage(color: .red).cropped(to: CGRect(x: 0, y: 0, width: 320, height: 360))
            .composited(over: CIImage(color: .blue).cropped(to: CGRect(x: 320, y: 0, width: 320, height: 360)))
        let split = ShortMaker.splitScreenFrame(twoPeople, transform: .identity)
        let splitBitmap = NSBitmapImageRep(ciImage: split)
        let topColor = splitBitmap.colorAt(x: 540, y: 400)!, bottomColor = splitBitmap.colorAt(x: 540, y: 1500)!
        precondition(split.extent == CGRect(x: 0, y: 0, width: 1080, height: 1920)
                     && topColor.redComponent > 0.9 && topColor.blueComponent < 0.1
                     && bottomColor.blueComponent > 0.9 && bottomColor.redComponent < 0.1,
                     "Split screen must put the left person on top and the right person on the bottom")
        precondition(ShortMaker.splitCenters(fromFaceXs: [0.31, 0.7, 0.29, 0.72, 0.3]) == [0.3, 0.71]
                     && ShortMaker.splitCenters(fromFaceXs: [0.48, 0.5, 0.52]) == nil
                     && ShortMaker.splitCenters(fromFaceXs: [0.4]) == nil,
                     "Two face groups give two speaker centers; one group or one face gives none")
        let shifted = NSBitmapImageRep(ciImage: ShortMaker.splitScreenFrame(twoPeople, transform: .identity, centers: [0.5, 0.5]))
        let shiftedTop = shifted.colorAt(x: 100, y: 400)!, shiftedTopRight = shifted.colorAt(x: 980, y: 400)!
        precondition(shiftedTop.redComponent > 0.9 && shiftedTopRight.blueComponent > 0.9,
                     "A centered speaker must pull the panel's window onto the middle of the source")
        print("PASS split screen layout and speaker centers")
        // Position moves the subtitles, size draws them larger, and only animated Shorts pop in.
        let bottomLayer = ShortMaker.captionLayer(for: EditSegment(mediaID: imported.id, duration: 3, captions: [viralCue], captionStyle: .classic))?.sublayers?.first
        var topLarge = EditSegment(mediaID: imported.id, duration: 3, captions: [viralCue], captionStyle: .boldCaps)
        topLarge.captionPosition = .top; topLarge.captionSize = .large; topLarge.captionAnimated = true
        let topLayer = ShortMaker.captionLayer(for: topLarge)?.sublayers?.first
        precondition(bottomLayer?.frame.midY == 620 && topLayer?.frame.midY == 1520, "Position must move the subtitles")
        precondition((topLayer?.frame.height ?? 0) > (bottomLayer?.frame.height ?? 0) && (topLayer?.frame.maxY ?? 9999) <= 1920,
                     "Large subtitles must be drawn larger and still fit inside the frame")
        precondition(topLayer?.animation(forKey: "captionPop") != nil && bottomLayer?.animation(forKey: "captionPop") == nil,
                     "Only Shorts with pop-in turned on animate")
        var viralPop = EditSegment(mediaID: imported.id, duration: 3, captions: [viralCue], speechWords: viralWords, captionStyle: .viral)
        viralPop.captionAnimated = true
        let popping = ShortMaker.captionLayer(for: viralPop)?.sublayers?.filter { $0.animation(forKey: "captionPop") != nil }.count
        precondition(popping == 2, "Each new page pops once; the moving highlight must not bounce it on every word")
        let placedURL = root.appendingPathComponent("top-large-pop.mp4")
        try await ShortMaker.export(source: source, segment: topLarge, destination: placedURL)
        precondition(FileManager.default.fileExists(atPath: placedURL.path), "A Short with moved, larger, animated subtitles must export")
        print("PASS all \(CaptionStyle.allCases.count) subtitle styles render, follow words or fall back to phrases; video types set layout and style")
        func captionArea(_ url: URL, _ seconds: Double) throws -> [UInt8] {
            let generator = AVAssetImageGenerator(asset: AVURLAsset(url: url))
            generator.requestedTimeToleranceBefore = .zero
            generator.requestedTimeToleranceAfter = .zero
            let frame = try generator.copyCGImage(at: CMTime(seconds: seconds, preferredTimescale: 600), actualTime: nil)
            let crop = frame.cropping(to: CGRect(x: 70, y: 1380, width: 940, height: 330))!
            var bytes = [UInt8](repeating: 0, count: 256 * 90)
            bytes.withUnsafeMutableBytes { buffer in
                let context = CGContext(data: buffer.baseAddress, width: 256, height: 90, bitsPerComponent: 8,
                    bytesPerRow: 256, space: CGColorSpaceCreateDeviceGray(), bitmapInfo: CGImageAlphaInfo.none.rawValue)!
                context.draw(crop, in: CGRect(x: 0, y: 0, width: 256, height: 90))
            }
            return bytes
        }
        func meanDifference(_ a: [UInt8], _ b: [UInt8]) -> Double {
            Double(zip(a, b).reduce(0) { $0 + abs(Int($1.0) - Int($1.1)) }) / Double(a.count)
        }
        let consecutive = root.appendingPathComponent("consecutive-captions.mp4")
        let single = root.appendingPathComponent("single-caption.mp4")
        let firstCue = TimedCaption(text: "FIRST PHRASE", start: 0.2, duration: 0.8)
        let secondCue = TimedCaption(text: "SECOND PHRASE", start: 1.1, duration: 1.1)
        try await ShortMaker.export(source: source, segment: EditSegment(mediaID: imported.id, duration: 3, captions: [firstCue, secondCue]), destination: consecutive)
        try await ShortMaker.export(source: source, segment: EditSegment(mediaID: imported.id, duration: 3, captions: [secondCue]), destination: single)
        // Keep the same Core Animation color pipeline in the empty reference.
        // Comparing with a render that has no animation tool also measures color conversion.
        let emptyReference = root.appendingPathComponent("empty-caption-reference.mp4")
        try await ShortMaker.export(source: source, segment: EditSegment(mediaID: imported.id, duration: 3,
            caption: "Future caption", captionStart: 2.9, captionDuration: 0.05), destination: emptyReference)
        let activeDifference = meanDifference(try captionArea(consecutive, 1.5), try captionArea(single, 1.5))
        let afterDifference = meanDifference(try captionArea(consecutive, 2.7), try captionArea(emptyReference, 2.7))
        precondition(activeDifference < 2 && afterDifference < 2, "Earlier captions remained visible: active=\(activeDifference), after=\(afterDifference)")
        print("PASS full caption area: consecutive phrases replace each other and disappear after their interval")

        let combinedURL = root.appendingPathComponent("combined-captions.mp4")
        let combinedSegment = EditSegment(
            mediaID: imported.id,
            duration: 3,
            caption: "Editable title",
            captionStart: 1,
            captionDuration: 1,
            captions: [TimedCaption(text: "Spoken subtitle", start: 1, duration: 1)]
        )
        try await ShortMaker.export(source: source, segment: combinedSegment, destination: combinedURL)
        let combinedGenerator = AVAssetImageGenerator(asset: AVURLAsset(url: combinedURL))
        let combinedFrame = try combinedGenerator.copyCGImage(at: CMTime(seconds: 1.5, preferredTimescale: 600), actualTime: nil)
        try NSBitmapImageRep(cgImage: combinedFrame).representation(using: .jpeg, properties: [.compressionFactor: 0.85])!
            .write(to: root.appendingPathComponent("combined-captions-frame.jpg"))
        print("PASS text overlay and generated subtitles export together")
        let exported = AVURLAsset(url: output)
        let duration = try await exported.load(.duration).seconds
        guard let video = try await exported.loadTracks(withMediaType: .video).first else { fatalError("No exported video") }
        let size = try await video.load(.naturalSize)
        let bytes = try output.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0
        precondition(Int(size.width) == 1080 && Int(size.height) == 1920)
        precondition(abs(duration - 3) < 0.2 && bytes > 10_000)
        print("PASS MP4 export: \(Int(size.width))×\(Int(size.height)), \(duration)s, \(bytes) bytes")
        let artifacts = URL(fileURLWithPath: FileManager.default.currentDirectoryPath).appendingPathComponent("test-output")
        try FileManager.default.createDirectory(at: artifacts, withIntermediateDirectories: true)
        let combinedFrameArtifact = artifacts.appendingPathComponent("combined-captions-frame.jpg")
        try? FileManager.default.removeItem(at: combinedFrameArtifact)
        try FileManager.default.copyItem(at: root.appendingPathComponent("combined-captions-frame.jpg"), to: combinedFrameArtifact)
        let viralFrameArtifact = artifacts.appendingPathComponent("viral-caption-frame.png")
        try? FileManager.default.removeItem(at: viralFrameArtifact)
        try FileManager.default.copyItem(at: root.appendingPathComponent("viral-caption-frame.png"), to: viralFrameArtifact)
        let saved = artifacts.appendingPathComponent("picture-short.mp4")
        try? FileManager.default.removeItem(at: saved)
        try FileManager.default.copyItem(at: output, to: saved)
        let fixture = artifacts.appendingPathComponent("pictures.mov")
        try? FileManager.default.removeItem(at: fixture)
        try FileManager.default.copyItem(at: source, to: fixture)
        let generator = AVAssetImageGenerator(asset: exported)
        let frame = try generator.copyCGImage(at: CMTime(seconds: 1.5, preferredTimescale: 600), actualTime: nil)
        let image = NSBitmapImageRep(cgImage: frame)
        try image.representation(using: .jpeg, properties: [.compressionFactor: 0.85])!.write(to: artifacts.appendingPathComponent("picture-short-frame.jpg"))
        for quality in [ShortMaker.ExportQuality.small, .compact] {
            let url = artifacts.appendingPathComponent("quality-\(quality.rawValue)-\(UUID()).mp4")
            try await ShortMaker.export(source: source, segment: EditSegment(mediaID: UUID(), duration: 2), destination: url, quality: quality)
            let track = try await AVURLAsset(url: url).loadTracks(withMediaType: .video)[0]
            let size = try await track.load(.naturalSize)
            let codec = try await track.load(.formatDescriptions).first.map { CMFormatDescriptionGetMediaSubType($0) }
            precondition(quality == .small ? (size.width == 720 && size.height == 1280) : (size.width == 1080 && codec == kCMVideoCodecType_HEVC),
                         "\(quality.title) export came out \(size) codec \(String(describing: codec))")
            try? FileManager.default.removeItem(at: url)
        }
        print("PASS export quality: 720p is 720×1280, HEVC is HEVC")
        print("Saved test-output/picture-short.mp4 and preview frame")
    }
    private static func makePictureVideo(at url: URL) async throws {
        let writer = try AVAssetWriter(outputURL: url, fileType: .mov)
        let input = AVAssetWriterInput(mediaType: .video, outputSettings: [AVVideoCodecKey: AVVideoCodecType.h264, AVVideoWidthKey: 640, AVVideoHeightKey: 360])
        input.expectsMediaDataInRealTime = false
        let attributes: [String: Any] = [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32ARGB, kCVPixelBufferWidthKey as String: 640, kCVPixelBufferHeightKey as String: 360, kCVPixelBufferCGImageCompatibilityKey as String: true]
        let adaptor = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: input, sourcePixelBufferAttributes: attributes)
        writer.add(input)
        guard writer.startWriting() else { throw writer.error ?? NSError(domain: "RelioSmoke", code: 1) }
        writer.startSession(atSourceTime: .zero)
        for frame in 0..<120 {
            while !input.isReadyForMoreMediaData { try await Task.sleep(for: .milliseconds(10)) }
            var buffer: CVPixelBuffer?
            CVPixelBufferCreate(kCFAllocatorDefault, 640, 360, kCVPixelFormatType_32ARGB, attributes as CFDictionary, &buffer)
            guard let pixel = buffer else { fatalError("No pixel buffer") }
            CVPixelBufferLockBaseAddress(pixel, [])
            let color: NSColor = frame < 40 ? .systemRed : frame < 80 ? .systemGreen : .systemBlue
            let context = CGContext(data: CVPixelBufferGetBaseAddress(pixel), width: 640, height: 360, bitsPerComponent: 8, bytesPerRow: CVPixelBufferGetBytesPerRow(pixel), space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.noneSkipFirst.rawValue)!
            context.setFillColor(color.cgColor)
            context.fill(CGRect(x: 0, y: 0, width: 640, height: 360))
            context.setFillColor(NSColor.white.cgColor)
            context.fill(CGRect(x: 80 + frame % 80, y: 100, width: 140, height: 140))
            CVPixelBufferUnlockBaseAddress(pixel, [])
            guard adaptor.append(pixel, withPresentationTime: CMTime(value: Int64(frame), timescale: 30)) else { throw writer.error ?? NSError(domain: "RelioSmoke", code: 2) }
        }
        input.markAsFinished()
        await writer.finishWriting()
        guard writer.status == .completed else { throw writer.error ?? NSError(domain: "RelioSmoke", code: 3) }
    }
}
