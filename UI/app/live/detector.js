// Spots likely clip moments in a live stream without any AI: the stream suddenly gets much louder, or chat suddenly much busier,
// than over the last three minutes. The idea follows PeakCut's live clipper (MIT, github.com/haziqahmedqasmi/PeakCut).
// A moment needs more than double the usual loudness or chat (120% up), and at most one every two minutes: fewer, bigger clips.
const BASE = 180, RECENT_LOUD = 6, RECENT_CHAT = 8, SKIP = 10, JUMP = 1.2, COOLDOWN = 120, WARMUP = 60;

export class Detector {
  constructor() { this.level = []; this.chat = []; this.lastMoment = -Infinity; }

  /** Loudness for whole second `second` of the stream (counted from its start), in dB. */
  loudness(second, db) { this.level[second] = 10 ** (db / 20); }

  /** One chat message during `second`. */
  message(second) { this.chat[second] = (this.chat[second] ?? 0) + 1; }

  /** At stream second `now`: { at, why } for a new moment, or null. A moment is at most one per two minutes. */
  check(now) {
    if (now < WARMUP || now - this.lastMoment < COOLDOWN) return null;
    const mean = (list, from, to) => {
      let sum = 0, n = 0;
      for (let s = Math.max(0, from); s < to; s++) if (list[s] !== undefined) { sum += list[s]; n++; }
      return n ? sum / n : null;
    };
    const why = [];
    const base = mean(this.level, now - BASE, now - SKIP), current = mean(this.level, now - RECENT_LOUD, now);
    if (base && current !== null && current / base - 1 >= JUMP) why.push(`${Math.round((current / base - 1) * 100)}% louder`);
    // Seconds without a message count as zero for chat.
    const rate = (from, to) => { let n = 0; for (let s = Math.max(0, from); s < to; s++) n += this.chat[s] ?? 0; return n / Math.max(1, to - Math.max(0, from)); };
    if (this.chat.length > 0) {
      const chatBase = rate(now - BASE, now - SKIP), chatNow = rate(now - RECENT_CHAT, now);
      if (chatNow >= Math.max(1.5, chatBase * (1 + JUMP))) why.push(`chat ${chatBase > 0 ? `${(chatNow / chatBase).toFixed(1)}×` : 'burst'}`);
    }
    if (why.length === 0) return null;
    this.lastMoment = now;
    return { at: now, why: why.join(' · ') };
  }
}
