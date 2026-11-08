// Daily puzzle selection, computed locally from the player's own calendar date.
const EPOCH = new Date(2026, 10, 1); // 1 Nov 2026, local time: puzzle #1
const DAY_MS = 86_400_000;

function localMidnight(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/** 0-based number of days since launch (never negative). */
export function dayIndex(now = new Date()): number {
  return Math.max(0, Math.round((localMidnight(now) - localMidnight(EPOCH)) / DAY_MS));
}

/** Stable key for the player's current local date, e.g. "2026-11-06". */
export function dayKey(now = new Date()): string {
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${now.getFullYear()}-${m}-${d}`;
}

export function msUntilTomorrow(now = new Date()): number {
  const t = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  return t.getTime() - now.getTime();
}

/** Deterministic PRNG (mulberry32) so everyone sees the same board on the same day. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function shuffle<T>(items: T[], rand: () => number = Math.random): T[] {
  const out = items.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}
