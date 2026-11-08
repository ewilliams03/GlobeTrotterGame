import '../../shared/base';
import '../../shared/game.css';
import './ff.css';
import { COUNTRIES } from '../../data/countries';
import { dayIndex, dayKey, msUntilTomorrow } from '../../shared/daily';
import { load, save } from '../../shared/storage';
import { shareText } from '../../shared/share';
import { haptic } from '../../shared/haptics';
import { reducedMotion } from '../../shared/geo';
import { arrive, miniGlobe } from '../../shared/travel';
import { showGrade } from '../../shared/grades';
import { addTestReset } from '../../shared/testing';
import { watchDayChange, recordDay, readStats, focusQuietly, scrollToTop, showFromTop } from '../../shared/session';
import { loadToday, showLoadError } from '../../shared/bank';

/* ---------- Model ---------- */
type Layout = 'plain' | 'h2' | 'h3' | 'v2' | 'v3' | 'nordic';
type Symbol = 'none' | 'star' | 'crescent' | 'sun' | 'disc' | 'emblem';
type Colour = 'red' | 'white' | 'blue' | 'lightblue' | 'green' | 'yellow' | 'black' | 'orange';
interface Spec {
  layout: Layout;
  colors: (Colour | null)[];
  symbol: Symbol;
  symbolColor?: Colour | null;
}
interface Flag {
  code: string;
  name: string;
  spec: Spec;
  sourceUrl: string;
}
interface Attempt {
  spec: Spec;
  score: number | null;
  hinted: boolean;
}
interface State {
  attempts: Attempt[];
  fp?: string; // which puzzle this progress belongs to
  cursor: number;
  done: boolean;
  counted: boolean;
}

const HEX: Record<Colour, string> = {
  red: '#d52b1e',
  white: '#ffffff',
  blue: '#0b3d91',
  lightblue: '#75aadb',
  green: '#138a36',
  yellow: '#fcd116',
  black: '#141414',
  orange: '#ff8200',
};
const COLOUR_NAME: Record<Colour, string> = { red: 'Red', white: 'White', blue: 'Dark blue', lightblue: 'Light blue', green: 'Green', yellow: 'Yellow', black: 'Black', orange: 'Orange' };
const COLOURS = Object.keys(HEX) as Colour[];
const LAYOUTS: { id: Layout; label: string; slots: number; slotNames: string[] }[] = [
  { id: 'v3', label: '3 vertical', slots: 3, slotNames: ['Left', 'Middle', 'Right'] },
  { id: 'h3', label: '3 horizontal', slots: 3, slotNames: ['Top', 'Middle', 'Bottom'] },
  { id: 'v2', label: '2 vertical', slots: 2, slotNames: ['Left', 'Right'] },
  { id: 'h2', label: '2 horizontal', slots: 2, slotNames: ['Top', 'Bottom'] },
  { id: 'nordic', label: 'Nordic cross', slots: 2, slotNames: ['Field', 'Cross'] },
  { id: 'plain', label: 'Plain', slots: 1, slotNames: ['Field'] },
];
const SYMBOLS: { id: Symbol; label: string; coloured: boolean }[] = [
  { id: 'none', label: 'None', coloured: false },
  { id: 'star', label: 'Star', coloured: true },
  { id: 'crescent', label: 'Crescent & star', coloured: true },
  { id: 'sun', label: 'Sun', coloured: true },
  { id: 'disc', label: 'Disc', coloured: true },
  { id: 'emblem', label: 'Coat of arms', coloured: false },
];
const layoutOf = (id: Layout) => LAYOUTS.find((l) => l.id === id)!;
const symbolOf = (id: Symbol) => SYMBOLS.find((s) => s.id === id)!;
const FREE_HINTS = 3;

const flagUrls = import.meta.glob('/node_modules/flag-icons/flags/4x3/*.svg', {
  eager: true,
  query: '?url',
  import: 'default',
}) as Record<string, string>;
const flagUrl = (code: string) => flagUrls[`/node_modules/flag-icons/flags/4x3/${code}.svg`] ?? '';

const today = dayIndex();
const todayKey = dayKey(); // fixed before any await, so a slow load can't straddle midnight
const puzzleNo = today + 1;
const { flags } = await loadToday<{ flags: Flag[] }>('flag-forge').catch((e) => {
  showLoadError(document.getElementById('board'));
  throw e;
});
const ROUNDS = flags.length;
const MAX = ROUNDS * 100;
const STATE_KEY = `flag-forge:day:${todayKey}`;
const FP = flags.map((f) => f.code).join();
const STATS_KEY = 'flag-forge:stats';

const blank = (): Spec => ({ layout: 'v3', colors: [null, null, null], symbol: 'none', symbolColor: null });
function sanitize(s: State | null): State {
  const fresh: State = { attempts: flags.map(() => ({ spec: blank(), score: null, hinted: false })), cursor: 0, done: false, counted: false, fp: FP };
  // Progress saved for a different puzzle (e.g. after the puzzle bank changes) is discarded.
  if (s && s.fp !== FP) return fresh;
  if (!s || !Array.isArray(s.attempts) || s.attempts.length !== ROUNDS) return fresh;
  const ok = s.attempts.every(
    (a) => a?.spec && LAYOUTS.some((l) => l.id === a.spec.layout) && Array.isArray(a.spec.colors) && a.spec.colors.every((c) => c === null || c in HEX) && SYMBOLS.some((x) => x.id === a.spec.symbol),
  );
  if (!ok) return fresh;
  s.cursor = Math.min(Math.max(0, s.cursor | 0), ROUNDS - 1);
  return s;
}
const state = sanitize(load<State | null>(STATE_KEY, null));
const persist = () => save(STATE_KEY, state);
const hintsUsed = () => state.attempts.filter((a) => a.hinted).length;
const score = () => state.attempts.reduce((n, a) => n + (a.score ?? 0), 0);
const scored = (a: Attempt) => a.score !== null;
let activeSlot = 0;

/* ---------- Elements ---------- */
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const NS = 'http://www.w3.org/2000/svg';
const preview = document.getElementById('preview') as unknown as SVGSVGElement;
const card = $('card');
const statusEl = $('status');
const hintBtn = $<HTMLButtonElement>('hint');
const mini = miniGlobe($('mini-globe'));
let busy = false;

$('puzzle-meta').textContent = `No. ${puzzleNo} · ${new Intl.DateTimeFormat(undefined, {
  weekday: 'short',
  day: 'numeric',
  month: 'short',
}).format(new Date())}`;

/* ---------- Drawing a flag from a spec ---------- */
const add = (parent: Element, tag: string, attrs: Record<string, string>) => {
  const n = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  parent.appendChild(n);
  return n;
};
const EMPTY = '#e9e4d8';

function starPoints(cx: number, cy: number, R: number): string {
  const pts: string[] = [];
  for (let i = 0; i < 10; i++) {
    const r = i % 2 ? R * 0.4 : R;
    const a = -Math.PI / 2 + (i * Math.PI) / 5;
    pts.push(`${(cx + r * Math.cos(a)).toFixed(1)},${(cy + r * Math.sin(a)).toFixed(1)}`);
  }
  return pts.join(' ');
}

function drawFlag(svg: SVGSVGElement, spec: Spec) {
  const W = 300;
  const H = 200;
  svg.replaceChildren();
  const fill = (i: number) => (spec.colors[i] ? HEX[spec.colors[i]!] : EMPTY);
  const L = spec.layout;
  if (L === 'plain') add(svg, 'rect', { width: String(W), height: String(H), fill: fill(0) });
  if (L === 'h2' || L === 'h3' || L === 'v2' || L === 'v3') {
    const n = L.endsWith('3') ? 3 : 2;
    for (let i = 0; i < n; i++) {
      const horizontal = L.startsWith('h');
      add(svg, 'rect', horizontal
        ? { x: '0', y: String((H / n) * i), width: String(W), height: String(H / n + 0.5), fill: fill(i) }
        : { x: String((W / n) * i), y: '0', width: String(W / n + 0.5), height: String(H), fill: fill(i) });
    }
  }
  if (L === 'nordic') {
    add(svg, 'rect', { width: String(W), height: String(H), fill: fill(0) });
    add(svg, 'rect', { x: '84', y: '0', width: '34', height: String(H), fill: fill(1) });
    add(svg, 'rect', { x: '0', y: '83', width: String(W), height: '34', fill: fill(1) });
  }
  // Empty slots get a faint dashed outline so it's clear something is missing.
  if (spec.colors.some((c) => !c)) add(svg, 'rect', { x: '1', y: '1', width: String(W - 2), height: String(H - 2), fill: 'none', stroke: '#b9b2a2', 'stroke-dasharray': '6 5', 'stroke-width': '2' });

  const cx = W / 2;
  const cy = H / 2;
  const sc = spec.symbolColor ? HEX[spec.symbolColor] : '#9a9384';
  switch (spec.symbol) {
    case 'star':
      add(svg, 'polygon', { points: starPoints(cx, cy, 42), fill: sc });
      break;
    case 'crescent': {
      add(svg, 'circle', { cx: String(cx - 12), cy: String(cy), r: '46', fill: sc });
      add(svg, 'circle', { cx: String(cx), cy: String(cy), r: '37', fill: fill(0) });
      add(svg, 'polygon', { points: starPoints(cx + 44, cy, 20), fill: sc, transform: `rotate(-18 ${cx + 44} ${cy})` });
      break;
    }
    case 'sun': {
      const g = add(svg, 'g', { fill: sc });
      for (let i = 0; i < 16; i++) {
        const a = (i * Math.PI) / 8;
        const r1 = 26;
        const r2 = i % 2 ? 38 : 44;
        add(g, 'polygon', {
          points: [
            [cx + r1 * Math.cos(a - 0.12), cy + r1 * Math.sin(a - 0.12)],
            [cx + r2 * Math.cos(a), cy + r2 * Math.sin(a)],
            [cx + r1 * Math.cos(a + 0.12), cy + r1 * Math.sin(a + 0.12)],
          ].map((p) => p.map((v) => v.toFixed(1)).join(',')).join(' '),
        });
      }
      add(g, 'circle', { cx: String(cx), cy: String(cy), r: '24' });
      break;
    }
    case 'disc':
      add(svg, 'circle', { cx: String(cx), cy: String(cy), r: '58', fill: sc });
      break;
    case 'emblem': {
      // A generic shield stands in for any national coat of arms or emblem.
      const g = add(svg, 'g', { transform: `translate(${cx - 26} ${cy - 32})` });
      add(g, 'path', { d: 'M26 0 52 8v22c0 18-12 30-26 34C12 60 0 48 0 30V8Z', fill: '#c99a2e', stroke: '#6e5212', 'stroke-width': '2.5' });
      add(g, 'path', { d: 'M26 12 40 17v13c0 10-6 17-14 20-8-3-14-10-14-20V17Z', fill: '#2f6b3a' });
      break;
    }
  }
}

/* ---------- Scoring ---------- */
interface Check {
  label: string;
  ok: boolean;
  detail: string;
}
function evaluate(target: Spec, guess: Spec): Check[] {
  const checks: Check[] = [];
  const tl = layoutOf(target.layout);
  checks.push({ label: 'Layout', ok: guess.layout === target.layout, detail: tl.label });
  tl.slotNames.forEach((slot, i) => {
    const want = target.colors[i] as Colour;
    checks.push({ label: `${slot} colour`, ok: guess.layout === target.layout && guess.colors[i] === want, detail: COLOUR_NAME[want] });
  });
  checks.push({ label: 'Symbol', ok: guess.symbol === target.symbol, detail: symbolOf(target.symbol).label });
  if (symbolOf(target.symbol).coloured && target.symbolColor) {
    checks.push({ label: 'Symbol colour', ok: guess.symbol === target.symbol && guess.symbolColor === target.symbolColor, detail: COLOUR_NAME[target.symbolColor] });
  }
  return checks;
}
const scoreOf = (checks: Check[]) => Math.round((checks.filter((c) => c.ok).length / checks.length) * 100);

/* ---------- Rendering ---------- */
function chip(key: string, label: string, pressed: boolean, onClick: () => void, art?: SVGSVGElement): HTMLButtonElement {
  const b = document.createElement('button');
  b.dataset.key = key;
  b.type = 'button';
  b.className = 'chip-btn';
  b.setAttribute('aria-pressed', String(pressed));
  if (art) b.append(art);
  b.append(document.createTextNode(label));
  b.addEventListener('click', () => {
    haptic.select();
    onClick();
  });
  return b;
}

function layoutIcon(id: Layout): SVGSVGElement {
  const s = document.createElementNS(NS, 'svg') as SVGSVGElement;
  s.setAttribute('width', '27');
  s.setAttribute('height', '18');
  s.setAttribute('viewBox', '0 0 300 200');
  s.setAttribute('aria-hidden', 'true');
  const shades: Colour[] = id === 'nordic' ? ['lightblue', 'white'] : ['lightblue', 'white', 'blue'];
  drawFlag(s, { layout: id, colors: shades.slice(0, layoutOf(id).slots), symbol: 'none' });
  return s;
}

function swatch(key: string, colour: Colour, pressed: boolean, onClick: () => void): HTMLButtonElement {
  const b = document.createElement('button');
  b.dataset.key = key;
  b.type = 'button';
  b.className = 'swatch';
  b.dataset.color = colour;
  b.setAttribute('aria-pressed', String(pressed));
  b.setAttribute('aria-label', COLOUR_NAME[colour]);
  b.title = COLOUR_NAME[colour];
  b.addEventListener('click', () => {
    haptic.select();
    onClick();
  });
  return b;
}

function renderTools() {
  // The controls are rebuilt on every change; remember which one had focus and restore it after.
  const focusKey = (document.activeElement as HTMLElement | null)?.dataset?.key;
  const a = state.attempts[state.cursor];
  const spec = a.spec;
  const lay = layoutOf(spec.layout);
  activeSlot = Math.min(activeSlot, lay.slots - 1);

  $('layouts').replaceChildren(
    ...LAYOUTS.map((l) => {
      const b = chip(`layout-${l.id}`, l.label, spec.layout === l.id, () => {
        if (a.hinted) return;
        spec.layout = l.id;
        spec.colors = Array.from({ length: l.slots }, (_, i) => spec.colors[i] ?? null);
        activeSlot = spec.colors.findIndex((c) => !c);
        if (activeSlot < 0) activeSlot = 0;
        update();
      }, layoutIcon(l.id));
      b.disabled = a.hinted && spec.layout !== l.id;
      return b;
    }),
  );

  $('slot-note').textContent = `pick a slot, then a colour`;
  $('slots').replaceChildren(
    ...lay.slotNames.map((name, i) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'slot';
      b.dataset.key = `slot-${i}`;
      b.setAttribute('aria-pressed', String(i === activeSlot));
      const dot = document.createElement('i');
      const c = spec.colors[i];
      if (c) dot.style.background = HEX[c];
      b.append(dot, document.createTextNode(name));
      b.setAttribute('aria-label', `${name} colour: ${c ? COLOUR_NAME[c] : 'not set'}`);
      b.addEventListener('click', () => {
        haptic.select();
        activeSlot = i;
        renderTools();
      });
      return b;
    }),
  );
  $('swatches').replaceChildren(
    ...COLOURS.map((c) =>
      swatch(`colour-${c}`, c, spec.colors[activeSlot] === c, () => {
        spec.colors[activeSlot] = c;
        // Move on to the next empty slot automatically.
        const nextEmpty = spec.colors.findIndex((x, i) => !x && i > activeSlot);
        if (nextEmpty >= 0) activeSlot = nextEmpty;
        update();
      }),
    ),
  );

  $('symbols').replaceChildren(
    ...SYMBOLS.map((s) =>
      chip(`symbol-${s.id}`, s.label, spec.symbol === s.id, () => {
        spec.symbol = s.id;
        if (!s.coloured) spec.symbolColor = null;
        update();
      }),
    ),
  );
  const sym = symbolOf(spec.symbol);
  $('symbol-colors').replaceChildren(
    ...(sym.coloured
      ? COLOURS.map((c) =>
          swatch(`symcolour-${c}`, c, spec.symbolColor === c, () => {
            spec.symbolColor = c;
            update();
          }),
        )
      : []),
  );
  if (focusKey) $('tools').querySelector<HTMLElement>(`[data-key="${focusKey}"]`)?.focus({ preventScroll: true });
}

function update() {
  persist();
  drawFlag(preview, state.attempts[state.cursor].spec);
  preview.classList.remove('is-pulse');
  void (preview as unknown as HTMLElement).getBoundingClientRect();
  if (!reducedMotion()) preview.classList.add('is-pulse');
  renderTools();
  const missing = state.attempts[state.cursor].spec.colors.filter((c) => !c).length;
  statusEl.textContent = missing ? `${missing} colour ${missing === 1 ? 'slot' : 'slots'} still empty.` : 'Looks ready. Forge it when you are happy.';
}

function renderTrip() {
  $('trip').replaceChildren(
    ...flags.map((f, i) => {
      const a = state.attempts[i];
      const li = document.createElement('li');
      if (scored(a)) {
        li.className = 'is-done';
        li.dataset.level = a.score! >= 80 ? '1' : a.score! >= 50 ? '3' : '4';
      }
      if (i === state.cursor && !state.done) li.classList.add('is-current');
      const stop = document.createElement('span');
      stop.className = 'stop';
      if (scored(a)) {
        const img = document.createElement('img');
        img.src = flagUrl(f.code);
        img.alt = '';
        stop.append(img);
      } else stop.textContent = String(i + 1);
      const label = document.createElement('span');
      label.className = 'visually-hidden';
      label.textContent = `Flag ${i + 1}: ${f.name}${scored(a) ? `, ${a.score} points` : i === state.cursor ? ', current' : ''}`;
      li.append(stop, label);
      return li;
    }),
  );
}

function renderHint() {
  const left = FREE_HINTS - hintsUsed();
  $('hint-count').textContent = String(left);
  hintBtn.setAttribute('aria-label', `Use a hint. ${left} of ${FREE_HINTS} left.`);
  const a = state.attempts[state.cursor];
  hintBtn.disabled = busy || state.done || scored(a) || a.hinted || left <= 0;
}

function renderCard() {
  const i = state.cursor;
  const f = flags[i];
  const a = state.attempts[i];
  $('card-step').textContent = `Flag ${i + 1} of ${ROUNDS}`;
  $('card-title').textContent = f.name;
  $('score').textContent = String(score());
  drawFlag(preview, a.spec);
  const done = scored(a);
  $('tools').hidden = done;
  $('forge-actions').hidden = done;
  $('real').hidden = !done;
  $('after').hidden = !done;
  $('checklist').hidden = !done;
  $('preview-label').textContent = done ? 'Your flag' : 'Your flag (live preview)';
  if (done) renderAfter();
  else {
    renderTools();
    if (!statusEl.textContent) statusEl.textContent = `How does ${f.name}'s flag look? Build it below.`;
  }
  renderHint();
  renderTrip();
  syncMini();
}

function renderAfter() {
  const i = state.cursor;
  const f = flags[i];
  const a = state.attempts[i];
  $<HTMLImageElement>('real-img').src = flagUrl(f.code);
  $<HTMLImageElement>('real-img').alt = `The flag of ${f.name}`;
  const checks = evaluate(f.spec, a.spec);
  $('checklist').replaceChildren(
    ...checks.map((c) => {
      const li = document.createElement('li');
      li.dataset.level = c.ok ? '1' : '4';
      const b = document.createElement('b');
      b.textContent = c.ok ? '✓' : '×';
      b.setAttribute('aria-hidden', 'true');
      const small = document.createElement('small');
      small.textContent = c.detail;
      li.append(b, document.createTextNode(c.label), small);
      li.setAttribute('aria-label', `${c.label}: ${c.ok ? 'correct' : 'wrong'}. Answer: ${c.detail}.`);
      return li;
    }),
  );
  const src = document.createElement('a');
  src.href = f.sourceUrl;
  src.target = '_blank';
  src.rel = 'noopener noreferrer';
  src.textContent = `About the flag of ${f.name}`;
  statusEl.replaceChildren(src);
  const v = $('verdict');
  const pts = document.createElement('span');
  pts.className = 'pts';
  pts.dataset.level = a.score! >= 80 ? '1' : a.score! >= 50 ? '3' : '4';
  pts.textContent = `+${a.score}`;
  const s = a.score!;
  v.replaceChildren(document.createTextNode(s === 100 ? 'Flawless forging.' : s >= 75 ? 'Nearly there.' : s >= 50 ? 'Half right.' : 'Back to the forge.'), pts);
  $('next').textContent = i === ROUNDS - 1 ? 'See your results' : 'Next flag';
}

function syncMini() {
  const dots = flags.flatMap((f, i) => {
    const a = state.attempts[i];
    const c = COUNTRIES[f.code];
    if (!c || (!scored(a) && i !== state.cursor)) return [];
    return [{ lon: c.lon, lat: c.lat, level: scored(a) ? (a.score! >= 80 ? 1 : a.score! >= 50 ? 3 : 4) : 5 }];
  });
  mini.setDots(dots);
  const c = COUNTRIES[flags[state.cursor].code];
  if (c && !state.done) mini.focus([c]);
}

/* ---------- Actions ---------- */
function forge() {
  const i = state.cursor;
  const a = state.attempts[i];
  if (busy || scored(a)) return;
  if (a.spec.colors.some((c) => !c)) {
    statusEl.textContent = 'Fill every colour slot first.';
    haptic.error();
    return;
  }
  if (symbolOf(a.spec.symbol).coloured && !a.spec.symbolColor) {
    statusEl.textContent = 'Pick a colour for the symbol first.';
    haptic.error();
    return;
  }
  a.score = scoreOf(evaluate(flags[i].spec, a.spec));
  persist();
  if (a.score >= 75) haptic.success();
  else haptic.error();
  renderCard();
  const el = $('score');
  el.classList.remove('is-bump');
  void el.offsetWidth;
  el.classList.add('is-bump');
  $('next').focus({ preventScroll: true });
  showFromTop(card);
}

function reset() {
  const a = state.attempts[state.cursor];
  if (busy || scored(a)) return;
  haptic.tap();
  const keepLayout = a.hinted ? flags[state.cursor].spec.layout : 'v3';
  a.spec = { layout: keepLayout, colors: Array.from({ length: layoutOf(keepLayout).slots }, () => null), symbol: 'none', symbolColor: null };
  activeSlot = 0;
  update();
}

function useHint() {
  const i = state.cursor;
  const a = state.attempts[i];
  if (busy || state.done || scored(a) || a.hinted || hintsUsed() >= FREE_HINTS) return;
  haptic.tap();
  a.hinted = true;
  const target = flags[i].spec.layout;
  if (a.spec.layout !== target) {
    a.spec.layout = target;
    a.spec.colors = Array.from({ length: layoutOf(target).slots }, (_, k) => a.spec.colors[k] ?? null);
  }
  activeSlot = 0;
  update();
  renderHint();
  statusEl.textContent = `Hint: the layout is "${layoutOf(target).label}". It's locked in for you.`;
}

async function next() {
  if (busy) return;
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
  activeSlot = 0;
  persist();
  busy = false;
  statusEl.textContent = '';
  renderCard();
  focusQuietly(card.querySelector('h2'));
  if (!reducedMotion()) {
    card.classList.add('is-entering');
    setTimeout(() => card.classList.remove('is-entering'), 360);
  }
  showFromTop(card);
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
  showGrade('flag-forge', (score() / MAX) * 100, todayKey);
  const s = score();
  $('result-title').textContent = s >= 270 ? 'Master vexillologist.' : s >= 200 ? 'Sharp eye.' : s >= 120 ? 'Good trip.' : 'Rough seas.';
  const perfect = state.attempts.filter((a) => a.score === 100).length;
  $('result-sub').textContent = `You scored ${s} out of ${MAX}${perfect ? `, with ${perfect} flawless ${perfect === 1 ? 'flag' : 'flags'}` : ''}.`;
  const st = readStats(STATS_KEY);
  const streak = st.lastDay >= today - 1 ? st.streak : 0;
  const rows: [string, string][] = [
    ['Played', String(st.played)],
    ['Average', st.played ? String(Math.round(st.total / st.played)) : '0'],
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
    ...flags.map((f, i) => {
      const a = state.attempts[i];
      const sec = document.createElement('section');
      sec.className = 'recap-flag';
      const pair = document.createElement('div');
      pair.className = 'pair';
      const mine = document.createElementNS(NS, 'svg') as SVGSVGElement;
      mine.setAttribute('viewBox', '0 0 300 200');
      mine.setAttribute('aria-hidden', 'true');
      drawFlag(mine, a.spec);
      const real = document.createElement('img');
      real.src = flagUrl(f.code);
      real.alt = `The flag of ${f.name}`;
      pair.append(mine, real);
      const body = document.createElement('div');
      const h = document.createElement('h3');
      h.textContent = f.name;
      const strong = document.createElement('strong');
      strong.textContent = `+${a.score ?? 0}`;
      body.append(h, strong);
      sec.append(pair, body);
      return sec;
    }),
  );
  startCountdown();
}

function shareString(): string {
  const parts = flags.map((f, i) => `${f.name} ${state.attempts[i].score ?? 0}`).join(' · ');
  const hints = hintsUsed() ? [`${hintsUsed()} ${hintsUsed() === 1 ? 'hint' : 'hints'} used`] : [];
  return [`Flag Forge No. ${puzzleNo} · ${score()}/${MAX}`, parts, ...hints, `${location.origin}/games/flag-forge`].join('\n');
}

let countdownTimer = 0;
function startCountdown() {
  const out = $('countdown');
  const tick = () => {
    const ms = msUntilTomorrow();
    // The day rollover itself is handled by watchDayChange; here we just stop at zero.
    const sec = Math.floor(ms / 1000);
    out.textContent = [Math.floor(sec / 3600), Math.floor((sec % 3600) / 60), sec % 60].map((n) => String(n).padStart(2, '0')).join(':');
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
$('submit').addEventListener('click', () => {
  haptic.tap();
  forge();
});
$('reset').addEventListener('click', reset);
hintBtn.addEventListener('click', useHint);
$('next').addEventListener('click', () => void next());
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
addTestReset('flag-forge', STATE_KEY, todayKey);
