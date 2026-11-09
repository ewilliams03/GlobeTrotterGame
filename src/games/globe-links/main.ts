import '../../shared/base';
import '../../shared/game.css';
import './game.css';
import { COUNTRIES } from '../../data/countries';
import { dayIndex, dayKey, msUntilTomorrow, seededRandom, shuffle } from '../../shared/daily';
import { load, save } from '../../shared/storage';
import { shareText } from '../../shared/share';
import { haptic } from '../../shared/haptics';
import { reducedMotion } from '../../shared/geo';
import { createAtlas } from './map';
import { arrive, miniGlobe } from '../../shared/travel';
import { showGrade } from '../../shared/grades';
import { addTestReset } from '../../shared/testing';
import { watchDayChange, focusQuietly, showFromTop } from '../../shared/session';
import { loadToday, showLoadError } from '../../shared/bank';

/* ---------- Types & data ---------- */
interface Group {
  category: string;
  difficulty: 1 | 2 | 3 | 4;
  countries: string[];
  fact: string;
  sourceUrl: string;
  label: string;
}
interface Puzzle {
  groups: Group[];
}
interface GameState {
  solved: string[]; // category ids, in the order found
  mistakes: number;
  guesses: string[][]; // every checked set of four, for sharing and duplicate detection
  order: string[]; // remaining tiles, in display order
  done: boolean;
  won: boolean;
  counted: boolean;
  hints: string[]; // category ids revealed by hints, in order
  namesSeen?: boolean; // a guess was checked while country names were showing (so not "flags only")
}
interface Stats {
  played: number;
  wins: number;
  streak: number;
  best: number;
  lastWinDay: number;
  lastPlayedDay: number;
}

const LEVELS = ['', 'Easy', 'Medium', 'Hard', 'Expert'];
// Shapes, not coloured squares, so a shared result is clearly our own (easy ● medium ▲ hard ■ expert ◆).
const SHARE_DOT = ['', '●', '▲', '■', '◆'];
const MAX_MISTAKES = 5;
const FREE_HINTS = 3;

const flagUrls = import.meta.glob('/node_modules/flag-icons/flags/4x3/*.svg', {
  eager: true,
  query: '?url',
  import: 'default',
}) as Record<string, string>;
const flag = (code: string) => flagUrls[`/node_modules/flag-icons/flags/4x3/${code}.svg`] ?? '';
const nameOf = (code: string) => COUNTRIES[code]?.name ?? code.toUpperCase();

const today = dayIndex();
const todayKey = dayKey(); // fixed before any await, so a slow load can't straddle midnight
const puzzleNo = today + 1;
const puzzle = await loadToday<Puzzle>('globe-links').catch((e) => {
  showLoadError(document.getElementById('board'));
  throw e;
});
const groupOf = (category: string) => puzzle.groups.find((g) => g.category === category)!;
const STATE_KEY = `globe-links:day:${todayKey}`;
const STATS_KEY = 'globe-links:stats';
const SETTINGS_KEY = 'globe-links:settings';

const fresh = (): GameState => ({
  solved: [],
  mistakes: 0,
  guesses: [],
  order: shuffle(
    puzzle.groups.flatMap((g) => g.countries),
    seededRandom(today * 7919 + 17),
  ),
  done: false,
  won: false,
  counted: false,
  hints: [],
});

let state = sanitize(load<GameState | null>(STATE_KEY, null));
const selected = new Set<string>();
let busy = false;

function sanitize(s: GameState | null): GameState {
  // Guard against stale or hand-edited storage: rebuild if it doesn't match today's puzzle.
  const all = new Set(puzzle.groups.flatMap((g) => g.countries));
  if (!s || typeof s !== 'object' || !Array.isArray(s.order) || !Array.isArray(s.solved)) return fresh();
  const solvedTiles = s.solved.flatMap((c) => groupOf(c)?.countries ?? []);
  const lost = s.done === true && s.won === false;
  const won = s.done === true && s.won === true;
  const valid =
    s.solved.every((c) => groupOf(c)) &&
    new Set(s.solved).size === s.solved.length &&
    new Set(s.order).size === s.order.length &&
    s.order.every((c) => all.has(c) && !solvedTiles.includes(c)) &&
    // A won game has all four groups; a game in progress can't have them all yet (it would be stuck with no tiles).
    (won ? s.solved.length === 4 : s.solved.length < 4) &&
    // A lost game clears the board on purpose, so its tile count is allowed to fall short.
    (lost ? s.order.length === 0 : s.order.length + solvedTiles.length === 16);
  if (!valid) return fresh();
  s.done = s.done === true;
  s.won = s.won === true;
  s.counted = s.counted === true;
  s.mistakes = Number.isInteger(s.mistakes) ? Math.max(0, Math.min(MAX_MISTAKES, s.mistakes)) : 0;
  s.guesses = Array.isArray(s.guesses)
    ? s.guesses.filter((g) => Array.isArray(g) && g.length === 4 && g.every((c) => all.has(c)))
    : [];
  // Older saves (before hints existed) get an empty hint list.
  s.hints = Array.isArray(s.hints) ? s.hints.filter((c) => groupOf(c)).slice(0, FREE_HINTS) : [];
  return s;
}
const persist = () => save(STATE_KEY, state);

/* ---------- Elements ---------- */
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const board = $('board');
const grid = $('grid');
const solvedList = $('solved');
const ticketsEl = $('tickets');
const statusEl = $('status');
const submitBtn = $<HTMLButtonElement>('submit');
const clearBtn = $<HTMLButtonElement>('clear');
const shuffleBtn = $<HTMLButtonElement>('shuffle');
const actions = $('actions');
const hardToggle = $<HTMLButtonElement>('hard-toggle');
const legend = $('legend');
const hintBtn = $<HTMLButtonElement>('hint');
const hintCount = $('hint-count');
const hintList = $('hints');
const mini = miniGlobe($('mini-globe'));
const atlas = createAtlas(document.getElementById('map') as unknown as SVGSVGElement);

$('puzzle-meta').textContent = `No. ${puzzleNo} · ${new Intl.DateTimeFormat(undefined, {
  weekday: 'short',
  day: 'numeric',
  month: 'short',
}).format(new Date())}`;

/* ---------- Rendering ---------- */
function tileEl(code: string): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'tile';
  btn.dataset.code = code;
  btn.setAttribute('aria-pressed', 'false');
  btn.setAttribute('aria-label', nameOf(code));
  const img = document.createElement('img');
  img.src = flag(code);
  img.alt = '';
  img.width = 64;
  img.height = 48;
  img.decoding = 'async';
  const name = document.createElement('span');
  name.className = 'tile-name';
  name.textContent = nameOf(code);
  const longest = Math.max(...nameOf(code).split(' ').map((w) => w.length));
  if (longest >= 10) name.classList.add('is-long');
  if (longest >= 12) name.classList.add('is-xlong');
  btn.append(img, name);
  return btn;
}

function renderGrid() {
  grid.replaceChildren(...state.order.map(tileEl));
  syncSelection();
}

function groupEl(g: Group, revealed = false): HTMLLIElement {
  const li = document.createElement('li');
  li.className = 'group' + (revealed ? ' is-revealed' : '');
  li.dataset.level = String(g.difficulty);

  const top = document.createElement('div');
  top.className = 'group-top';
  const label = document.createElement('p');
  label.className = 'group-label';
  label.textContent = g.label;
  const level = document.createElement('span');
  level.className = 'group-level';
  level.textContent = LEVELS[g.difficulty];
  top.append(label, level);

  const countries = document.createElement('p');
  countries.className = 'group-countries';
  for (const c of g.countries) {
    const span = document.createElement('span');
    const img = document.createElement('img');
    img.src = flag(c);
    img.alt = '';
    img.width = 20;
    img.height = 15;
    span.append(img, document.createTextNode(nameOf(c)));
    countries.append(span);
  }

  const fact = document.createElement('p');
  fact.className = 'group-fact';
  fact.append(document.createTextNode(g.fact + ' '));
  const src = document.createElement('a');
  src.href = g.sourceUrl;
  src.target = '_blank';
  src.rel = 'noopener noreferrer';
  src.textContent = 'Source';
  src.setAttribute('aria-label', `Source for ${g.label}`);
  fact.append(src);

  li.append(top, countries, fact);
  return li;
}

function renderSolved() {
  const revealed = state.done && !state.won;
  const shown = [...state.solved];
  if (revealed) {
    puzzle.groups
      .filter((g) => !shown.includes(g.category))
      .sort((a, b) => a.difficulty - b.difficulty)
      .forEach((g) => shown.push(g.category));
  }
  solvedList.replaceChildren(...shown.map((c) => groupEl(groupOf(c), revealed && !state.solved.includes(c))));
}

function renderTickets() {
  const left = MAX_MISTAKES - state.mistakes;
  ticketsEl.replaceChildren(
    ...Array.from({ length: MAX_MISTAKES }, (_, i) => {
      const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      s.setAttribute('viewBox', '0 0 26 16');
      s.setAttribute('class', 'ticket' + (i >= left ? ' is-used' : ''));
      s.setAttribute('aria-hidden', 'true');
      const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      p.setAttribute('d', 'M3 1h20a2 2 0 0 1 2 2v3a2 2 0 0 0 0 4v3a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2v-3a2 2 0 0 0 0-4V3a2 2 0 0 1 2-2Z');
      p.setAttribute('fill', 'currentColor');
      s.append(p);
      return s;
    }),
  );
  const label = document.createElement('span');
  label.className = 'visually-hidden';
  label.textContent = `${left} of ${MAX_MISTAKES} tickets left`;
  ticketsEl.append(label);
}

function renderAtlas(animateLatest = false) {
  const shownGroups = state.done ? puzzle.groups.map((g) => g.category) : state.solved;
  shownGroups.forEach((c, i) => {
    const g = groupOf(c);
    atlas.show({ level: g.difficulty, countries: g.countries, label: '' }, animateLatest && i === shownGroups.length - 1);
  });
  legend.replaceChildren(
    ...[...puzzle.groups]
      .sort((a, b) => a.difficulty - b.difficulty)
      .map((g) => {
        const li = document.createElement('li');
        li.dataset.level = String(g.difficulty);
        const known = shownGroups.includes(g.category);
        if (!known) li.className = 'is-empty';
        const i = document.createElement('i');
        li.append(i, document.createTextNode(known ? g.label : `${LEVELS[g.difficulty]} group, not found yet`));
        return li;
      }),
  );
}

function renderHints() {
  const left = FREE_HINTS - state.hints.length;
  hintCount.textContent = String(left);
  hintBtn.setAttribute('aria-label', `Use a hint. ${left} of ${FREE_HINTS} left.`);
  hintList.replaceChildren(
    ...state.hints.map((c) => {
      const g = groupOf(c);
      const li = document.createElement('li');
      li.dataset.level = String(g.difficulty);
      if (state.solved.includes(c)) li.className = 'is-solved';
      const dot = document.createElement('i');
      const label = document.createElement('strong');
      label.textContent = g.label;
      // One text box, so the sentence wraps as a sentence instead of splitting into flex columns.
      const text = document.createElement('span');
      text.append('One group is ', label);
      li.append(dot, text);
      return li;
    }),
  );
}

/** The group the next hint would name: the easiest one not solved or hinted yet. */
function nextHint(): Group | undefined {
  // With one group left the last four tiles are the answer, so a hint there would only cost grade.
  if (state.solved.length >= puzzle.groups.length - 1) return undefined;
  return [...puzzle.groups]
    .sort((a, b) => a.difficulty - b.difficulty)
    .find((g) => !state.solved.includes(g.category) && !state.hints.includes(g.category));
}

function useHint() {
  if (busy || state.done || state.hints.length >= FREE_HINTS) return;
  const next = nextHint();
  if (!next) return;
  haptic.tap();
  state.hints.push(next.category);
  persist();
  renderHints();
  syncSelection();
  const left = FREE_HINTS - state.hints.length;
  // Name the group in the announcement too, so screen reader users hear what the hint was.
  say(`One group is ${next.label}. ${left ? `${left} ${left === 1 ? 'hint' : 'hints'} left today.` : 'That was your last hint.'}`);
  // The button may now be disabled; don't strand keyboard focus on it.
  if (hintBtn.disabled && document.activeElement === hintBtn) focusQuietly(hintList.lastElementChild as HTMLElement | null);
}

function syncMini(focusOn?: Group) {
  const solvedGroups = (state.done ? puzzle.groups.map((g) => g.category) : state.solved).map(groupOf);
  mini.setDots(
    solvedGroups.flatMap((g) => g.countries.map((c) => ({ lon: COUNTRIES[c].lon, lat: COUNTRIES[c].lat, level: g.difficulty }))),
  );
  if (focusOn) mini.focus(focusOn.countries.map((c) => COUNTRIES[c]));
}

function syncSelection() {
  grid.querySelectorAll<HTMLButtonElement>('.tile').forEach((t) => {
    const on = selected.has(t.dataset.code!);
    t.setAttribute('aria-pressed', String(on));
    t.disabled = state.done;
  });
  submitBtn.disabled = selected.size !== 4 || busy || state.done;
  hintBtn.disabled = busy || state.done || state.hints.length >= FREE_HINTS || !nextHint();
  clearBtn.disabled = selected.size === 0 || busy || state.done;
  shuffleBtn.disabled = busy || state.done;
}

let statusTimer = 0;
function say(msg: string, sticky = false) {
  // Once the puzzle is over the action bar is gone, so messages go to the result panel.
  const target = state.done ? $('result-msg') : statusEl;
  target.textContent = msg;
  clearTimeout(statusTimer);
  if (!sticky) statusTimer = window.setTimeout(() => (target.textContent = ''), 2600);
}

/* ---------- Motion helpers ---------- */
const wait = (ms: number) => new Promise((r) => setTimeout(r, reducedMotion() ? 0 : ms));

// FLIP: measure tiles, mutate the DOM, then animate each tile from its old spot.
function flip(mutate: () => void) {
  const before = new Map<string, DOMRect>();
  grid.querySelectorAll<HTMLElement>('.tile').forEach((t) => before.set(t.dataset.code!, t.getBoundingClientRect()));
  mutate();
  if (reducedMotion()) return;
  grid.querySelectorAll<HTMLElement>('.tile').forEach((t) => {
    const a = before.get(t.dataset.code!);
    if (!a) return;
    const b = t.getBoundingClientRect();
    const dx = a.left - b.left;
    const dy = a.top - b.top;
    if (Math.abs(dx) < 1 && Math.abs(dy) < 1) return;
    t.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }], {
      duration: 340,
      easing: 'cubic-bezier(0.23, 1, 0.32, 1)',
    });
  });
}

/* ---------- Game logic ---------- */
function toggle(code: string) {
  if (busy || state.done) return;
  if (selected.has(code)) {
    selected.delete(code);
  } else {
    if (selected.size >= 4) {
      say('Four at a time. Deselect one first.');
      haptic.error();
      return;
    }
    selected.add(code);
  }
  haptic.select();
  syncSelection();
}

async function check() {
  if (selected.size !== 4 || busy || state.done) return;
  const guess = [...selected].sort();
  if (state.guesses.some((g) => g.join() === guess.join())) {
    say('You already tried that four.');
    haptic.error();
    return;
  }
  busy = true;
  syncSelection();
  state.guesses.push(guess);

  if (!settings.hard) state.namesSeen = true;

  // A little hop across the chosen tiles before the verdict.
  const chosen = [...grid.querySelectorAll<HTMLElement>('.tile')].filter((t) => selected.has(t.dataset.code!));
  // A tile that shook on an earlier miss keeps its class; drop it, or the shake replays after the hop.
  chosen.forEach((t) => t.classList.remove('is-wrong'));
  if (!reducedMotion()) {
    chosen.forEach((t, i) => {
      t.style.animationDelay = `${i * 70}ms`;
      t.classList.add('is-hop');
    });
    await wait(320 + 3 * 70);
    chosen.forEach((t) => {
      t.classList.remove('is-hop');
      t.style.animationDelay = '';
    });
  }

  const match = puzzle.groups.find((g) => !state.solved.includes(g.category) && g.countries.every((c) => selected.has(c)));
  if (match) {
    await solve(match);
  } else {
    await miss(guess);
  }
  busy = false;
  persist();
  syncSelection();
}

async function solve(g: Group) {
  haptic.success();
  // 1) slide the four tiles to the top row, 2) swap them for the solved banner.
  flip(() => {
    state.order = [...g.countries.filter((c) => state.order.includes(c)), ...state.order.filter((c) => !g.countries.includes(c))];
    const byCode = new Map([...grid.querySelectorAll<HTMLElement>('.tile')].map((t) => [t.dataset.code!, t]));
    grid.replaceChildren(...state.order.map((c) => byCode.get(c)!));
  });
  await wait(360);
  state.order = state.order.filter((c) => !g.countries.includes(c));
  state.solved.push(g.category);
  selected.clear();
  grid.querySelectorAll<HTMLElement>('.tile').forEach((t) => {
    if (g.countries.includes(t.dataset.code!)) t.remove();
  });
  solvedList.append(groupEl(g));
  renderAtlas(true);
  renderHints();
  syncMini(g);
  say(`${g.label}. Nice!`);
  if (!document.activeElement || document.activeElement === document.body) grid.querySelector<HTMLElement>('.tile')?.focus();

  if (state.solved.length === 4) finish(true);
}

async function miss(guess: string[]) {
  haptic.error();
  state.mistakes += 1;
  const best = Math.max(...puzzle.groups.filter((g) => !state.solved.includes(g.category)).map((g) => g.countries.filter((c) => guess.includes(c)).length));
  grid.querySelectorAll<HTMLElement>('.tile').forEach((t) => {
    if (!selected.has(t.dataset.code!)) return;
    t.classList.remove('is-wrong');
    void t.offsetWidth;
    t.classList.add('is-wrong');
  });
  renderTickets();
  const left = MAX_MISTAKES - state.mistakes;
  if (left === 0) {
    await wait(420);
    statusEl.textContent = '';
    finish(false);
    return;
  }
  say(best === 3 ? 'So close: three of those belong together.' : left === 1 ? 'Not a group. Last ticket!' : 'Not a group. Try another four.');
  await wait(380);
}

function finish(won: boolean) {
  state.done = true;
  state.won = won;
  selected.clear();
  if (!won) {
    state.order = [];
    grid.replaceChildren();
    renderSolved();
  }
  if (!state.counted) {
    state.counted = true;
    const stats = glStats();
    if (stats.lastPlayedDay !== today) recordStats(stats, won);
  }
  persist();
  renderAtlas(false);
  renderHints();
  syncMini();
  renderResult();
  focusQuietly($('result-title'));
  showFromTop($('result'));
}

function recordStats(stats: Stats, won: boolean) {
  {
    stats.lastPlayedDay = today;
    stats.played += 1;
    if (won) {
      stats.wins += 1;
      stats.streak = stats.lastWinDay === today - 1 ? stats.streak + 1 : 1;
      stats.best = Math.max(stats.best, stats.streak);
      stats.lastWinDay = today;
    } else {
      stats.streak = 0;
    }
    save(STATS_KEY, stats);
  }
}

/** Stats from storage, validated so old or tampered values can't crash the game. */
function glStats(): Stats {
  const s = load<Partial<Stats> | null>(STATS_KEY, null);
  const n = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
  const o = s && typeof s === 'object' ? s : {};
  return { played: n(o.played, 0), wins: n(o.wins, 0), streak: n(o.streak, 0), best: n(o.best, 0), lastWinDay: n(o.lastWinDay, -2), lastPlayedDay: n(o.lastPlayedDay, -2) };
}

/* ---------- Result ---------- */
function renderResult() {
  const box = $('result');
  if (!state.done) {
    box.hidden = true;
    actions.hidden = false;
    return;
  }
  actions.hidden = true;
  box.hidden = false;
  showGrade('globe-links', state.won ? Math.max(70, 100 - 6 * state.mistakes - 4 * state.hints.length) : 15 + state.solved.length * 18, todayKey);
  const perfect = state.won && state.mistakes === 0;
  $('result-title').textContent = state.won ? (perfect ? 'Perfect trip.' : 'Trip complete.') : 'Out of tickets.';
  $('result-sub').textContent = state.won
    ? `You found all four links with ${state.mistakes === 0 ? 'no wrong guesses' : `${state.mistakes} wrong ${state.mistakes === 1 ? 'guess' : 'guesses'}`}. Scroll down to see them on the map.`
    : 'Every group is revealed above, with the facts behind it. A new board arrives tomorrow.';

  const stats = glStats();
  // A streak only counts if it is still alive (won yesterday or today).
  const streak = stats.lastWinDay >= today - 1 ? stats.streak : 0;
  const rows: [string, string][] = [
    ['Played', String(stats.played)],
    ['Win rate', stats.played ? `${Math.round((stats.wins / stats.played) * 100)}%` : '0%'],
    ['Streak', String(streak)],
    ['Best streak', String(stats.best)],
  ];
  $('stats').replaceChildren(
    ...rows.map(([k, v]) => {
      const d = document.createElement('div');
      const dt = document.createElement('dt');
      dt.textContent = k;
      const dd = document.createElement('dd');
      dd.textContent = v;
      d.append(dt, dd);
      return d;
    }),
  );
  startCountdown();
}

function shareString(): string {
  const lines = state.guesses.map((guess) =>
    guess.map((c) => SHARE_DOT[puzzle.groups.find((g) => g.countries.includes(c))!.difficulty]).join(''),
  );
  // Only claim "flags only" if names were hidden for every guess, not switched on at the end.
  const hard = settings.hard && !state.namesSeen ? ' · flags only' : '';
  const hints = state.hints.length ? [`${state.hints.length} ${state.hints.length === 1 ? 'hint' : 'hints'} used`] : [];
  return [`Globe Links No. ${puzzleNo}${hard}`, ...lines, ...hints, `${location.origin}/games/globe-links`].join('\n');
}

let countdownTimer = 0;
function startCountdown() {
  const el = $('countdown');
  const tick = () => {
    const ms = msUntilTomorrow();
    // The day rollover itself is handled by watchDayChange; here we just stop at zero.
    const s = Math.floor(ms / 1000);
    const hh = String(Math.floor(s / 3600)).padStart(2, '0');
    const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
    const ss = String(s % 60).padStart(2, '0');
    el.textContent = `${hh}:${mm}:${ss}`;
  };
  clearInterval(countdownTimer);
  tick();
  countdownTimer = window.setInterval(tick, 1000);
}

/* ---------- Settings ---------- */
const savedSettings = load<{ hard?: unknown } | null>(SETTINGS_KEY, null);
const settings = { hard: !!savedSettings && typeof savedSettings === 'object' && savedSettings.hard === true };
function applyHard() {
  board.classList.toggle('is-hard', settings.hard);
  hardToggle.setAttribute('aria-checked', String(settings.hard));
}

/* ---------- Events ---------- */
grid.addEventListener('click', (e) => {
  const tile = (e.target as HTMLElement).closest<HTMLButtonElement>('.tile');
  if (tile) toggle(tile.dataset.code!);
});
submitBtn.addEventListener('click', () => {
  haptic.tap();
  void check();
});
clearBtn.addEventListener('click', () => {
  haptic.tap();
  selected.clear();
  syncSelection();
});
shuffleBtn.addEventListener('click', () => {
  if (busy) return;
  haptic.tap();
  flip(() => {
    state.order = shuffle(state.order);
    const byCode = new Map([...grid.querySelectorAll<HTMLElement>('.tile')].map((t) => [t.dataset.code!, t]));
    grid.replaceChildren(...state.order.map((c) => byCode.get(c)!));
  });
  persist();
});
hintBtn.addEventListener('click', useHint);
hardToggle.addEventListener('click', () => {
  haptic.tap();
  settings.hard = !settings.hard;
  save(SETTINGS_KEY, settings);
  applyHard();
});
$('share').addEventListener('click', async () => {
  haptic.tap();
  const result = await shareText(shareString());
  if (result === 'copied') say('Result copied. Paste it anywhere.');
  else if (result === 'failed') say("Couldn't share from this browser.");
});
// Enter submits from anywhere on the board when four are selected.
board.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && selected.size === 4 && (e.target as HTMLElement).closest('.tile')) {
    e.preventDefault();
    void check();
  }
});

/* ---------- Boot ---------- */
applyHard();
renderTickets();
renderSolved();
renderGrid();
renderAtlas(false);
renderHints();
syncMini();
renderResult();
void arrive(mini, $('mini-globe'));
watchDayChange(todayKey);
addTestReset('globe-links', STATE_KEY, todayKey);
