import '../../shared/base';
import '../../shared/game.css';
import './os.css';
import { geoMercator, geoPath, type GeoProjection } from 'd3-geo';
import type { MultiPolygon } from 'geojson';
import { COUNTRIES } from '../../data/countries';
import { dayIndex, dayKey, msUntilTomorrow } from '../../shared/daily';
import { load, save } from '../../shared/storage';
import { shareText } from '../../shared/share';
import { haptic } from '../../shared/haptics';
import { reducedMotion } from '../../shared/geo';
import { arrive, miniGlobe } from '../../shared/travel';
import { loadToday, showLoadError } from '../../shared/bank';
import { showGrade } from '../../shared/grades';
import { addTestReset } from '../../shared/testing';
import { watchDayChange, recordDay, readStats, focusQuietly, scrollToTop, showFromTop } from '../../shared/session';

/* ---------- Types & data ---------- */
interface Sketch {
  code: string;
  name: string;
  target: MultiPolygon;
}
type Pt = [number, number];
interface Attempt {
  loops: Pt[][]; // each closed loop the player drew (islands and separate parts are separate loops)
  score: number | null;
  overlap: number | null;
  hinted: boolean;
}
interface State {
  attempts: Attempt[];
  cursor: number;
  done: boolean;
  counted: boolean;
  fp?: string;
}

const W = 600;
const H = 440;
const FREE_HINTS = 3;
const NS = 'http://www.w3.org/2000/svg';

const flagUrls = import.meta.glob('/node_modules/flag-icons/flags/4x3/*.svg', {
  eager: true,
  query: '?url',
  import: 'default',
}) as Record<string, string>;
const flag = (code: string) => flagUrls[`/node_modules/flag-icons/flags/4x3/${code}.svg`] ?? '';

const today = dayIndex();
const todayKey = dayKey(); // fixed before any await, so a slow load can't straddle midnight
const puzzleNo = today + 1;
const { countries: sketches } = await loadToday<{ countries: Sketch[] }>('outline-sketch').catch((e) => {
  showLoadError(document.getElementById('board'));
  throw e;
});
const ROUNDS = sketches.length;
const MAX = ROUNDS * 100;
const STATE_KEY = `outline-sketch:day:${todayKey}`;
// v2: whiteboard mode. Progress saved by the old map version is discarded via the fingerprint.
const FP = `wb:${sketches.map((s) => s.code).join()}`;
const STATS_KEY = 'outline-sketch:stats';

const blankAttempt = (): Attempt => ({ loops: [], score: null, overlap: null, hinted: false });
function sanitize(s: State | null): State {
  const fresh: State = { attempts: sketches.map(blankAttempt), cursor: 0, done: false, counted: false, fp: FP };
  if (s && s.fp !== FP) return fresh;
  if (!s || !Array.isArray(s.attempts) || s.attempts.length !== ROUNDS) return fresh;
  const isPt = (p: unknown) => Array.isArray(p) && p.length === 2 && p.every((n) => Number.isFinite(n));
  const ok = s.attempts.every((a) => a && Array.isArray(a.loops) && a.loops.every((l) => Array.isArray(l) && l.every(isPt)));
  if (!ok) return fresh;
  s.cursor = Math.min(Math.max(0, s.cursor | 0), ROUNDS - 1);
  return s;
}
const state = sanitize(load<State | null>(STATE_KEY, null));
const persist = () => save(STATE_KEY, state);
const hintsUsed = () => state.attempts.filter((a) => a.hinted).length;
const score = () => state.attempts.reduce((n, a) => n + (a.score ?? 0), 0);
const scored = (a: Attempt) => a.score !== null;

/* ---------- Elements ---------- */
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const svg = document.getElementById('sketch') as unknown as SVGSVGElement;
const card = $('card');
const statusEl = $('status');
const tip = $('tip');
const undoBtn = $<HTMLButtonElement>('undo');
const clearBtn = $<HTMLButtonElement>('clear');
const submitBtn = $<HTMLButtonElement>('submit');
const hintBtn = $<HTMLButtonElement>('hint');
const mini = miniGlobe($('mini-globe'));
let busy = false;

$('puzzle-meta').textContent = `No. ${puzzleNo} · ${new Intl.DateTimeFormat(undefined, {
  weekday: 'short',
  day: 'numeric',
  month: 'short',
}).format(new Date())}`;

/* ---------- Geometry helpers ---------- */
type Box = { x0: number; y0: number; x1: number; y1: number };
const el = <K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string>, parent?: Element) => {
  const n = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  parent?.appendChild(n);
  return n;
};
const loopPath = (pts: Pt[], closed = true) => pts.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join('') + (closed ? 'Z' : '');
const polygonArea = (pts: Pt[]) => Math.abs(pts.reduce((a, p, i) => { const q = pts[(i + 1) % pts.length]; return a + p[0] * q[1] - q[0] * p[1]; }, 0) / 2);

/** The real shape projected (Mercator, as on most maps) to fit inside a box with padding. */
function targetProjection(s: Sketch, w: number, h: number, pad: number): GeoProjection {
  return geoMercator().fitExtent([[pad, pad], [w - pad, h - pad]], s.target);
}
function targetBox(s: Sketch, w: number, h: number, pad: number): Box {
  const [[x0, y0], [x1, y1]] = geoPath(targetProjection(s, w, h, pad)).bounds(s.target);
  return { x0, y0, x1, y1 };
}
function loopsBox(loops: Pt[][]): Box {
  const xs = loops.flat().map((p) => p[0]);
  const ys = loops.flat().map((p) => p[1]);
  return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
}
/** Scale + move the drawing so its bounding box sits centred on `to`, keeping its own proportions. */
function alignLoops(loops: Pt[][], to: Box): Pt[][] {
  const from = loopsBox(loops);
  const fw = Math.max(1, from.x1 - from.x0);
  const fh = Math.max(1, from.y1 - from.y0);
  const k = Math.min((to.x1 - to.x0) / fw, (to.y1 - to.y0) / fh);
  const cx = (from.x0 + from.x1) / 2;
  const cy = (from.y0 + from.y1) / 2;
  const tx = (to.x0 + to.x1) / 2;
  const ty = (to.y0 + to.y1) / 2;
  return loops.map((l) => l.map(([x, y]) => [tx + (x - cx) * k, ty + (y - cy) * k] as Pt));
}

/* ---------- Scoring: compare shapes only (size and position don't matter) ---------- */
const GRID = 64; // a coarse grid forgives wobbly lines
function rasterise(draw: (ctx: CanvasRenderingContext2D) => void): Uint8Array {
  const c = document.createElement('canvas');
  c.width = GRID;
  c.height = GRID;
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  ctx.fillStyle = '#fff';
  draw(ctx);
  const px = ctx.getImageData(0, 0, GRID, GRID).data;
  const out = new Uint8Array(GRID * GRID);
  for (let i = 0; i < out.length; i++) out[i] = px[i * 4 + 3] > 100 ? 1 : 0;
  return out;
}
const iou = (a: Uint8Array, b: Uint8Array) => {
  let both = 0;
  let any = 0;
  for (let i = 0; i < a.length; i++) {
    both += a[i] & b[i];
    any += a[i] | b[i];
  }
  return any ? both / any : 0;
};

/** Grow every filled cell by one in each direction, so a thin country (Chile, Norway) isn't lost to a 1px wobble. */
function dilate(a: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length);
  for (let y = 0; y < GRID; y++)
    for (let x = 0; x < GRID; x++) {
      if (!a[y * GRID + x]) continue;
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const yy = y + dy;
          const xx = x + dx;
          if (yy >= 0 && yy < GRID && xx >= 0 && xx < GRID) out[yy * GRID + xx] = 1;
        }
    }
  return out;
}

/**
 * Framings to compare against. Players usually draw the mainland and skip far-off islands
 * (Portugal without Madeira, Ecuador without Galápagos), so we also try fitting just the
 * largest part, and the parts that make up most of the land, and keep the best score.
 */
function framings(s: Sketch): MultiPolygon[] {
  const parts = s.target.coordinates
    .map((poly) => ({ poly, area: geoPath().area({ type: 'Polygon', coordinates: poly }) }))
    .sort((a, b) => b.area - a.area);
  const out: MultiPolygon[] = [s.target];
  if (parts.length > 1) {
    out.push({ type: 'MultiPolygon', coordinates: [parts[0].poly] });
    const total = parts.reduce((n, p) => n + p.area, 0);
    let acc = 0;
    const most: typeof parts = [];
    for (const p of parts) {
      if (acc >= total * 0.95) break;
      most.push(p);
      acc += p.area;
    }
    if (most.length > 1 && most.length < parts.length) out.push({ type: 'MultiPolygon', coordinates: most.map((p) => p.poly) });
  }
  return out;
}

function measureIn(s: Sketch, frame: MultiPolygon, loops: Pt[][]): { overlap: number; points: number; frame: MultiPolygon } {
  const pad = 4;
  const proj = geoMercator().fitExtent([[pad, pad], [GRID - pad, GRID - pad]], frame);
  const [[x0, y0], [x1, y1]] = geoPath(proj).bounds(frame);
  const box = { x0, y0, x1, y1 };
  // The whole country is drawn in this framing; parts outside it simply fall off the grid.
  const target = dilate(rasterise((ctx) => {
    ctx.beginPath();
    geoPath(proj, ctx)(s.target);
    ctx.fill('evenodd');
  }));
  const aligned = alignLoops(loops, box);
  const drawn = dilate(rasterise((ctx) => {
    // Each loop is filled on its own, so separate loops add together (a union).
    for (const l of aligned) {
      ctx.beginPath();
      l.forEach((p, i) => (i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1])));
      ctx.closePath();
      ctx.fill();
    }
  }));
  // Baseline: a plain oval filling the shape's box, i.e. the score of not really trying.
  const oval = dilate(rasterise((ctx) => {
    ctx.beginPath();
    ctx.ellipse((x0 + x1) / 2, (y0 + y1) / 2, Math.max(0.5, (x1 - x0) / 2), Math.max(0.5, (y1 - y0) / 2), 0, 0, Math.PI * 2);
    ctx.fill();
  }));
  const overlap = iou(target, drawn);
  const base = iou(target, oval) * 0.75;
  // Generous curve: beating the oval clearly is worth a lot; a recognisable shape reaches the top grades.
  const p = Math.max(0, Math.min(1, (overlap - base) / ((1 - base) * 0.5)));
  return { overlap, points: Math.round(p * 100), frame };
}

function measure(s: Sketch, loops: Pt[][]): { overlap: number; points: number; frame: MultiPolygon } {
  return framings(s)
    .map((f) => measureIn(s, f, loops))
    .reduce((best, r) => (r.points > best.points || (r.points === best.points && r.overlap > best.overlap) ? r : best));
}

/* ---------- Rendering ---------- */
function drawBoard(target: SVGSVGElement, s: Sketch, a: Attempt, opts: { reveal: boolean; animate?: boolean; w?: number; h?: number }) {
  const w = opts.w ?? W;
  const h = opts.h ?? H;
  target.setAttribute('viewBox', `0 0 ${w} ${h}`);
  target.replaceChildren();
  if (opts.reveal) {
    const pad = Math.round(w * 0.06);
    const proj = targetProjection(s, w, h, pad);
    el('path', { class: 'os-target' + (opts.animate ? ' is-revealing' : ''), d: geoPath(proj)(s.target) ?? '' }, target);
    if (a.loops.length) {
      // Lay the sketch over the part of the country it matched best (e.g. the mainland only).
      const [[x0, y0], [x1, y1]] = geoPath(proj).bounds(measure(s, a.loops).frame);
      for (const l of alignLoops(a.loops, { x0, y0, x1, y1 })) el('path', { class: 'os-stroke is-compare', d: loopPath(l) }, target);
    }
    return;
  }
  if (a.hinted) {
    // Proportions guide: the country's bounding box, centred on the board.
    const b = targetBox(s, w, h, 70);
    el('rect', { class: 'os-guide', x: b.x0.toFixed(1), y: b.y0.toFixed(1), width: (b.x1 - b.x0).toFixed(1), height: (b.y1 - b.y0).toFixed(1), rx: '6' }, target);
    const t = el('text', { class: 'os-guide-label', x: (b.x0 + 6).toFixed(1), y: (b.y0 - 8).toFixed(1) }, target);
    t.textContent = 'Proportions';
  }
  for (const l of a.loops) el('path', { class: 'os-stroke', d: loopPath(l) }, target);
}

function renderTrip() {
  $('trip').replaceChildren(
    ...sketches.map((s, i) => {
      const a = state.attempts[i];
      const li = document.createElement('li');
      if (scored(a)) {
        li.className = 'is-done';
        li.dataset.level = a.score! >= 70 ? '1' : a.score! >= 40 ? '3' : '4';
      }
      if (i === state.cursor && !state.done) li.classList.add('is-current');
      const stop = document.createElement('span');
      stop.className = 'stop';
      const img = document.createElement('img');
      img.src = flag(s.code);
      img.alt = '';
      stop.append(img);
      const label = document.createElement('span');
      label.className = 'visually-hidden';
      label.textContent = `Sketch ${i + 1}: ${s.name}${scored(a) ? `, ${a.score} points` : i === state.cursor ? ', current' : ''}`;
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

function syncButtons() {
  const a = state.attempts[state.cursor];
  const has = a.loops.length > 0;
  undoBtn.disabled = !has || busy;
  clearBtn.disabled = !has || busy;
  submitBtn.disabled = !has || busy;
  tip.classList.toggle('is-hidden', has || scored(a));
  $('loops').textContent = has && !scored(a) ? `${a.loops.length} ${a.loops.length === 1 ? 'loop' : 'loops'}` : '';
}

function renderCard(animateReveal = false) {
  const i = state.cursor;
  const s = sketches[i];
  const a = state.attempts[i];
  $('card-step').textContent = `Sketch ${i + 1} of ${ROUNDS}`;
  $('card-title').textContent = `Draw ${s.name}`;
  $<HTMLImageElement>('card-flag').src = flag(s.code);
  $('score').textContent = String(score());
  drawBoard(svg, s, a, { reveal: scored(a), animate: animateReveal });
  $('draw-actions').hidden = scored(a);
  $('after').hidden = !scored(a);
  syncButtons();
  if (scored(a)) renderAfter();
  else if (!statusEl.textContent) statusEl.textContent = `Draw ${s.name}'s outline as a closed loop. Add more loops for islands or separate parts.`;
  renderHint();
  renderTrip();
  syncMini();
}

function renderAfter() {
  const i = state.cursor;
  const a = state.attempts[i];
  statusEl.textContent = a.loops.length
    ? `The real shape of ${sketches[i].name} is in green, with your sketch (dashed) scaled to match. Shapes overlap by ${Math.round((a.overlap ?? 0) * 100)}%.`
    : `Skipped. This is the real shape of ${sketches[i].name}.`;
  const v = $('verdict');
  const pts = document.createElement('span');
  pts.className = 'pts';
  pts.dataset.level = a.score! >= 70 ? '1' : a.score! >= 40 ? '3' : '4';
  pts.textContent = `+${a.score}`;
  const sc = a.score!;
  v.replaceChildren(document.createTextNode(sc >= 90 ? 'Cartographer grade.' : sc >= 70 ? 'Very close.' : sc >= 45 ? 'Recognisable.' : sc >= 20 ? 'Getting there.' : a.loops.length ? 'Abstract art.' : 'Skipped.'), pts);
  $('next').textContent = i === ROUNDS - 1 ? 'See your results' : 'Next sketch';
}

function syncMini() {
  const dots = sketches.flatMap((s, i) => {
    const a = state.attempts[i];
    const c = COUNTRIES[s.code];
    if (!c || (!scored(a) && i !== state.cursor)) return [];
    return [{ lon: c.lon, lat: c.lat, level: scored(a) ? (a.score! >= 70 ? 1 : a.score! >= 40 ? 3 : 4) : 5 }];
  });
  mini.setDots(dots);
  const c = COUNTRIES[sketches[state.cursor].code];
  if (c && !state.done) mini.focus([c]);
}

/* ---------- Drawing (pointer events: mouse, touch and pen) ---------- */
let live: { id: number; pts: Pt[]; path: SVGPathElement } | null = null;

function toSvg(e: PointerEvent): Pt {
  // The screen matrix accounts for letterboxing when the board is height-capped on short screens.
  const m = svg.getScreenCTM();
  if (m) {
    const p = new DOMPoint(e.clientX, e.clientY).matrixTransform(m.inverse());
    return [p.x, p.y];
  }
  const r = svg.getBoundingClientRect();
  return [((e.clientX - r.left) / r.width) * W, ((e.clientY - r.top) / r.height) * H];
}

svg.addEventListener('pointerdown', (e) => {
  const a = state.attempts[state.cursor];
  if (live || busy || state.done || scored(a) || e.button !== 0) return;
  e.preventDefault();
  try {
    svg.setPointerCapture(e.pointerId);
  } catch {
    /* capture is a nicety; drawing works without it */
  }
  const path = el('path', { class: 'os-stroke is-live', d: '' }, svg) as SVGPathElement;
  live = { id: e.pointerId, pts: [toSvg(e)], path };
  tip.classList.add('is-hidden');
  haptic.select();
});

window.addEventListener('pointermove', (e) => {
  if (!live || e.pointerId !== live.id) return;
  const p = toSvg(e);
  const last = live.pts[live.pts.length - 1];
  if (Math.hypot(p[0] - last[0], p[1] - last[1]) < 2.5) return;
  live.pts.push(p);
  live.path.setAttribute('d', loopPath(live.pts, false));
});

function endStroke(e: PointerEvent) {
  if (!live || e.pointerId !== live.id) return;
  const { pts, path } = live;
  live = null;
  const a = state.attempts[state.cursor];
  if (e.type === 'pointercancel' || state.done || scored(a)) {
    // The system took the touch (a scroll or call) or the round ended mid-stroke: drop it quietly.
    path.remove();
    return;
  }
  const b = loopsBox([pts]);
  // Bounding-box size, not signed area, so a figure-eight loop isn't mistaken for a tap.
  if (pts.length < 6 || Math.hypot(b.x1 - b.x0, b.y1 - b.y0) < 18 || (polygonArea(pts) < 40 && Math.min(b.x1 - b.x0, b.y1 - b.y0) < 6)) {
    // Too small to be a loop (a stray tap): ignore it, keep everything drawn so far.
    path.remove();
    statusEl.textContent = 'That was too small to count. Draw a closed loop.';
    syncButtons();
    return;
  }
  // Each valid loop is added; nothing is replaced.
  a.loops.push(pts.map(([x, y]) => [Math.round(x), Math.round(y)] as Pt));
  path.setAttribute('d', loopPath(a.loops[a.loops.length - 1]));
  path.setAttribute('class', 'os-stroke');
  persist();
  statusEl.textContent = a.loops.length === 1 ? 'Nice. Add more loops for islands or separate parts, or check your sketch.' : `${a.loops.length} loops drawn. Check your sketch when you're ready.`;
  syncButtons();
}
window.addEventListener('pointerup', endStroke);
window.addEventListener('pointercancel', endStroke);

/* ---------- Actions ---------- */
function undo() {
  const a = state.attempts[state.cursor];
  if (busy || scored(a) || !a.loops.length) return;
  haptic.tap();
  a.loops.pop();
  persist();
  statusEl.textContent = a.loops.length ? 'Last loop removed.' : 'Board cleared. Draw the outline.';
  renderCard();
}

function clearAll() {
  const a = state.attempts[state.cursor];
  if (busy || scored(a)) return;
  haptic.tap();
  a.loops = [];
  persist();
  statusEl.textContent = 'Board cleared. Draw the outline.';
  renderCard();
}

function check() {
  const i = state.cursor;
  const a = state.attempts[i];
  if (busy || !a.loops.length || scored(a)) return;
  const m = measure(sketches[i], a.loops);
  a.overlap = m.overlap;
  a.score = m.points;
  persist();
  if (a.score >= 60) haptic.success();
  else haptic.error();
  renderCard(true);
  const scoreEl = $('score');
  scoreEl.classList.remove('is-bump');
  void scoreEl.offsetWidth;
  scoreEl.classList.add('is-bump');
  $('next').focus({ preventScroll: true });
  showFromTop(card);
}

function skip() {
  const i = state.cursor;
  const a = state.attempts[i];
  if (busy || scored(a)) return;
  haptic.tap();
  a.loops = [];
  a.overlap = 0;
  a.score = 0;
  persist();
  renderCard(true);
  $('next').focus({ preventScroll: true });
  showFromTop(card);
}

function useHint() {
  const a = state.attempts[state.cursor];
  if (busy || state.done || scored(a) || a.hinted || hintsUsed() >= FREE_HINTS) return;
  haptic.tap();
  a.hinted = true;
  persist();
  statusEl.textContent = "The dashed box shows the country's proportions. Draw inside it.";
  renderCard();
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
  showGrade('outline-sketch', (score() / MAX) * 100, todayKey);
  const s = score();
  $('result-title').textContent = s >= 240 ? 'Master mapmaker.' : s >= 170 ? 'Steady hand.' : s >= 100 ? 'Good trip.' : 'Rough sketches.';
  $('result-sub').textContent = `You scored ${s} out of ${MAX} across ${ROUNDS} countries.`;
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
    ...sketches.map((sk, i) => {
      const a = state.attempts[i];
      const sec = document.createElement('section');
      sec.className = 'recap-sketch';
      const map = el('svg', { width: '300', height: '220', 'aria-hidden': 'true' }) as SVGSVGElement;
      drawBoard(map, sk, a, { reveal: true, w: 300, h: 220 });
      const body = document.createElement('div');
      const h = document.createElement('h3');
      h.textContent = sk.name;
      const strong = document.createElement('strong');
      strong.textContent = `+${a.score ?? 0}`;
      body.append(h, strong);
      sec.append(map, body);
      return sec;
    }),
  );
  startCountdown();
}

function shareString(): string {
  const parts = sketches.map((s, i) => `${s.name} ${state.attempts[i].score ?? 0}`).join(' · ');
  const hints = hintsUsed() ? [`${hintsUsed()} ${hintsUsed() === 1 ? 'hint' : 'hints'} used`] : [];
  return [`Outline Sketch No. ${puzzleNo} · ${score()}/${MAX}`, parts, ...hints, `${location.origin}/games/outline-sketch`].join('\n');
}

let countdownTimer = 0;
function startCountdown() {
  const out = $('countdown');
  const tick = () => {
    const sec = Math.floor(msUntilTomorrow() / 1000);
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
undoBtn.addEventListener('click', undo);
clearBtn.addEventListener('click', clearAll);
$('skip').addEventListener('click', skip);
submitBtn.addEventListener('click', () => {
  haptic.tap();
  check();
});
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
addTestReset('outline-sketch', STATE_KEY, todayKey);
