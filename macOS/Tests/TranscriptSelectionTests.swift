import Foundation

@main struct TranscriptSelectionTests {
    static func main() async {
        let cues = (0..<120).map { TimedCaption(text: "Phrase \($0).", start: Double($0 * 10), duration: 8) }
        let windows = TranscriptSelection.windows(cues.reversed(), interval: (0, 1200))
        precondition(windows.first?.start == 0 && windows.last?.end == 1198)
        precondition(cues.allSatisfy { cue in windows.contains { $0.start <= cue.start && $0.end >= cue.start + cue.duration } })
        precondition(zip(windows, windows.dropFirst()).allSatisfy { $0.start < $1.start && $1.start < $0.end })
        let restricted = TranscriptSelection.windows(cues, interval: (300, 600))
        precondition(restricted.allSatisfy { $0.start >= 300 && $0.end <= 600 })
        precondition(TranscriptSelection.windows([], interval: (0, 10)).isEmpty)
        precondition(TranscriptSelection.batches(Array(0..<9)).map(\.count) == [3, 3, 3])
        precondition(TranscriptSelection.batches(Array(0..<5)).map(\.count) == [3, 2])
        let scored = await TranscriptSelection.scoreWindows(windows) { batch in batch.map { $0.contains("Phrase 119.") ? 1 : 0 } }
        precondition(scored?.count == windows.count && scored?.last == 1, "Tail must receive model scoring")
        var calls = 0
        let failed = await TranscriptSelection.scoreWindows(windows) { batch in
            calls += 1
            return calls == 2 ? nil : batch.map { _ in 0.5 }
        }
        precondition(failed == nil, "Never blend partially scored windows")
        let malformed = await TranscriptSelection.scoreWindows(windows) { _ in [Double.nan] }
        precondition(malformed == nil)
        precondition(TranscriptSelection.overlaps(start: 0, duration: 60, otherStart: 35, otherDuration: 60))
        precondition(!TranscriptSelection.overlaps(start: 0, duration: 60, otherStart: 60, otherDuration: 30))
        precondition(TranscriptSelection.overlaps(start: 0, duration: 60, otherStart: 10, otherDuration: 10))
        precondition(TranscriptSelection.overlaps(start: 0, duration: 60, otherStart: 55, otherDuration: 60), "Five shared seconds are an overlap")
        precondition(!TranscriptSelection.overlaps(start: 0, duration: 60, otherStart: 59.8, otherDuration: 30), "Touching ends are not")
        let phrase = TranscriptSelection.phraseRange(start: 10.4, duration: 30, cues: cues, interval: (0, 1200))
        precondition(phrase.start == 10 && phrase.start + phrase.duration == 38)
        let fallback = TranscriptSelection.phraseRange(start: 90, duration: 10, cues: [], interval: (0, 100))
        precondition(fallback.start == 90 && fallback.duration == 10)
        let bounded = TranscriptSelection.phraseRange(start: 580, duration: 30, cues: cues, interval: (300, 600))
        precondition(bounded.start >= 300 && bounded.start + bounded.duration <= 600)
        let reference = [TimedCaption(text: "Here is a clear opening.", start: 10, duration: 2),
                         TimedCaption(text: "Finish with the useful payoff.", start: 12, duration: 3)]
        let aligned = reference.map(\.text).joined(separator: " ").split(separator: " ").enumerated().map {
            TimedSpeechWord(text: String($0.element), start: 10 + Double($0.offset) * 0.4, duration: 0.3)
        }
        precondition(TranscriptSelection.alignmentIsReliable(aligned, reference: reference))
        precondition(!TranscriptSelection.alignmentIsReliable(Array(aligned.dropLast(2)), reference: reference), "Missing payoff must reject word alignment")
        let drifting = aligned.map { TimedSpeechWord(text: $0.text, start: $0.start + 4, duration: $0.duration) }
        precondition(!TranscriptSelection.alignmentIsReliable(drifting, reference: reference), "Correct words on the wrong clock must be rejected")
        let repeatedReference = [TimedCaption(text: "Go go go go", start: 0, duration: 1), TimedCaption(text: "Go go go go", start: 10, duration: 1)]
        let repeatedWords = (0..<8).map { TimedSpeechWord(text: "Go", start: $0 == 0 ? 0 : 10 + Double($0 - 1) * 0.1, duration: 0.08) }
        precondition(!TranscriptSelection.alignmentIsReliable(repeatedWords, reference: repeatedReference), "Repeated words cannot stand in for missing timed occurrences")
        let shortReference = [TimedCaption(text: "Yes.", start: 0, duration: 0.5), TimedCaption(text: "Absolutely.", start: 10, duration: 0.5)]
        let shortDrift = [TimedSpeechWord(text: "Yes.", start: 8, duration: 0.4), TimedSpeechWord(text: "Absolutely.", start: 10, duration: 0.4)]
        precondition(!TranscriptSelection.alignmentIsReliable(shortDrift, reference: shortReference), "Short replies must also have timing anchors")
        let grouped = TranscriptSelection.sentenceCaptionGroups(reference)
        precondition(grouped.map(\.text).joined(separator: " ") == reference.map(\.text).joined(separator: " "))
        let padded = TranscriptSelection.paddedPhraseRange(start: 10, duration: 5,
            cues: [.init(text: "previous", start: 8, duration: 1.8), .init(text: "next", start: 15.2, duration: 2)], interval: (0, 20))
        precondition(abs(padded.start - 9.9) < 0.001 && abs(padded.start + padded.duration - 15.1) < 0.001)
        print("PASS transcript coverage, region bounds, balanced batches, tail scoring, model failure, overlap filtering and phrase cuts")
        let sentences = [TimedCaption(text: "A.", start: 0, duration: 10), TimedCaption(text: "B.", start: 10, duration: 10),
                         TimedCaption(text: "C.", start: 20, duration: 10), TimedCaption(text: "D.", start: 30, duration: 15)]
        func whole(_ start: Double, _ duration: Double, max: Double = 30) -> (Double, Double) {
            let range = TranscriptSelection.completeSentences(start: start, duration: duration, cues: sentences, interval: (0, 100),
                                                             minDuration: 10, maxDuration: max)
            return (range.start, range.start + range.duration)
        }
        precondition(whole(10, 16) == (10, 30), "An end inside a sentence must finish that sentence")
        precondition(whole(2, 31, max: 40) == (0, 30), "A start moves back to its sentence; an end far from its sentence's end steps back")
        precondition(whole(10, 10) == (10, 20), "Cuts already on sentence boundaries must not move")
        precondition(whole(15, 25) == (20, 45), "A start deep inside a sentence moves to the next one")
        precondition(whole(0, 28, max: 29) == (0, 20), "Finishing the sentence must not exceed the maximum length")
        precondition(whole(0, 5) == (0, 10), "A range ending inside the first sentence finishes it")
        precondition(whole(0, 5, max: 8) == (0, 5), "When finishing would be too long and no earlier sentence fits, the end stays")
        precondition(whole(25, 10) == (20, 30), "Edges never stay mid-sentence while a sentence-complete range fits the limits")
        let spoken = [TimedCaption(text: "Okay, so.", start: 0, duration: 2), TimedCaption(text: "Nobody tells you this trick.", start: 2, duration: 20),
                      TimedCaption(text: "It saved me hours.", start: 22, duration: 10), TimedCaption(text: "Thanks for watching!", start: 32, duration: 2)]
        let trimmed = TranscriptSelection.trimmedFiller(start: 0, duration: 34, cues: spoken, minDuration: 20)
        precondition(trimmed.start == 2 && trimmed.start + trimmed.duration == 32, "Filler-only openings and sign-offs are trimmed")
        let kept = TranscriptSelection.trimmedFiller(start: 0, duration: 34, cues: spoken, minDuration: 33)
        precondition(kept.start == 0 && kept.duration == 34, "Filler stays when trimming would make the clip too short")
        for payoff in ["Right.", "Yeah.", "Thank you."] {
            let cues = [TimedCaption(text: "This was the question.", start: 0, duration: 20), TimedCaption(text: payoff, start: 20, duration: 2)]
            let range = TranscriptSelection.trimmedFiller(start: 0, duration: 22, cues: cues, minDuration: 10)
            precondition(range.start + range.duration == 22, "A short answer or meaningful thanks must not be discarded")
        }
        let shortAnswer = [TimedCaption(text: "Okay.", start: 0, duration: 1), TimedCaption(text: "Here is why that matters.", start: 1, duration: 20)]
        precondition(TranscriptSelection.trimmedFiller(start: 0, duration: 21, cues: shortAnswer, minDuration: 10).start == 0,
                     "An opening reply can provide essential context")
        print("PASS sentence-complete cuts: ends finish their sentence or step back, starts move to a sentence start, length limits hold")
    }
}
