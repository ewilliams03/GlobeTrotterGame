// Letter grades, shared by every game and the landing page's report card.
// Results are kept only in this browser (localStorage), like everything else on the site.
import { dayKey } from './daily';
import { load, save, remove } from './storage';

export const GAMES = [
  { id: 'globe-links', name: 'Globe Links' },
  { id: 'fact-or-fib', name: 'Fact or Fib' },
  { id: 'rank-the-world', name: 'Rank the World' },
  { id: 'mystery-passport', name: 'Mystery Passport' },
  { id: 'outline-sketch', name: 'Outline Sketch' },
  { id: 'flag-forge', name: 'Flag Forge' },
] as const;
export type GameId = (typeof GAMES)[number]['id'];

// The familiar school scale.
const SCALE: [number, string][] = [
  [97, 'A+'], [93, 'A'], [90, 'A-'],
  [87, 'B+'], [83, 'B'], [80, 'B-'],
  [77, 'C+'], [73, 'C'], [70, 'C-'],
  [67, 'D+'], [63, 'D'], [60, 'D-'],
  [0, 'F'],
];

export function gradeFor(pct: number): string {
  const p = Math.max(0, Math.min(100, pct));
  return SCALE.find(([min]) => p >= min)![1];
}

/** Grade family (A–F), used for colour. */
export const bandOf = (grade: string) => grade[0];

export interface DayResult {
  pct: number;
  grade: string;
}
const summaryKey = (key = dayKey()) => `summary:${key}`;

export function readToday(): Partial<Record<GameId, DayResult>> {
  const s = load<Record<string, DayResult> | null>(summaryKey(), null);
  if (!s || typeof s !== 'object') return {};
  const out: Partial<Record<GameId, DayResult>> = {};
  for (const g of GAMES) {
    const r = s[g.id];
    if (r && typeof r.pct === 'number' && Number.isFinite(r.pct)) out[g.id] = { pct: r.pct, grade: gradeFor(r.pct) };
  }
  return out;
}

function recordResult(game: GameId, pct: number, key: string) {
  const s = load<Record<string, DayResult> | null>(summaryKey(key), null) ?? {};
  s[game] = { pct: Math.round(pct), grade: gradeFor(pct) };
  save(summaryKey(key), s);
}

export function forgetResult(game: GameId, key = dayKey()) {
  const s = load<Record<string, DayResult> | null>(summaryKey(key), null);
  if (!s) return;
  delete s[game];
  if (Object.keys(s).length) save(summaryKey(key), s);
  else remove(summaryKey(key));
}

/** Overall grade for the day: the average of the games played so far. */
export function overall(results: Partial<Record<GameId, DayResult>>): DayResult | null {
  const vals = Object.values(results).filter(Boolean) as DayResult[];
  if (!vals.length) return null;
  const pct = vals.reduce((n, r) => n + r.pct, 0) / vals.length;
  return { pct: Math.round(pct), grade: gradeFor(pct) };
}

/**
 * Show the letter grade at the top of a game's result card and save it for the landing page.
 * `pct` is the share of the best possible result (0–100).
 */
export function showGrade(game: GameId, pct: number, key: string) {
  const p = Math.round(Math.max(0, Math.min(100, pct)));
  const grade = gradeFor(p);
  recordResult(game, p, key);
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
  scale.textContent = 'A 90%+ · B 80%+ · C 70%+ · D 60%+ · F below 60%';
  info.append(pctLine, scale);
  box.replaceChildren(letter, info);
}
