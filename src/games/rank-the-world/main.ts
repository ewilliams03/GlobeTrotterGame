import '../../shared/base';
import '../../shared/game.css';
import './rtw.css';
import { COUNTRIES } from '../../data/countries';
import { dayIndex, dayKey, msUntilTomorrow, seededRandom, shuffle } from '../../shared/daily';
import { load, save } from '../../shared/storage';
import { shareText } from '../../shared/share';
import { haptic } from '../../shared/haptics';
import { reducedMotion } from '../../shared/geo';
import { arrive, miniGlobe } from '../../shared/travel';
import { showGrade } from '../../shared/grades';
import { addTestReset } from '../../shared/testing';
import { watchDayChange, recordDay, readStats, focusQuietly, scrollToTop, showFromTop } from '../../shared/session';
import { icon } from '../../shared/icons';
import { loadToday, showLoadError } from '../../shared/bank';

/* ---------- Types & data ---------- */
interface Stat {
  title: string;
  order: string;
  direction: 'asc' | 'desc';
  computed?: 'lat';
  sourceUrl: string;
  values?: Record<string, number>;
  labels?: Record<string, string>;
}
interface Round {
  stat: string;
  countries: string[];
  fact: string;
  sourceUrl: string;
}
interface Answer {
  order: string[];
  points: number[];
}
interface State {
  orders: string[][]; // the player's current arrangement for each round
  pins: Record<number, string[]>; // countries pinned in place by hints
  answers: Answer[];
  cursor: number;
  done: boolean;
  counted: boolean;
}

const ROUNDS = 4;
const SIZE = 5;
const MAX = ROUNDS * SIZE * 2;
const FREE_HINTS = 3;
const STAT_ICON: Record<string, string> = { highest: 'mountain', lowest: 'south', area: 'area', neighbours: 'borders', coastline: 'coast', north: 'north', south: 'south' };
const STAT_SHORT: Record<string, string> = { lowest: 'Lows   ', highest: 'Peaks  ', area: 'Area   ', neighbours: 'Borders', coastline: 'Coast  ', north: 'North  ', south: 'South  ' };

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
const { rounds, stats } = await loadToday<{ rounds: Round[]; stats: Record<string, Stat> }>('rank-the-world').catch((e) => {
  showLoadError(document.getElementById('board'));
  throw e;
});
const statOf = (i: number) => stats[rounds[i].stat];
const valueOf = (i: number, c: string) => {
  const s = statOf(i);
  return s.computed === 'lat' ? COUNTRIES[c].lat : (s.values?.[c] ?? 0);
};
const correctOrder = (i: number) =>
  [...rounds[i].countries].sort((a, b) => (statOf(i).direction === 'desc' ? valueOf(i, b) - valueOf(i, a) : valueOf(i, a) - valueOf(i, b)));

function startingOrder(i: number): string[] {
  const order = shuffle(rounds[i].countries, seededRandom(today * 389 + i * 61 + 3));
  return order.join() === correctOrder(i).join() ? order.reverse() : order;
}

const STATE_KEY = `rank-the-world:day:${todayKey}`;
const STATS_KEY = 'rank-the-world:stats';

function sanitize(s: State | null): State {
  const fresh: State = { orders: rounds.map((_, i) => startingOrder(i)), pins: {}, answers: [], cursor: 0, done: false, counted: false };
  if (!s || !Array.isArray(s.orders) || !Array.isArray(s.answers) || typeof s.pins !== 'object' || !s.pins) return fresh;
  const valid = rounds.every((r, i) => {
    const o = s.orders[i];
    return Array.isArray(o) && o.length === SIZE && [...o].sort().join() === [...r.countries].sort().join();
  });
  if (!valid || s.answers.length > ROUNDS) return fresh;
  s.cursor = Math.min(Math.max(0, s.cursor | 0), ROUNDS - 1, s.answers.length);
  return s;
}
const state = sanitize(load<State | null>(STATE_KEY, null));
const persist = () => save(STATE_KEY, state);
const hintsUsed = () => Object.values(state.pins).reduce((n, p) => n + p.length, 0);
const score = () => state.answers.reduce((n, a) => n + a.points.reduce((x, y) => x + y, 0), 0);

/* ---------- Ordering with pinned countries ---------- */
function arrange(i: number, order: string[], moving: string | null, toIndex: number): string[] {
  const pinned = new Set(state.pins[i] ?? []);
  const truth = correctOrder(i);
  const pinnedSlots = new Set([...pinned].map((c) => truth.indexOf(c)));
  const freeSlots = [...Array(SIZE).keys()].filter((k) => !pinnedSlots.has(k));
  const free = order.filter((c) => !pinned.has(c) && c !== moving);
  if (moving && !pinned.has(moving)) {
    // Insert at the free slot closest to where the player dropped it.
    let k = freeSlots.findIndex((slot) => slot >= toIndex);
    if (k < 0) k = freeSlots.length - 1;
    free.splice(k, 0, moving);
  }
  const out: string[] = Array(SIZE);
  pinned.forEach((c) => (out[truth.indexOf(c)] = c));
  freeSlots.forEach((slot, j) => (out[slot] = free[j]));
  return out;
}

/* ---------- Elements ---------- */
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const list = $('ranks');
const lockBtn = $<HTMLButtonElement>('lock');
const hintBtn = $<HTMLButtonElement>('hint');
const nextBtn = $<HTMLButtonElement>('next');
const card = $('card');
const statusEl = $('status');
const mini = miniGlobe($('mini-globe'));
let busy = false;

$('puzzle-meta').textContent = `No. ${puzzleNo} · ${new Intl.DateTimeFormat(undefined, {
  weekday: 'short',
  day: 'numeric',
  month: 'short',
}).format(new Date())}`;

/* ---------- Formatting ---------- */
function formatValue(i: number, c: string): string {
  const s = statOf(i);
  const v = valueOf(i, c);
  if (s.computed === 'lat') return `${Math.abs(v).toFixed(1)}° ${v >= 0 ? 'N' : 'S'}`;
  if (rounds[i].stat === 'highest') return `${v.toLocaleString('en-US')} m`;
  if (rounds[i].stat === 'area') return `${v.toLocaleString('en-US')} km²`;
  if (rounds[i].stat === 'lowest') return v === 0 ? 'Sea level' : `${v.toLocaleString('en-US')} m`;
  if (rounds[i].stat === 'coastline') return `${v.toLocaleString('en-US')} km`;
  if (rounds[i].stat === 'neighbours') return `${v} ${v === 1 ? 'neighbour' : 'neighbours'}`;
  return String(v);
}
const ordinal = (n: number) => `${n}${['th', 'st', 'nd', 'rd'][n % 100 > 10 && n % 100 < 14 ? 0 : Math.min(n % 10, 4) % 4] ?? 'th'}`;
const pointsFor = (userIdx: number, trueIdx: number): number => (userIdx === trueIdx ? 2 : Math.abs(userIdx - trueIdx) === 1 ? 1 : 0);

/* ---------- Rendering ---------- */
function rowEl(c: string): HTMLLIElement {
  const li = document.createElement('li');
  li.className = 'rank';
  li.dataset.code = c;
  const pos = document.createElement('span');
  pos.className = 'rank-pos';
  pos.setAttribute('aria-hidden', 'true');
  const img = document.createElement('img');
  img.className = 'rank-flag';
  img.src = flag(c);
  img.alt = '';
  img.draggable = false;
  const main = document.createElement('span');
  main.className = 'rank-main';
  const name = document.createElement('span');
  name.className = 'rank-name';
  name.textContent = nameOf(c);
  const detail = document.createElement('span');
  detail.className = 'rank-detail';
  main.append(name, detail);
  const moves = document.createElement('span');
  moves.className = 'rank-moves';
  for (const dir of ['up', 'down'] as const) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'rank-move';
    b.dataset.dir = dir;
    b.setAttribute('aria-label', `Move ${nameOf(c)} ${dir}`);
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('width', '20');
    svg.setAttribute('height', '20');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    p.setAttribute('d', dir === 'up' ? 'M6 15l6-6 6 6' : 'M6 9l6 6 6-6');
    p.setAttribute('fill', 'none');
    p.setAttribute('stroke', 'currentColor');
    p.setAttribute('stroke-width', '2.4');
    p.setAttribute('stroke-linecap', 'round');
    p.setAttribute('stroke-linejoin', 'round');
    svg.append(p);
    b.append(svg);
    moves.append(b);
  }
  li.append(pos, img, main, moves);
  return li;
}

function syncRows() {
  const i = state.cursor;
  const answer = state.answers[i];
  const pins = new Set(state.pins[i] ?? []);
  const s = statOf(i);
  const rows = [...list.querySelectorAll<HTMLLIElement>('.rank')];
  const maxAbs = Math.max(...rounds[i].countries.map((c) => Math.abs(valueOf(i, c))));
  rows.forEach((li, idx) => {
    const c = li.dataset.code!;
    (li.querySelector('.rank-pos') as HTMLElement).textContent = String(idx + 1);
    const detail = li.querySelector('.rank-detail') as HTMLElement;
    const pinned = pins.has(c);
    li.classList.toggle('is-pinned', pinned && !answer);
    li.setAttribute('aria-label', `${idx + 1}. ${nameOf(c)}${pinned ? ', pinned by a hint' : ''}`);
    if (answer) {
      const userIdx = answer.order.indexOf(c);
      const pts = pointsFor(userIdx, idx);
      li.classList.add('is-revealed');
      li.dataset.level = pts === 2 ? '1' : pts === 1 ? '3' : '4';
      const label = s.labels?.[c];
      detail.textContent = label ? `${formatValue(i, c)} · ${label}` : formatValue(i, c);
      li.querySelector('.rank-moves')?.remove();
      if (!li.querySelector('.rank-verdict')) {
        const v = document.createElement('span');
        v.className = 'rank-verdict';
        const p = document.createElement('span');
        p.className = 'rank-pts';
        p.textContent = `+${pts}`;
        const was = document.createElement('span');
        was.className = 'rank-was';
        was.textContent = userIdx === idx ? 'Spot on' : `You had it ${ordinal(userIdx + 1)}`;
        v.append(p, was);
        li.append(v);
        const bar = document.createElement('span');
        bar.className = 'rank-bar';
        li.append(bar);
        const fill = Math.max(0.04, Math.abs(valueOf(i, c)) / maxAbs);
        requestAnimationFrame(() => requestAnimationFrame(() => bar.style.setProperty('--fill', fill.toFixed(3))));
      }
      li.setAttribute('aria-label', `${idx + 1}. ${nameOf(c)}, ${detail.textContent}. You placed it ${ordinal(userIdx + 1)}, ${pts} points.`);
    } else {
      // Before the reveal only the capital's name is shown (it helps without giving it away).
      detail.textContent = s.computed === 'lat' ? (s.labels?.[c] ?? '') : '';
      if (pinned) {
        detail.replaceChildren();
        const tag = document.createElement('span');
        tag.className = 'pin-tag';
        tag.append(icon('pin', 14), document.createTextNode(`Pinned in the right spot${s.computed === 'lat' ? ` · ${s.labels?.[c] ?? ''}` : ''}`));
        detail.append(tag);
      }
      li.querySelectorAll<HTMLButtonElement>('.rank-move').forEach((b) => {
        const dir = b.dataset.dir === 'up' ? -1 : 1;
        b.disabled = busy || pinned || !canMove(idx, dir);
      });
    }
  });
}

function canMove(idx: number, dir: number): boolean {
  const i = state.cursor;
  const pinnedSlots = new Set((state.pins[i] ?? []).map((c) => correctOrder(i).indexOf(c)));
  for (let k = idx + dir; k >= 0 && k < SIZE; k += dir) if (!pinnedSlots.has(k)) return true;
  return false;
}

function renderTrip() {
  $('trip').replaceChildren(
    ...rounds.map((r, i) => {
      const li = document.createElement('li');
      const a = state.answers[i];
      if (a) {
        li.className = 'is-done';
        const pts = a.points.reduce((x, y) => x + y, 0);
        li.dataset.level = pts >= 8 ? '1' : pts >= 5 ? '3' : '4';
      }
      if (i === state.cursor && !state.done) li.classList.add('is-current');
      const stop = document.createElement('span');
      stop.className = 'stop';
      stop.append(icon(STAT_ICON[r.stat] ?? 'compass', 15));
      const label = document.createElement('span');
      label.className = 'visually-hidden';
      label.textContent = `Round ${i + 1}: ${stats[r.stat].title}${a ? ', done' : i === state.cursor ? ', current' : ''}`;
      li.append(stop, label);
      return li;
    }),
  );
}

function renderHint() {
  const left = FREE_HINTS - hintsUsed();
  $('hint-count').textContent = String(left);
  hintBtn.setAttribute('aria-label', `Use a hint. ${left} of ${FREE_HINTS} left.`);
  const answered = !!state.answers[state.cursor];
  const allPlaced = state.orders[state.cursor].every((c, idx) => correctOrder(state.cursor).indexOf(c) === idx);
  hintBtn.disabled = busy || state.done || answered || left <= 0 || allPlaced;
}

function renderCard() {
  const i = state.cursor;
  const s = statOf(i);
  const answer = state.answers[i];
  $('card-step').textContent = `Round ${i + 1} of ${ROUNDS}`;
  $('card-title').textContent = s.title;
  ($('card-order').querySelector('span') as HTMLElement).textContent = s.order;
  $('score').textContent = String(score());
  const order = answer ? correctOrder(i) : state.orders[i];
  list.replaceChildren(...order.map((c) => rowEl(c)));
  syncRows();
  (lockBtn.parentElement as HTMLElement).hidden = !!answer;
  $('after').hidden = !answer;
  if (answer) renderAfter();
  else statusEl.textContent = window.matchMedia('(pointer: coarse)').matches ? 'Drag a country by its number, or use the arrows.' : 'Drag the countries into order, or use the arrows.';
  renderHint();
  renderTrip();
  syncMini();
}

function renderAfter() {
  const i = state.cursor;
  const a = state.answers[i];
  const total = a.points.reduce((x, y) => x + y, 0);
  statusEl.textContent = '';
  const fact = $('fact');
  const lead = document.createElement('strong');
  lead.textContent = 'Did you know? ';
  const src = document.createElement('a');
  src.href = rounds[i].sourceUrl;
  src.target = '_blank';
  src.rel = 'noopener noreferrer';
  src.textContent = 'Source';
  fact.replaceChildren(lead, document.createTextNode(`${rounds[i].fact} `), src);
  const v = $('verdict');
  v.replaceChildren(document.createTextNode(total === 10 ? 'Perfect order.' : total >= 7 ? 'So close.' : total >= 4 ? 'Not bad.' : 'Tricky one.'));
  const pts = document.createElement('span');
  pts.className = 'pts';
  pts.dataset.level = total >= 8 ? '1' : total >= 5 ? '3' : '4';
  pts.textContent = `+${total}`;
  v.append(pts);
  nextBtn.textContent = i === ROUNDS - 1 ? 'See your results' : 'Next round';
}

function syncMini() {
  const i = state.cursor;
  const a = state.answers[i];
  const truth = correctOrder(i);
  mini.setDots(
    rounds[i].countries.map((c) => {
      const pts = a ? pointsFor(a.order.indexOf(c), truth.indexOf(c)) : -1;
      return { lon: COUNTRIES[c].lon, lat: COUNTRIES[c].lat, level: pts === 2 ? 1 : pts === 1 ? 3 : pts === 0 ? 4 : 5 };
    }),
  );
  mini.focus(rounds[i].countries.map((c) => COUNTRIES[c]));
}

/* ---------- Motion ---------- */
function flip(mutate: () => void, skip?: Element) {
  const before = new Map<Element, DOMRect>();
  list.querySelectorAll('.rank').forEach((el) => el !== skip && before.set(el, el.getBoundingClientRect()));
  mutate();
  if (reducedMotion()) return;
  before.forEach((a, el) => {
    const b = el.getBoundingClientRect();
    const dy = a.top - b.top;
    if (Math.abs(dy) < 1) return;
    el.animate([{ transform: `translateY(${dy}px)` }, { transform: 'none' }], { duration: 260, easing: 'cubic-bezier(0.23, 1, 0.32, 1)' });
  });
}

function applyOrder(order: string[], skip?: Element) {
  const i = state.cursor;
  if (order.join() === state.orders[i].join()) return false;
  state.orders[i] = order;
  const byCode = new Map([...list.querySelectorAll<HTMLLIElement>('.rank')].map((li) => [li.dataset.code!, li]));
  flip(() => list.replaceChildren(...order.map((c) => byCode.get(c)!)), skip);
  syncRows();
  renderHint();
  return true;
}

/* ---------- Drag to reorder (pointer events: mouse, touch and pen) ---------- */
let drag: { li: HTMLLIElement; code: string; id: number; grab: number } | null = null;

list.addEventListener('pointerdown', (e) => {
  const li = (e.target as HTMLElement).closest<HTMLLIElement>('.rank');
  if (!li || drag || busy || state.done || state.answers[state.cursor]) return;
  if ((e.target as HTMLElement).closest('button')) return;
  // On touch screens only the number badge drags, so swiping the list still scrolls the page.
  if (e.pointerType === 'touch' && !(e.target as HTMLElement).closest('.rank-pos')) return;
  if ((state.pins[state.cursor] ?? []).includes(li.dataset.code!)) return;
  if (e.button !== 0) return;
  e.preventDefault();
  drag = { li, code: li.dataset.code!, id: e.pointerId, grab: e.clientY - li.getBoundingClientRect().top };
  li.setPointerCapture(e.pointerId);
  li.classList.add('is-dragging');
  li.style.transform = 'translateY(0px) scale(1.02)';
  haptic.select();
});

window.addEventListener('pointermove', (e) => {
  if (!drag || e.pointerId !== drag.id) return;
  if (busy || state.done || state.answers[state.cursor]) return cancelDrag();
  const rows = [...list.querySelectorAll<HTMLLIElement>('.rank')];
  const listTop = list.getBoundingClientRect().top;
  const h = drag.li.offsetHeight;
  const centre = e.clientY - drag.grab + h / 2 - listTop;
  // Target slot = how many other rows' midpoints sit above the dragged row's centre.
  let target = 0;
  rows.forEach((r) => {
    if (r !== drag!.li && r.offsetTop + r.offsetHeight / 2 < centre) target++;
  });
  const next = arrange(state.cursor, state.orders[state.cursor], drag.code, target);
  if (applyOrder(next, drag.li)) haptic.select();
  const offset = e.clientY - drag.grab - (listTop + drag.li.offsetTop);
  drag.li.style.transform = `translateY(${offset}px) scale(1.02)`;
});

/** Stop any drag in progress without animating (used when the round locks or moves on). */
function cancelDrag() {
  if (!drag) return;
  drag.li.style.transform = '';
  drag.li.classList.remove('is-dragging');
  drag = null;
}

function endDrag(e: PointerEvent) {
  if (!drag || e.pointerId !== drag.id) return;
  const { li } = drag;
  drag = null;
  const current = li.style.transform;
  li.style.transform = '';
  li.classList.remove('is-dragging');
  if (current && !reducedMotion()) {
    li.animate([{ transform: current }, { transform: 'none' }], { duration: 220, easing: 'cubic-bezier(0.23, 1, 0.32, 1)' });
  }
  persist();
}
// Listen on the window: reordering the list mid-drag can drop pointer capture, and the release
// must still end the drag wherever it happens.
window.addEventListener('pointerup', endDrag);
window.addEventListener('pointercancel', endDrag);
list.addEventListener('lostpointercapture', (e) => {
  if (drag && e.pointerId === drag.id && !(e.buttons & 1)) endDrag(e);
});

// Arrow buttons (also the keyboard-accessible way to reorder).
list.addEventListener('click', (e) => {
  const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('.rank-move');
  if (!btn || btn.disabled) return;
  const li = btn.closest<HTMLLIElement>('.rank')!;
  const i = state.cursor;
  const idx = state.orders[i].indexOf(li.dataset.code!);
  const dir = btn.dataset.dir === 'up' ? -1 : 1;
  const pinnedSlots = new Set((state.pins[i] ?? []).map((c) => correctOrder(i).indexOf(c)));
  let to = idx + dir;
  while (pinnedSlots.has(to)) to += dir;
  haptic.tap();
  applyOrder(arrange(i, state.orders[i], li.dataset.code!, to));
  persist();
  const pos = state.orders[i].indexOf(li.dataset.code!) + 1;
  statusEl.textContent = `${nameOf(li.dataset.code!)} moved to ${ordinal(pos)}.`;
  // Keep focus on the same arrow so repeated presses keep moving the same country.
  if (btn.disabled) li.querySelector<HTMLButtonElement>(`.rank-move:not(:disabled)`)?.focus();
  else btn.focus();
});

/* ---------- Actions ---------- */
function lockIn() {
  cancelDrag();
  const i = state.cursor;
  if (busy || state.answers[i] || state.done) return;
  const truth = correctOrder(i);
  const order = [...state.orders[i]];
  const points = order.map((c, idx) => pointsFor(idx, truth.indexOf(c)));
  state.answers.push({ order, points });
  persist();
  const total = points.reduce((x, y) => x + y, 0);
  if (total >= 7) haptic.success();
  else haptic.error();
  // Slide every country into its true position, then reveal values.
  const byCode = new Map([...list.querySelectorAll<HTMLLIElement>('.rank')].map((li) => [li.dataset.code!, li]));
  flip(() => list.replaceChildren(...truth.map((c) => byCode.get(c)!)));
  syncRows();
  (lockBtn.parentElement as HTMLElement).hidden = true;
  $('after').hidden = false;
  renderAfter();
  const scoreEl = $('score');
  scoreEl.textContent = String(score());
  scoreEl.classList.remove('is-bump');
  void scoreEl.offsetWidth;
  scoreEl.classList.add('is-bump');
  renderHint();
  renderTrip();
  syncMini();
  nextBtn.focus({ preventScroll: true });
  showFromTop(card);
}

async function next() {
  if (busy) return;
  cancelDrag();
  haptic.tap();
  if (state.cursor >= ROUNDS - 1) {
    finish();
    return;
  }
  busy = true;
  if (!reducedMotion()) {
    card.classList.add('is-leaving');
    await new Promise((r) => setTimeout(r, 170));
    card.classList.remove('is-leaving');
  }
  state.cursor += 1;
  persist();
  busy = false;
  renderCard();
  focusQuietly(card.querySelector('h2'));
  if (!reducedMotion()) {
    card.classList.add('is-entering');
    setTimeout(() => card.classList.remove('is-entering'), 360);
  }
  showFromTop(card);
}

function useHint() {
  cancelDrag();
  const i = state.cursor;
  if (busy || state.done || state.answers[i] || hintsUsed() >= FREE_HINTS) return;
  const truth = correctOrder(i);
  const pinned = new Set(state.pins[i] ?? []);
  // Pin the country that is furthest from where it belongs.
  const candidates = state.orders[i]
    .map((c, idx) => ({ c, off: Math.abs(idx - truth.indexOf(c)) }))
    .filter((x) => !pinned.has(x.c) && x.off > 0)
    .sort((a, b) => b.off - a.off);
  if (!candidates.length) return;
  haptic.tap();
  const c = candidates[0].c;
  state.pins[i] = [...pinned, c];
  applyOrder(arrange(i, state.orders[i], null, 0));
  syncRows();
  persist();
  renderHint();
  const left = FREE_HINTS - hintsUsed();
  statusEl.textContent = `${nameOf(c)} is pinned in its right spot. ${left ? `${left} hint left today.` : 'That was your last hint today.'}`;
}

function finish() {
  state.done = true;
  if (!state.counted) {
    state.counted = true;
    recordDay(STATS_KEY, today, score());
  }
  persist();
  render();
  focusQuietly($('result-title'));
  scrollToTop();
}

/* ---------- Result ---------- */
function renderResult() {
  $('result').hidden = !state.done;
  $('recap').hidden = !state.done;
  $('board').hidden = state.done;
  if (!state.done) return;
  showGrade('rank-the-world', (score() / MAX) * 100, todayKey);
  const s = score();
  $('result-title').textContent = s >= 36 ? 'Master cartographer.' : s >= 28 ? 'Well travelled.' : s >= 18 ? 'Good trip.' : 'Rough seas.';
  const perfect = state.answers.filter((a) => a.points.every((p) => p === 2)).length;
  $('result-sub').textContent = `You scored ${s} out of ${MAX}${perfect ? `, with ${perfect} perfect ${perfect === 1 ? 'round' : 'rounds'}` : ''}.`;

  const st = readStats(STATS_KEY);
  const streak = st.lastDay >= today - 1 ? st.streak : 0;
  const rows: [string, string][] = [
    ['Played', String(st.played)],
    ['Average', st.played ? (st.total / st.played).toFixed(1) : '0'],
    ['Best', String(st.best)],
    ['Day streak', String(streak)],
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

  $('recap-list').replaceChildren(
    ...rounds.map((r, i) => {
      const sec = document.createElement('section');
      sec.className = 'recap-round';
      const h = document.createElement('h3');
      h.textContent = stats[r.stat].title;
      const ord = document.createElement('p');
      ord.className = 'order';
      ord.textContent = stats[r.stat].order;
      const ol = document.createElement('ol');
      correctOrder(i).forEach((c, idx) => {
        const li = document.createElement('li');
        const b = document.createElement('b');
        b.textContent = String(idx + 1);
        const img = document.createElement('img');
        img.src = flag(c);
        img.alt = '';
        const n = document.createElement('span');
        n.textContent = nameOf(c);
        const v = document.createElement('span');
        v.textContent = formatValue(i, c);
        li.append(b, img, n, v);
        ol.append(li);
      });
      const a = state.answers[i];
      const total = document.createElement('p');
      total.className = 'total';
      total.textContent = a ? `You scored ${a.points.reduce((x, y) => x + y, 0)} / 10` : '';
      sec.append(h, ord, ol, total);
      return sec;
    }),
  );
  startCountdown();
}

function shareString(): string {
  const lines = state.answers.map((a, i) => {
    const truth = correctOrder(i);
    const dots = a.order.map((c, idx) => ['⚪', '🟡', '🟢'][pointsFor(idx, truth.indexOf(c))]).join('');
    return `${STAT_SHORT[rounds[i].stat] ?? ''} ${dots}`;
  });
  const hints = hintsUsed() ? [`${hintsUsed()} ${hintsUsed() === 1 ? 'hint' : 'hints'} used`] : [];
  return [`Rank the World No. ${puzzleNo} · ${score()}/${MAX}`, ...lines, ...hints, `${location.origin}/games/rank-the-world`].join('\n');
}

let countdownTimer = 0;
function startCountdown() {
  const el = $('countdown');
  const tick = () => {
    const ms = msUntilTomorrow();
    // The day rollover itself is handled by watchDayChange; here we just stop at zero.
    const sec = Math.floor(ms / 1000);
    el.textContent = [Math.floor(sec / 3600), Math.floor((sec % 3600) / 60), sec % 60].map((n) => String(n).padStart(2, '0')).join(':');
  };
  clearInterval(countdownTimer);
  tick();
  countdownTimer = window.setInterval(tick, 1000);
}

function render() {
  if (!state.done) renderCard();
  else renderTrip();
  renderResult();
}

/* ---------- Events ---------- */
lockBtn.addEventListener('click', () => {
  haptic.tap();
  lockIn();
});
nextBtn.addEventListener('click', () => void next());
hintBtn.addEventListener('click', useHint);
$('share').addEventListener('click', async () => {
  haptic.tap();
  const res = await shareText(shareString());
  const msg = $('result-msg');
  msg.textContent = res === 'copied' ? 'Result copied. Paste it anywhere.' : res === 'failed' ? "Couldn't share from this browser." : '';
  setTimeout(() => (msg.textContent = ''), 2600);
});

/* ---------- Boot ---------- */
render();
void arrive(mini, $('mini-globe'));
watchDayChange(todayKey);
addTestReset('rank-the-world', STATE_KEY, todayKey);
