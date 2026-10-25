import Foundation

// Adapted from OpenShorts clip_selection.py (MIT). See THIRD-PARTY-NOTICES.md.
enum TranscriptSelection {
    struct Window {
        let start: Double
        let end: Double
        let text: String
    }

    /// Overlapping windows aligned to caption segments; every segment is visited,
    /// including the tail. Captions may be phrases rather than complete sentences.
    static func windows(_ cues: [TimedCaption], interval: (start: Double, end: Double),
                        seconds: Double = 90, overlap: Double = 30) -> [Window] {
        let segments = cues.filter {
            $0.start.isFinite && $0.duration.isFinite && $0.duration > 0 &&
            $0.start >= interval.start && $0.start + $0.duration <= interval.end &&
            !$0.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        }.sorted { $0.start < $1.start }
        var result: [Window] = []
        var i = 0
        let size = max(1, seconds)
        while i < segments.count {
            let start = segments[i].start
            var j = i
            while j + 1 < segments.count && segments[j + 1].start + segments[j + 1].duration - start <= size * 1.25 {
                j += 1
                if segments[j].start + segments[j].duration - start >= size { break }
            }
            let end = segments[j].start + segments[j].duration
            result.append(.init(start: start, end: end, text: segments[i...j].map(\.text).joined(separator: " ")))
            if j == segments.count - 1 { break }
            let target = end - max(0, overlap)
            var k = i + 1
            while k <= j && segments[k].start < target { k += 1 }
            i = max(k, i + 1)
        }
        return result
    }

    /// Near-equal batches avoid judging a trailing singleton on its own.
    static func batches<T>(_ values: [T], size: Int = 4) -> [[T]] {
        guard !values.isEmpty else { return [] }
        let count = (values.count + max(1, size) - 1) / max(1, size)
        let base = values.count / count, extra = values.count % count
        var start = 0
        return (0..<count).map { index in
            let end = start + base + (index < extra ? 1 : 0)
            defer { start = end }
            return Array(values[start..<end])
        }
    }

    /// Score every window, not only the visually strongest part of the recording.
    /// A failed batch invalidates the pass so partial model coverage cannot bias it.
    static func scoreWindows(_ windows: [Window],
                             scorer: ([String]) async -> [Double]?) async -> [Double]? {
        guard !windows.isEmpty else { return nil }
        var scores: [Double] = []
        for batch in batches(windows) {
            guard !Task.isCancelled,
                  let values = await scorer(batch.map { String($0.text.prefix(2400)) }),
                  values.count == batch.count,
                  values.allSatisfy({ $0.isFinite && (0...1).contains($0) }) else { return nil }
            scores += values
        }
        return scores
    }

    /// A second transcription must retain the source's opening, payoff and most words.
    /// Coarse sentence anchors also detect plausible text with a drifting timestamp clock.
    static func alignmentIsReliable(_ words: [TimedSpeechWord], reference: [TimedCaption]) -> Bool {
        func tokens(_ text: String) -> [String] { text.lowercased().split { !$0.isLetter && !$0.isNumber }.map(String.init) }
        let expected = reference.flatMap { tokens($0.text) }
        let actual = words.flatMap { tokens($0.text) }
        // The edges may differ by a word or two (a dropped "so", an added "uh"); the overlap check below still
        // demands 95% of the words, so a lost payoff is still caught.
        guard !expected.isEmpty, !actual.isEmpty,
              expected.prefix(3).contains(actual[0]) || actual.prefix(3).contains(expected[0]),
              expected.suffix(3).contains(actual[actual.count - 1]) || actual.suffix(3).contains(expected[expected.count - 1]),
              actual.count <= expected.count * 3 / 2 + 3 else { return false }
        var previous = [Int](repeating: 0, count: actual.count + 1)
        for token in expected {
            var current = [Int](repeating: 0, count: actual.count + 1)
            for index in actual.indices {
                current[index + 1] = token == actual[index] ? previous[index] + 1 : max(previous[index + 1], current[index])
            }
            previous = current
        }
        guard Double(previous.last!) / Double(expected.count) >= 0.95 else { return false }
        for cue in reference {
            let cueTokens = tokens(cue.text)
            guard cueTokens.count >= 4 else { continue }
            let nearby = Set(words.filter { $0.start + $0.duration > cue.start - 0.7 && $0.start < cue.start + cue.duration + 0.7 }.flatMap { tokens($0.text) })
            let coverage = Double(cueTokens.filter { nearby.contains($0) }.count) / Double(cueTokens.count)
            if coverage < 0.65 { return false }
        }
        return true
    }

    /// Sentence timing is an explicit fallback, not invented word-level precision.
    static func sentenceCaptionGroups(_ cues: [TimedCaption]) -> [TimedCaption] {
        cues.flatMap { cue in
            let words = cue.text.split(whereSeparator: \.isWhitespace).map(String.init)
            guard !words.isEmpty else { return [TimedCaption]() }
            return stride(from: 0, to: words.count, by: 6).map { index in
                let end = min(words.count, index + 6)
                return TimedCaption(text: words[index..<end].joined(separator: " "),
                    start: cue.start + cue.duration * Double(index) / Double(words.count),
                    duration: cue.duration * Double(end - index) / Double(words.count))
            }
        }
    }

    static func paddedPhraseRange(start: Double, duration: Double, cues: [TimedCaption], interval: (start: Double, end: Double)) -> (start: Double, duration: Double) {
        let end = start + duration
        let previous = cues.map { $0.start + $0.duration }.filter { $0 <= start + 0.001 }.max()
        let next = cues.map(\.start).filter { $0 >= end - 0.001 }.min()
        let lead = previous.map { min(0.35, max(0, (start - $0) / 2)) } ?? 0.35
        let tail = next.map { min(0.45, max(0, ($0 - end) / 2)) } ?? 0.45
        let beginning = max(interval.start, start - lead)
        return (beginning, min(interval.end, end + tail) - beginning)
    }

    /// Shorts never share footage: only a touch under 0.3 s, where one ends as the next begins, is allowed.
    static func overlaps(start: Double, duration: Double, otherStart: Double, otherDuration: Double) -> Bool {
        min(start + duration, otherStart + otherDuration) - max(start, otherStart) > 0.3
    }

    /// Moves a range's edges out of the middle of a sentence; `cues` must be whole sentences (the cloud transcript).
    /// The end prefers finishing its sentence, else stops after the previous one; the start prefers its sentence's
    /// beginning, else the next sentence, else its sentence's beginning even when far. An edge stays put only when
    /// every fix would break the length limits.
    static func completeSentences(start: Double, duration: Double, cues: [TimedCaption], interval: (start: Double, end: Double),
                                  minDuration: Double, maxDuration: Double) -> (start: Double, duration: Double) {
        let sentences = cues.filter {
            $0.start.isFinite && $0.duration.isFinite && $0.duration > 0 &&
            $0.start >= interval.start - 0.001 && $0.start + $0.duration <= interval.end + 0.001
        }.sorted { $0.start < $1.start }
        func sentence(containing time: Double) -> TimedCaption? {
            sentences.first { $0.start + 0.3 < time && $0.start + $0.duration - 0.3 > time }
        }
        var begin = start
        var end = start + duration
        if let cut = sentence(containing: begin) {
            if begin - cut.start <= 4, end - cut.start <= maxDuration {
                begin = cut.start
            } else if let next = sentences.first(where: { $0.start >= cut.start + cut.duration - 0.05 }), end - next.start >= minDuration {
                begin = next.start
            } else if end - cut.start <= maxDuration {
                begin = cut.start
            }
        }
        if let cut = sentence(containing: end) {
            let finish = cut.start + cut.duration
            if finish - end <= 8, finish - begin <= maxDuration {
                end = finish
            } else if let previous = sentences.last(where: { $0.start + $0.duration <= cut.start + 0.05 }),
                      previous.start + previous.duration - begin >= minDuration {
                end = previous.start + previous.duration
            } else if finish - begin <= maxDuration {
                end = finish
            }
        }
        return (begin, max(0.01, end - begin))
    }

    /// Drops filler-only cues ("Okay, so.", "Thanks for watching.") from a range's edges while it keeps `minDuration`,
    /// so a Short opens on its hook and ends on its payoff.
    // shortcut: English filler words only; add per-language lists if non-English sources matter.
    static func trimmedFiller(start: Double, duration: Double, cues: [TimedCaption], minDuration: Double) -> (start: Double, duration: Double) {
        let filler: Set<String> = ["okay", "ok", "so", "um", "uh", "erm", "hmm", "yeah", "right", "alright", "all", "anyway", "well",
                                   "and", "but", "now", "oh", "hey", "hi", "hello", "guys", "everyone", "thanks", "thank", "you", "for", "watching"]
        func isFiller(_ cue: TimedCaption) -> Bool {
            let words = cue.text.lowercased().split { !$0.isLetter && !$0.isNumber }.map(String.init)
            return !words.isEmpty && words.count <= 4 && words.allSatisfy(filler.contains)
        }
        var inside = cues.filter { $0.start >= start - 0.05 && $0.start + $0.duration <= start + duration + 0.05 }.sorted { $0.start < $1.start }
        var begin = start
        var end = start + duration
        while inside.count > 1, isFiller(inside[0]), end - inside[1].start >= minDuration {
            inside.removeFirst()
            begin = inside[0].start
        }
        while inside.count > 1, isFiller(inside[inside.count - 1]), inside[inside.count - 2].start + inside[inside.count - 2].duration - begin >= minDuration {
            inside.removeLast()
            end = inside[inside.count - 1].start + inside[inside.count - 1].duration
        }
        return (begin, end - begin)
    }

    /// Prefer nearby phrase endings, especially punctuation or a pause. Word safety
    /// is applied afterward by ShortMaker. Requested lengths remain approximate.
    static func phraseRange(start: Double, duration: Double, cues: [TimedCaption],
                            interval: (start: Double, end: Double)) -> (start: Double, duration: Double) {
        let valid = cues.filter { $0.start >= interval.start && $0.start + $0.duration <= interval.end }.sorted { $0.start < $1.start }
        let beginning = valid.filter { abs($0.start - start) <= 2 }
            .min { abs($0.start - start) < abs($1.start - start) }?.start ?? start
        let target = min(interval.end, beginning + duration)
        let tolerance = min(5, duration * 0.2)
        let endings = valid.enumerated().filter { _, cue in
            abs(cue.start + cue.duration - target) <= tolerance && cue.start + cue.duration > beginning
        }
        func quality(_ index: Int, _ cue: TimedCaption) -> Double {
            let punctuation = cue.text.last.map { ".!?…".contains($0) } ?? false
            let pause = index + 1 < valid.count && valid[index + 1].start - (cue.start + cue.duration) >= 0.4
            return abs(cue.start + cue.duration - target) - (punctuation || pause ? tolerance : 0)
        }
        let ending = endings.min { quality($0.offset, $0.element) < quality($1.offset, $1.element) }
            .map { $0.element.start + $0.element.duration } ?? target
        return (beginning, max(0.01, ending - beginning))
    }
}
