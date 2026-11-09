import '../../shared/base';
import '../../shared/game.css';
import './os.css';
import { geoMercator, geoNaturalEarth1, geoPath, geoCentroid, geoDistance, geoCircle, geoContains, type GeoProjection } from 'd3-geo';
import type { MultiPolygon } from 'geojson';
import { COUNTRIES } from '../../data/countries';
import { dayIndex, dayKey, msUntilTomorrow } from '../../shared/daily';
import { load, save } from '../../shared/storage';
import { shareText } from '../../shared/share';
import { haptic } from '../../shared/haptics';
import { getLand, reducedMotion } from '../../shared/geo';
import { arrive, miniGlobe } from '../../shared/travel';
import { loadToday, showLoadError } from '../../shared/bank';
import { showGrade } from '../../shared/grades';
import { addTestReset } from '../../shared/testing';
import { watchDayChange, recordDay, readStats, focusQuietly, scrollToTop, showFromTop } from '../../shared/session';

/* ---------- Types & data ---------- */
interface Option {
  code: string;
  shape: MultiPolygon | null; // null = the answer (use the round's own target)
}
interface Round {
  code: string;
  name: string;
  target: MultiPolygon;
  options: Option[];
}
type LonLat = [number, number];
interface Attempt {
  picks: string[]; // codes tried in step 1, in order
  pickScore: number | null; // set once step 1 is over
  pin: LonLat | null; // where the player dropped the shape
  placeScore: number | null; // set once locked in
  km: number | null;
  hintPick: boolean;
  hintPlace: boolean;
  hidden?: string[]; // outlines the step-one hint took away
}
interface State {
  attempts: Attempt[];
  cursor: number;
  done: boolean;
  counted: boolean;
  fp?: string;
}

const FREE_HINTS = 3;
const NS = 'http://www.w3.org/2000/svg';
const MAP_W = 640;
const MAP_H = 330;
const FULL_KM = 300; // within this, full placement points
const ZERO_KM = 3000; // beyond this, none

const flagUrls = import.meta.glob('/node_modules/flag-icons/flags/4x3/*.svg', {
  eager: true,
  query: '?url',
  import: 'default',
}) as Record<string, string>;
const flag = (code: string) => flagUrls[`/node_modules/flag-icons/flags/4x3/${code}.svg`] ?? '';

const today = dayIndex();
const todayKey = dayKey(); // fixed before any await, so a slow load can't straddle midnight
const puzzleNo = today + 1;
const { countries: rounds } = await loadToday<{ countries: Round[] }>('outline-sketch').catch((e) => {
  showLoadError(document.getElementById('board'));
  throw e;
});
const ROUNDS = rounds.length;
const MAX = ROUNDS * 100;
const STATE_KEY = `outline-sketch:day:${todayKey}`;
// v3: pick-and-drop mode. Progress saved by older versions is discarded via the fingerprint.
const FP = `drop:${rounds.map((r) => r.code).join()}`;
const STATS_KEY = 'outline-sketch:stats';

const blank = (): Attempt => ({ picks: [], pickScore: null, pin: null, placeScore: null, km: null, hintPick: false, hintPlace: false });
function sanitize(s: State | null): State {
  const fresh: State = { attempts: rounds.map(blank), cursor: 0, done: false, counted: false, fp: FP };
  if (!s || s.fp !== FP || !Array.isArray(s.attempts) || s.attempts.length !== ROUNDS) return fresh;
  const num = (v: unknown, max: number) => v === null || (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= max);
  const ok = s.attempts.every(
    (a, i) =>
      a &&
      Array.isArray(a.picks) &&
      a.picks.every((c) => rounds[i].options.some((o) => o.code === c)) &&
      (a.pin === null || (Array.isArray(a.pin) && a.pin.length === 2 && a.pin.every(Number.isFinite))) &&
      num(a.pickScore, 50) &&
      num(a.placeScore, 50) &&
      num(a.km, 40000) &&
      // A locked-in drop needs both steps done.
      (a.placeScore === null || (a.pickScore !== null && a.pin !== null && a.km !== null)),
  );
  if (!ok) return fresh;
  s.attempts.forEach((a, i) => {
    a.hintPick = a.hintPick === true;
    a.hintPlace = a.hintPlace === true;
    const wrong = (c: unknown) => typeof c === 'string' && c !== rounds[i].code && rounds[i].options.some((o) => o.code === c);
    if (!a.hintPick || !Array.isArray(a.hidden) || !a.hidden.every(wrong)) delete a.hidden;
  });
  s.cursor = Math.min(Math.max(0, s.cursor | 0), ROUNDS - 1);
  s.done = s.done === true && s.attempts.every((a) => a.placeScore !== null);
  s.counted = s.counted === true;
  return s;
}
const state = sanitize(load<State | null>(STATE_KEY, null));
const persist = () => save(STATE_KEY, state);
const hintsUsed = () => state.attempts.reduce((n, a) => n + Number(a.hintPick) + Number(a.hintPlace), 0);
const roundScore = (a: Attempt) => (a.pickScore ?? 0) + (a.placeScore ?? 0);
const score = () => state.attempts.reduce((n, a) => n + roundScore(a), 0);
const finished = (a: Attempt) => a.placeScore !== null;
// Every choice is drawn at the same level of detail (the bank sends the answer's coarse shape too), so the
// answer can't be spotted by being the most detailed outline. Older day files send null for the answer.
const shapeFor = (r: Round, code: string) => r.options.find((o) => o.code === code)?.shape ?? r.target;

/* ---------- Elements ---------- */
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const card = $('card');
const statusEl = $('status');
const hintBtn = $<HTMLButtonElement>('hint');
const optionsEl = $('options');
const mapSvg = document.getElementById('map') as unknown as SVGSVGElement;
const lockBtn = $<HTMLButtonElement>('lock');
const mini = miniGlobe($('mini-globe'));
let busy = false;
type View = { x: number; y: number; w: number; h: number };
const FULL_VIEW: View = { x: 0, y: 0, w: MAP_W, h: MAP_H };
let view: View = FULL_VIEW; // zoomed in after the first tap so small countries are easy to place

/** A view of `w` map units wide centred on (cx, cy), kept inside the map. */
function viewAround(cx: number, cy: number, w: number): View {
  w = Math.min(MAP_W, Math.max(MIN_VIEW_W, w));
  const h = (w * MAP_H) / MAP_W;
  return { x: Math.min(Math.max(0, cx - w / 2), MAP_W - w), y: Math.min(Math.max(0, cy - h / 2), MAP_H - h), w, h };
}
const MIN_VIEW_W = MAP_W / 30; // up to 30x zoom, enough for the smallest island countries
let revealFramed = false; // the reveal frames itself once; after that the player can zoom and pan freely

$('puzzle-meta').textContent = `No. ${puzzleNo} · ${new Intl.DateTimeFormat(undefined, {
  weekday: 'short',
  day: 'numeric',
  month: 'short',
}).format(new Date())}`;

const el = <K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string>, parent?: Element) => {
  const n = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  parent?.appendChild(n);
  return n;
};

/* ---------- The blank world map ---------- */
// Natural Earth projection framed on the inhabited world (no Antarctica), shared by every round.
const projection: GeoProjection = geoNaturalEarth1().fitExtent(
  [[6, 6], [MAP_W - 6, MAP_H - 6]],
  { type: 'MultiPoint', coordinates: [[-180, -56], [180, -56], [-180, 83], [180, 83], [0, -56], [0, 83]] },
);
const mapPath = geoPath(projection);
const landD = mapPath(getLand()) ?? '';
const sphereD = mapPath({ type: 'Sphere' }) ?? '';

/** Projected outline of a country, plus its projected centre, for sliding it around the map. */
function placed(r: Round) {
  const c = geoCentroid(r.target) as LonLat;
  return { d: mapPath(r.target) ?? '', centre: projection(c) ?? [0, 0], lonlat: c };
}

/* ---------- Scoring ---------- */
const kmBetween = (a: LonLat, b: LonLat) => geoDistance(a, b) * 6371;

/**
 * How far a drop is from the country itself: 0 anywhere on it, otherwise the distance to its
 * nearest edge. Fairer than the centre for long or curved countries (Chile, Norway, Vietnam,
 * Croatia), whose centre can lie far from, or even outside, much of the land.
 */
function missFrom(target: MultiPolygon, pin: LonLat): { km: number; to: LonLat } {
  if (geoContains(target, pin)) return { km: 0, to: pin };
  const [lon0, lat0] = pin;
  const k = Math.cos((lat0 * Math.PI) / 180);
  const local = ([lon, lat]: number[]): [number, number] => [((((lon - lon0) % 360) + 540) % 360 - 180) * k, lat - lat0];
  let best: LonLat = pin;
  let bestD = Infinity;
  for (const poly of target.coordinates) {
    for (const ring of poly) {
      for (let j = 0; j < ring.length - 1; j++) {
        // Nearest point on each edge, worked out on a flat map centred on the pin (fine at these scales).
        const [ax, ay] = local(ring[j]);
        const [bx, by] = local(ring[j + 1]);
        const dx = bx - ax;
        const dy = by - ay;
        const len = dx * dx + dy * dy;
        const t = len ? Math.min(1, Math.max(0, -(ax * dx + ay * dy) / len)) : 0;
        const x = ax + t * dx;
        const y = ay + t * dy;
        const d = x * x + y * y;
        if (d < bestD) {
          bestD = d;
          best = [lon0 + (k ? x / k : 0), lat0 + y];
        }
      }
    }
  }
  return { km: kmBetween(pin, best), to: best };
}
function placePoints(km: number) {
  if (km <= FULL_KM) return 50;
  return Math.round(50 * Math.max(0, 1 - (km - FULL_KM) / (ZERO_KM - FULL_KM)));
}

/* ---------- Rendering ---------- */
function thumb(shape: MultiPolygon, w = 150, h = 110): SVGSVGElement {
  const s = el('svg', { viewBox: `0 0 ${w} ${h}`, 'aria-hidden': 'true' }) as SVGSVGElement;
  const proj = geoMercator().fitExtent([[10, 10], [w - 10, h - 10]], shape);
  el('path', { class: 'od-shape', d: geoPath(proj)(shape) ?? '' }, s);
  return s;
}

/** Wrong outlines the player hasn't tried yet. */
const untriedWrong = (r: Round, a: Attempt) => r.options.map((o) => o.code).filter((c) => c !== r.code && !a.picks.includes(c));

function hiddenByHint(r: Round, a: Attempt): string[] {
  // Saved when the hint is used. Progress from before that was saved always hid the first two.
  return a.hidden ?? r.options.filter((o) => o.code !== r.code).slice(0, 2).map((o) => o.code);
}

function renderOptions() {
  const i = state.cursor;
  const r = rounds[i];
  const a = state.attempts[i];
  const over = a.pickScore !== null;
  // A hint takes away the wrong outlines not yet tried, all but one.
  const hidden = a.hintPick ? hiddenByHint(r, a) : [];
  optionsEl.replaceChildren(
    ...r.options.map((o, k) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'od-option';
      b.dataset.code = o.code;
      const tried = a.picks.includes(o.code);
      const right = o.code === r.code;
      if (tried && !right) b.classList.add('is-wrong');
      if (over && right) b.classList.add('is-right');
      b.disabled = over || tried || hidden.includes(o.code);
      if (hidden.includes(o.code)) b.classList.add('is-gone');
      const label = document.createElement('span');
      label.className = 'od-letter';
      label.textContent = 'ABCD'[k];
      b.append(thumb(shapeFor(r, o.code)), label);
      b.setAttribute('aria-label', `Outline ${'ABCD'[k]}${tried && !right ? ', wrong' : ''}${over && right ? `, ${r.name}` : ''}`);
      return b;
    }),
  );
}

function renderMap(animate = false) {
  const i = state.cursor;
  const r = rounds[i];
  const a = state.attempts[i];
  const p = placed(r);
  if (finished(a) && !revealFramed) {
    revealFramed = true;
    // Frame the real country and the player's drop together.
    const [[x0, y0], [x1, y1]] = mapPath.bounds(r.target);
    const [px, py] = a.pin ? (projection(a.pin) ?? [x0, y0]) : [x0, y0];
    const minX = Math.min(x0, px), maxX = Math.max(x1, px), minY = Math.min(y0, py), maxY = Math.max(y1, py);
    const w = Math.min(MAP_W, Math.max(150, (maxX - minX) * 1.5, ((maxY - minY) * 1.5 * MAP_W) / MAP_H));
    view = viewAround((minX + maxX) / 2, (minY + maxY) / 2, w);
  }
  mapSvg.replaceChildren();
  applyView();
  el('path', { class: 'od-sea', d: sphereD }, mapSvg);
  el('path', { class: 'od-land', d: landD }, mapSvg);
  if (a.hintPlace && !finished(a)) {
    // A dashed ring around the right region, nudged off-centre so it doesn't give the exact spot.
    const seed = r.code.charCodeAt(0) * 31 + r.code.charCodeAt(1);
    const centre: LonLat = [p.lonlat[0] + ((seed % 7) - 3) * 2.2, p.lonlat[1] + ((seed % 5) - 2) * 2.2];
    el('path', { class: 'od-ring', d: mapPath(geoCircle().center(centre).radius(16)()) ?? '' }, mapSvg);
  }
  if (finished(a)) {
    el('path', { class: 'od-truth' + (animate ? ' is-revealing' : ''), d: p.d }, mapSvg);
    const [tx, ty] = p.centre;
    el('circle', { class: 'od-truth-dot', cx: tx.toFixed(1), cy: ty.toFixed(1), r: (4 * view.w / MAP_W).toFixed(2) }, mapSvg);
    if (a.pin) {
      const [px, py] = projection(a.pin) ?? [0, 0];
      if ((a.km ?? 0) > 0) {
        // The miss is measured to the nearest edge of the country, so that's where the line goes.
        const [mx, my] = projection(missFrom(r.target, a.pin).to) ?? [tx, ty];
        el('line', { class: 'od-miss', x1: px.toFixed(1), y1: py.toFixed(1), x2: mx.toFixed(1), y2: my.toFixed(1) }, mapSvg);
      }
      el('path', { class: 'od-guess is-compare', d: p.d, transform: `translate(${(px - tx).toFixed(1)} ${(py - ty).toFixed(1)})` }, mapSvg);
    }
    return;
  }
  if (a.pin) {
    const [px, py] = projection(a.pin) ?? [0, 0];
    const [cx, cy] = p.centre;
    el('path', { class: 'od-guess', d: p.d, transform: `translate(${(px - cx).toFixed(1)} ${(py - cy).toFixed(1)})` }, mapSvg);
    // Small countries vanish at world scale: a pin always marks the spot.
    el('circle', { class: 'od-pin', cx: px.toFixed(1), cy: py.toFixed(1), r: (5 * view.w / MAP_W).toFixed(2) }, mapSvg);
  }
}

function renderTrip() {
  $('trip').replaceChildren(
    ...rounds.map((r, i) => {
      const a = state.attempts[i];
      const li = document.createElement('li');
      if (finished(a)) {
        li.className = 'is-done';
        li.dataset.level = roundScore(a) >= 70 ? '1' : roundScore(a) >= 40 ? '3' : '4';
      }
      if (i === state.cursor && !state.done) li.classList.add('is-current');
      const stop = document.createElement('span');
      stop.className = 'stop';
      const img = document.createElement('img');
      img.src = flag(r.code);
      img.alt = '';
      stop.append(img);
      const label = document.createElement('span');
      label.className = 'visually-hidden';
      label.textContent = `Country ${i + 1}: ${r.name}${finished(a) ? `, ${roundScore(a)} points` : i === state.cursor ? ', current' : ''}`;
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
  const stepOne = a.pickScore === null;
  // In step one a hint needs at least two untried wrong outlines to take one away and leave a choice.
  const r = rounds[state.cursor];
  hintBtn.disabled = busy || state.done || finished(a) || left <= 0 || (stepOne ? a.hintPick || untriedWrong(r, a).length < 2 : a.hintPlace);
}

function renderCard(animate = false) {
  const i = state.cursor;
  const r = rounds[i];
  const a = state.attempts[i];
  const stepOne = a.pickScore === null;
  $('card-step').textContent = `Country ${i + 1} of ${ROUNDS}`;
  $('card-title').textContent = r.name;
  $<HTMLImageElement>('card-flag').src = flag(r.code);
  $('score').textContent = String(score());
  $('step-pick').hidden = !stepOne;
  $('step-place').hidden = stepOne;
  $('step-label').textContent = stepOne ? 'Step 1 of 2 · Pick the outline' : 'Step 2 of 2 · Drop it on the map';
  if (stepOne) renderOptions();
  else renderMap(animate);
  $('od-actions').hidden = stepOne || finished(a);
  lockBtn.disabled = !a.pin || busy;
  $('after').hidden = !finished(a);
  if (finished(a)) renderAfter();
  else if (!statusEl.textContent) {
    statusEl.textContent = stepOne ? `Which of these is the outline of ${r.name}?` : `Tap the map where ${r.name} is. Tap again to move it.`;
  }
  renderHint();
  renderTrip();
  syncMini();
}

function renderAfter() {
  const i = state.cursor;
  const r = rounds[i];
  const a = state.attempts[i];
  const km = Math.round(a.km ?? 0);
  statusEl.textContent =
    km === 0
      ? `Right on target: ${r.name} is in green, your drop is dashed.`
      : km <= FULL_KM
        ? `Close enough for full marks: ${km.toLocaleString()} km from ${r.name} (in green).`
        : `Your drop was ${km.toLocaleString()} km from ${r.name} (in green).`;
  const v = $('verdict');
  const pts = document.createElement('span');
  pts.className = 'pts';
  const total = roundScore(a);
  pts.dataset.level = total >= 70 ? '1' : total >= 40 ? '3' : '4';
  pts.textContent = `+${total}`;
  v.replaceChildren(document.createTextNode(total >= 90 ? 'Spot on.' : total >= 70 ? 'Nicely done.' : total >= 40 ? 'Not bad.' : 'Next one.'), pts);
  $('next').textContent = i === ROUNDS - 1 ? 'See your results' : 'Next country';
}

function syncMini() {
  // Only countries already placed show up: a dot (or a turn of the globe) on the current country
  // would give away where to drop it.
  const dots = rounds.flatMap((r, i) => {
    const a = state.attempts[i];
    const c = COUNTRIES[r.code];
    if (!c || !finished(a)) return [];
    return [{ lon: c.lon, lat: c.lat, level: roundScore(a) >= 70 ? 1 : roundScore(a) >= 40 ? 3 : 4 }];
  });
  mini.setDots(dots);
  const c = COUNTRIES[rounds[state.cursor].code];
  if (c && !state.done && finished(state.attempts[state.cursor])) mini.focus([c]);
}

function bump() {
  const s = $('score');
  s.textContent = String(score());
  s.classList.remove('is-bump');
  void s.offsetWidth;
  s.classList.add('is-bump');
}

/* ---------- Step 1: pick the outline ---------- */
function pick(code: string) {
  const i = state.cursor;
  const r = rounds[i];
  const a = state.attempts[i];
  if (busy || a.pickScore !== null || a.picks.includes(code)) return;
  a.picks.push(code);
  if (code === r.code) {
    a.pickScore = a.picks.length === 1 ? 50 : a.picks.length === 2 ? 25 : 10;
    haptic.success();
    statusEl.textContent = `Yes, that's ${r.name}. Now tap the map where it belongs.`;
  } else if (a.picks.length >= 3) {
    a.pickScore = 0;
    haptic.error();
    statusEl.textContent = `Not quite. That's ${r.name}'s outline highlighted. Now drop it on the map.`;
  } else {
    haptic.error();
    statusEl.textContent = a.picks.length === 1 ? 'Not that one. Try again for 25 points.' : 'Not that one either. One more try.';
  }
  persist();
  if (a.pickScore !== null) {
    renderOptions();
    bump();
    busy = true;
    renderHint();
    // A short beat on the highlighted answer, then on to the map.
    setTimeout(() => {
      busy = false;
      renderCard();
      showFromTop(card);
    }, reducedMotion() ? 0 : 900);
  } else {
    renderOptions();
    renderHint();
  }
}

optionsEl.addEventListener('click', (e) => {
  const b = (e.target as HTMLElement).closest<HTMLButtonElement>('.od-option');
  if (b?.dataset.code && !b.disabled) pick(b.dataset.code);
});

/* ---------- Step 2: drop it on the map ---------- */
const dotR = () => ((5 * view.w) / MAP_W).toFixed(2);
/** Update only the camera (viewBox) and things that scale with it: cheap enough for every pinch frame. */
function applyView() {
  mapSvg.setAttribute('viewBox', `${view.x.toFixed(1)} ${view.y.toFixed(1)} ${view.w.toFixed(1)} ${view.h.toFixed(1)}`);
  mapSvg.querySelectorAll('.od-pin').forEach((c) => c.setAttribute('r', dotR()));
  mapSvg.querySelectorAll('.od-truth-dot').forEach((c) => c.setAttribute('r', ((4 * view.w) / MAP_W).toFixed(2)));
  $('zoom-out').hidden = view.w >= MAP_W;
  $<HTMLButtonElement>('zoom-in-btn').disabled = view.w <= MIN_VIEW_W + 0.01;
  $<HTMLButtonElement>('zoom-out-btn').disabled = view.w >= MAP_W;
}
/** Zoom by `factor` (>1 = in) keeping the map point (mx, my) under the same spot on screen. */
function zoomAt(mx: number, my: number, factor: number, from: View = view) {
  const w = Math.min(MAP_W, Math.max(MIN_VIEW_W, from.w / factor));
  const k = w / from.w;
  const h = (w * MAP_H) / MAP_W;
  view = {
    x: Math.min(Math.max(0, mx - (mx - from.x) * k), MAP_W - w),
    y: Math.min(Math.max(0, my - (my - from.y) * k), MAP_H - h),
    w,
    h,
  };
  applyView();
}
/** Move the dropped shape and its pin without rebuilding the map (used while dragging). */
function moveGuess() {
  const r = rounds[state.cursor];
  const a = state.attempts[state.cursor];
  if (!a.pin) return;
  const [px, py] = projection(a.pin) ?? [0, 0];
  const [cx, cy] = placed(r).centre;
  const g = mapSvg.querySelector('.od-guess:not(.is-compare)');
  const pin = mapSvg.querySelector('.od-pin');
  if (!g || !pin) return renderMap();
  g.setAttribute('transform', `translate(${(px - cx).toFixed(1)} ${(py - cy).toFixed(1)})`);
  pin.setAttribute('cx', px.toFixed(1));
  pin.setAttribute('cy', py.toFixed(1));
}
/** The place on Earth under a point of the map, or null off the edge of the world. */
function mapToLonLat(x: number, y: number): LonLat | null {
  const ll = projection.invert?.([x, y]);
  if (!ll || !ll.every(Number.isFinite)) return null;
  // Outside the oval the inverse wraps round to the far side of the world: ignore those taps.
  const back = projection(ll);
  if (!back || Math.hypot(back[0] - x, back[1] - y) > 1) return null;
  return ll as LonLat;
}

function toLonLat(e: PointerEvent): LonLat | null {
  const m = mapSvg.getScreenCTM();
  if (!m) return null;
  const p = new DOMPoint(e.clientX, e.clientY).matrixTransform(m.inverse());
  return mapToLonLat(p.x, p.y);
}

const canDrop = () => {
  const a = state.attempts[state.cursor];
  return !busy && !state.done && a.pickScore !== null && !finished(a);
};

function dropAt(ll: LonLat, zoom = true) {
  const a = state.attempts[state.cursor];
  a.pin = [Math.round(ll[0] * 100) / 100, Math.round(ll[1] * 100) / 100];
  persist();
  if (zoom && view.w >= MAP_W) {
    // First tap on the whole world: zoom in around it so the drop can be fine-tuned.
    const [x, y] = projection(a.pin) ?? [MAP_W / 2, MAP_H / 2];
    view = viewAround(x, y, MAP_W / 2.6);
  }
  haptic.select();
  renderMap();
  lockBtn.disabled = false;
  statusEl.textContent = 'Drag the shape to fine-tune it, or tap somewhere else. Pinch or use + and - to zoom.';
}

/* Gestures on the map:
   - tap: drop the shape there
   - press on the dropped shape and drag: slide it around
   - drag anywhere else: pan (when zoomed in)
   - pinch, mouse wheel or the + / - buttons: zoom */
const pointers = new Map<number, { x: number; y: number }>();
type Gesture =
  | { kind: 'tap-or-pan'; id: number; sx: number; sy: number; start: View; moved: boolean }
  | { kind: 'drag'; id: number; sx: number; sy: number; grab: [number, number]; moved: boolean }
  | { kind: 'pinch'; dist: number; mid: [number, number]; start: View };
let gesture: Gesture | null = null;

const toMap = (clientX: number, clientY: number): [number, number] | null => {
  const m = mapSvg.getScreenCTM();
  if (!m) return null;
  const p = new DOMPoint(clientX, clientY).matrixTransform(m.inverse());
  return [p.x, p.y];
};
/** Map units per screen pixel at the current zoom. */
const unitsPerPx = () => view.w / (mapSvg.getBoundingClientRect().width || MAP_W);

function onShape(clientX: number, clientY: number): boolean {
  const a = state.attempts[state.cursor];
  if (!a.pin || finished(a)) return false;
  const pin = mapSvg.querySelector('.od-pin')?.getBoundingClientRect();
  if (pin && Math.hypot(clientX - (pin.left + pin.width / 2), clientY - (pin.top + pin.height / 2)) < 30) return true;
  const g = mapSvg.querySelector('.od-guess:not(.is-compare)')?.getBoundingClientRect();
  return !!g && clientX >= g.left - 6 && clientX <= g.right + 6 && clientY >= g.top - 6 && clientY <= g.bottom + 6;
}

function startPinch() {
  const [p1, p2] = [...pointers.values()];
  const mid = toMap((p1.x + p2.x) / 2, (p1.y + p2.y) / 2);
  if (!mid) return;
  gesture = { kind: 'pinch', dist: Math.hypot(p1.x - p2.x, p1.y - p2.y) || 1, mid, start: { ...view } };
}

mapSvg.addEventListener('pointerdown', (e) => {
  const stepTwo = state.attempts[state.cursor].pickScore !== null;
  if (!stepTwo || (e.pointerType === 'mouse' && e.button !== 0)) return;
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  try {
    mapSvg.setPointerCapture(e.pointerId);
  } catch {
    /* capture is a nicety */
  }
  if (pointers.size === 2) return startPinch();
  if (pointers.size > 2) return;
  if (canDrop() && onShape(e.clientX, e.clientY)) {
    const a = state.attempts[state.cursor];
    const at = toMap(e.clientX, e.clientY);
    const pin = projection(a.pin!) ?? [0, 0];
    gesture = { kind: 'drag', id: e.pointerId, sx: e.clientX, sy: e.clientY, grab: at ? [pin[0] - at[0], pin[1] - at[1]] : [0, 0], moved: false };
  } else {
    gesture = { kind: 'tap-or-pan', id: e.pointerId, sx: e.clientX, sy: e.clientY, start: { ...view }, moved: false };
  }
});

mapSvg.addEventListener('pointermove', (e) => {
  if (!pointers.has(e.pointerId)) return;
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (!gesture) return;
  if (gesture.kind === 'pinch') {
    if (pointers.size < 2) return;
    const [p1, p2] = [...pointers.values()];
    const dist = Math.hypot(p1.x - p2.x, p1.y - p2.y) || 1;
    zoomAt(gesture.mid[0], gesture.mid[1], dist / gesture.dist, gesture.start);
    return;
  }
  if (e.pointerId !== gesture.id) return;
  const dx = e.clientX - gesture.sx;
  const dy = e.clientY - gesture.sy;
  if (!gesture.moved && Math.hypot(dx, dy) < 6) return;
  gesture.moved = true;
  if (gesture.kind === 'drag') {
    const at = toMap(e.clientX, e.clientY);
    if (!at) return;
    const ll = mapToLonLat(at[0] + gesture.grab[0], at[1] + gesture.grab[1]);
    if (!ll) return;
    state.attempts[state.cursor].pin = [Math.round(ll[0] * 100) / 100, Math.round(ll[1] * 100) / 100];
    moveGuess();
  } else if (view.w < MAP_W || gesture.start.w < MAP_W) {
    const k = unitsPerPx();
    const s = gesture.start;
    view = { ...s, x: Math.min(Math.max(0, s.x - dx * k), MAP_W - s.w), y: Math.min(Math.max(0, s.y - dy * k), MAP_H - s.h) };
    applyView();
  }
});

function endPointer(e: PointerEvent) {
  if (!pointers.has(e.pointerId)) return;
  pointers.delete(e.pointerId);
  const g = gesture;
  if (!g) return;
  if (g.kind === 'pinch') {
    // Lifting one finger of a pinch ends the gesture; the other finger doesn't suddenly drop or pan.
    if (pointers.size === 0) gesture = null;
    else gesture = { kind: 'tap-or-pan', id: [...pointers.keys()][0], sx: [...pointers.values()][0].x, sy: [...pointers.values()][0].y, start: { ...view }, moved: true };
    return;
  }
  if (e.pointerId !== g.id) return;
  gesture = null;
  if (e.type === 'pointercancel') return;
  if (g.kind === 'drag' && g.moved) {
    persist();
    haptic.select();
    lockBtn.disabled = false;
    statusEl.textContent = 'Nudged. Lock it in when it looks right.';
    return;
  }
  if (!g.moved && canDrop()) {
    const ll = toLonLat(e);
    if (ll) dropAt(ll);
  }
}
mapSvg.addEventListener('pointerup', endPointer);
mapSvg.addEventListener('pointercancel', endPointer);

mapSvg.addEventListener(
  'wheel',
  (e) => {
    if (state.attempts[state.cursor].pickScore === null) return;
    const at = toMap(e.clientX, e.clientY);
    if (!at) return;
    e.preventDefault();
    zoomAt(at[0], at[1], Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0025)));
  },
  { passive: false },
);

function zoomButton(factor: number) {
  haptic.tap();
  const a = state.attempts[state.cursor];
  // Zoom toward the dropped shape if there is one, otherwise the middle of the view.
  const pin = a.pin && !finished(a) ? projection(a.pin) : null;
  const [mx, my] = pin ?? [view.x + view.w / 2, view.y + view.h / 2];
  zoomAt(mx, my, factor);
  if (pin) view = viewAround(mx, my, view.w);
  applyView();
}

// Keyboard: arrow keys move the marker (Shift for bigger steps), Enter locks it in.
mapSvg.addEventListener('keydown', (e) => {
  if (!canDrop()) return;
  const a = state.attempts[state.cursor];
  if (e.key === '+' || e.key === '=' || e.key === '-' || e.key === '_') {
    e.preventDefault();
    zoomButton(e.key === '+' || e.key === '=' ? 1.6 : 1 / 1.6);
    return;
  }
  if (e.key === 'Enter') {
    if (a.pin) {
      e.preventDefault();
      lockIn();
    }
    return;
  }
  const dir: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
  const d = dir[e.key];
  if (!d) return;
  e.preventDefault();
  const centre: [number, number] = [view.x + view.w / 2, view.y + view.h / 2];
  const [x, y] = a.pin ? (projection(a.pin) ?? centre) : centre;
  // The first key press drops the marker in the middle of the view; later ones move it.
  const step = a.pin ? view.w / (e.shiftKey ? 8 : 40) : 0;
  const nx = Math.min(Math.max(0, x + d[0] * step), MAP_W);
  const ny = Math.min(Math.max(0, y + d[1] * step), MAP_H);
  const ll = mapToLonLat(nx, ny);
  if (!ll) return;
  // Once zoomed in, the view follows the marker.
  if (view.w < MAP_W && (nx < view.x || nx > view.x + view.w || ny < view.y || ny > view.y + view.h)) view = viewAround(nx, ny, view.w);
  dropAt(ll, false);
});

function lockIn() {
  const i = state.cursor;
  const r = rounds[i];
  const a = state.attempts[i];
  if (busy || !a.pin || finished(a)) return;
  a.km = missFrom(r.target, a.pin).km;
  a.placeScore = placePoints(a.km);
  persist();
  if (a.placeScore >= 35) haptic.success();
  else haptic.error();
  renderCard(true);
  bump();
  $('next').focus({ preventScroll: true });
  showFromTop(card);
}

function useHint() {
  const a = state.attempts[state.cursor];
  if (busy || state.done || finished(a) || hintsUsed() >= FREE_HINTS) return;
  haptic.tap();
  if (a.pickScore === null) {
    const untried = untriedWrong(rounds[state.cursor], a);
    if (a.hintPick || untried.length < 2) return;
    a.hintPick = true;
    a.hidden = untried.slice(0, -1);
    statusEl.textContent = a.hidden.length === 1 ? 'One wrong outline removed.' : 'Two wrong outlines removed.';
  } else {
    if (a.hintPlace) return;
    a.hintPlace = true;
    statusEl.textContent = "It's somewhere inside the dashed ring.";
  }
  persist();
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
  view = FULL_VIEW;
  revealFramed = false;
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
  $('result-title').textContent = s >= 250 ? 'Master mapmaker.' : s >= 180 ? 'Sharp eyes.' : s >= 110 ? 'Good trip.' : 'Room to explore.';
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
    ...rounds.map((r, i) => {
      const a = state.attempts[i];
      const sec = document.createElement('section');
      sec.className = 'recap-sketch';
      const body = document.createElement('div');
      const h = document.createElement('h3');
      h.textContent = r.name;
      const strong = document.createElement('strong');
      strong.textContent = `+${roundScore(a)}`;
      const detail = document.createElement('p');
      detail.className = 'od-recap-detail';
      detail.textContent = `Outline +${a.pickScore ?? 0} · Map +${a.placeScore ?? 0}${a.km === null ? '' : a.km === 0 ? ' (right on it)' : ` (${Math.round(a.km).toLocaleString()} km off)`}`;
      body.append(h, strong);
      sec.append(thumb(r.target, 300, 180), body, detail);
      return sec;
    }),
  );
  startCountdown();
}

function shareString(): string {
  const parts = rounds.map((r, i) => `${r.name} ${roundScore(state.attempts[i])}`).join(' · ');
  const hints = hintsUsed() ? [`${hintsUsed()} ${hintsUsed() === 1 ? 'hint' : 'hints'} used`] : [];
  return [`Outline Drop No. ${puzzleNo} · ${score()}/${MAX}`, parts, ...hints, `${location.origin}/games/outline-sketch`].join('\n');
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
$('zoom-in-btn').addEventListener('click', () => zoomButton(1.6));
$('zoom-out-btn').addEventListener('click', () => zoomButton(1 / 1.6));
$('zoom-out').addEventListener('click', () => {
  haptic.tap();
  view = FULL_VIEW;
  renderMap();
});
lockBtn.addEventListener('click', () => {
  haptic.tap();
  lockIn();
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
{
  // Back mid-drop after a reload: zoom in on the marker again, as it was.
  const a = state.attempts[state.cursor];
  const p = !state.done && a.pin && !finished(a) ? projection(a.pin) : null;
  if (p) view = viewAround(p[0], p[1], MAP_W / 2.6);
}
render();
void arrive(mini, $('mini-globe'));
watchDayChange(todayKey);
addTestReset('outline-sketch', STATE_KEY, todayKey);
