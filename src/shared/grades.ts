// Letter grades, shared by every game and the landing page's report card.
// Results are kept only in this browser (localStorage), like everything else on the site.
import { dayKey, dayIndex } from './daily';
import { track } from './analytics';
import { load, save, remove } from './storage';

export const GAMES = [
  { id: 'globe-links', name: 'Globe Links' },
  { id: 'fact-or-fib', name: 'Fact or Fib' },
  { id: 'rank-the-world', name: 'Rank the World' },
  { id: 'mystery-passport', name: 'Mystery Passport' },
  { id: 'outline-sketch', name: 'Outline Drop' },
  { id: 'flag-forge', name: 'Flag Forge' },
] as const;
export type GameId = (typeof GAMES)[number]['id'];

// A friendlier curve than school: these are hard puzzles, and a good day should feel like one.
const SCALE: [number, string][] = [
  [95, 'A+'], [88, 'A'], [83, 'A-'],
  [78, 'B+'], [73, 'B'], [68, 'B-'],
  [63, 'C+'], [58, 'C'], [53, 'C-'],
  [48, 'D+'], [43, 'D'], [38, 'D-'],
  [0, 'F'],
];

/** Any score as a whole-number percentage, 0–100 (NaN or junk counts as 0). */
const toPct = (pct: number) => (Number.isFinite(pct) ? Math.round(Math.max(0, Math.min(100, pct))) : 0);

export function gradeFor(pct: number): string {
  const p = Number.isFinite(pct) ? Math.max(0, Math.min(100, pct)) : 0;
  return (SCALE.find(([min]) => p >= min) ?? SCALE[SCALE.length - 1])[1];
}

/** Grade family (A–F), used for colour. */
export const bandOf = (grade: string) => grade[0];

export interface DayResult {
  pct: number;
  grade: string;
}
const summaryKey = (key = dayKey()) => `summary:${key}`;

/** The stored summary for a day, or an empty one if it's missing or corrupted (never a string, array, etc.). */
function readSummary(key: string): Record<string, DayResult> {
  const s = load<unknown>(summaryKey(key), null);
  return s && typeof s === 'object' && !Array.isArray(s) ? (s as Record<string, DayResult>) : {};
}

export function readToday(): Partial<Record<GameId, DayResult>> {
  const s = readSummary(dayKey());
  const out: Partial<Record<GameId, DayResult>> = {};
  for (const g of GAMES) {
    const r = s[g.id];
    if (r && typeof r === 'object' && typeof r.pct === 'number' && Number.isFinite(r.pct)) {
      const pct = toPct(r.pct);
      out[g.id] = { pct, grade: gradeFor(pct) };
    }
  }
  return out;
}

function recordResult(game: GameId, pct: number, key: string) {
  const s = readSummary(key);
  const p = toPct(pct);
  s[game] = { pct: p, grade: gradeFor(p) };
  save(summaryKey(key), s);
}

export function forgetResult(game: GameId, key = dayKey()) {
  const s = readSummary(key);
  if (!(game in s)) return;
  delete s[game];
  if (Object.keys(s).length) save(summaryKey(key), s);
  else remove(summaryKey(key));
}

/** Overall grade for the day: the average of the games played so far. */
export function overall(results: Partial<Record<GameId, DayResult>>): DayResult | null {
  const vals = Object.values(results).filter(Boolean) as DayResult[];
  if (!vals.length) return null;
  // Grade the rounded figure that's shown, so "68% overall" never comes with a C+.
  const pct = toPct(vals.reduce((n, r) => n + r.pct, 0) / vals.length);
  return { pct, grade: gradeFor(pct) };
}

/**
 * Show the letter grade at the top of a game's result card and save it for the landing page.
 * `pct` is the share of the best possible result (0–100).
 */
export function showGrade(game: GameId, pct: number, key: string) {
  const p = toPct(pct);
  const grade = gradeFor(p);
  // Count a finished game once for the anonymous dashboard (not again when a finished game is reopened).
  const firstTime = !readSummary(key)[game];
  recordResult(game, p, key);
  if (firstTime) track({ t: 'finish', game, pct: p, grade, puzzle: dayIndex() + 1, secs: Math.round(performance.now() / 1000) });
  const result = document.getElementById('result');
  if (!result) return;
  let box = result.querySelector<HTMLElement>('.grade');
  if (!box) {
    box = document.createElement('div');
    box.className = 'grade';
    result.prepend(box);
  }
  box.dataset.band = bandOf(grade);
  const letter = document.createElement('p');
  letter.className = 'grade-letter';
  letter.textContent = grade;
  letter.setAttribute('aria-label', `Grade ${grade.replace('+', ' plus').replace('-', ' minus')}`);
  const info = document.createElement('div');
  info.className = 'grade-info';
  const pctLine = document.createElement('p');
  pctLine.className = 'grade-pct';
  pctLine.textContent = `${p}% of a perfect game`;
  const scale = document.createElement('p');
  scale.className = 'grade-scale';
  // One unbreakable chip per band; the dots between them are CSS, so a wrap never strands a "·".
  scale.append(
    ...['A 83%+', 'B 68%+', 'C 53%+', 'D 38%+'].map((t) => {
      const span = document.createElement('span');
      span.textContent = t;
      return span;
    }),
  );
  info.append(pctLine, scale);
  box.replaceChildren(letter, info);
}
