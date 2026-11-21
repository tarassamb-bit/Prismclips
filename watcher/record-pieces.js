// Process playlist pieces in order. A failed download is retried on the next playlist refresh instead of being silently skipped.
export async function recordPieces(recorder, pieces, init, onError) {
  for (const piece of pieces) {
    if (recorder.stopped) return false;
    if (piece.sequence <= recorder.lastSequence) continue;
    try {
      await recorder.record(piece, init);
      recorder.lastSequence = piece.sequence;
    } catch (error) {
      // If the piece was already saved, avoid writing and counting it twice after a later processing error.
      if (recorder.pieces.has(piece.sequence)) recorder.lastSequence = piece.sequence;
      onError(error);
      return false;
    }
  }
  return true;
}
