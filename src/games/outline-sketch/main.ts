import '../../shared/base';
import '../../shared/game.css';
import './os.css';
import { geoMercator, geoNaturalEarth1, geoPath, geoCentroid, geoDistance, geoCircle, type GeoProjection } from 'd3-geo';
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
  const ok = s.attempts.every(
    (a, i) =>
      a &&
      Array.isArray(a.picks) &&
      a.picks.every((c) => rounds[i].options.some((o) => o.code === c)) &&
      (a.pin === null || (Array.isArray(a.pin) && a.pin.length === 2 && a.pin.every(Number.isFinite))),
  );
  if (!ok) return fresh;
  s.cursor = Math.min(Math.max(0, s.cursor | 0), ROUNDS - 1);
  return s;
}
const state = sanitize(load<State | null>(STATE_KEY, null));
const persist = () => save(STATE_KEY, state);
const hintsUsed = () => state.attempts.reduce((n, a) => n + Number(a.hintPick) + Number(a.hintPlace), 0);
const roundScore = (a: Attempt) => (a.pickScore ?? 0) + (a.placeScore ?? 0);
const score = () => state.attempts.reduce((n, a) => n + roundScore(a), 0);
const finished = (a: Attempt) => a.placeScore !== null;
const shapeFor = (r: Round, code: string) => (code === r.code ? r.target : r.options.find((o) => o.code === code)?.shape ?? r.target);

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
  const h = (w * MAP_H) / MAP_W;
  return { x: Math.min(Math.max(0, cx - w / 2), MAP_W - w), y: Math.min(Math.max(0, cy - h / 2), MAP_H - h), w, h };
}

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

function renderOptions() {
  const i = state.cursor;
  const r = rounds[i];
  const a = state.attempts[i];
  const over = a.pickScore !== null;
  // A hint removes two wrong outlines (always the same two, so a reload doesn't reshuffle).
  const hidden = a.hintPick ? r.options.filter((o) => o.code !== r.code).slice(0, 2).map((o) => o.code) : [];
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
  if (finished(a)) {
    // Frame the real country and the player's drop together.
    const [[x0, y0], [x1, y1]] = mapPath.bounds(r.target);
    const [px, py] = a.pin ? (projection(a.pin) ?? [x0, y0]) : [x0, y0];
    const minX = Math.min(x0, px), maxX = Math.max(x1, px), minY = Math.min(y0, py), maxY = Math.max(y1, py);
    const w = Math.min(MAP_W, Math.max(150, (maxX - minX) * 1.5, ((maxY - minY) * 1.5 * MAP_W) / MAP_H));
    view = viewAround((minX + maxX) / 2, (minY + maxY) / 2, w);
  }
  mapSvg.setAttribute('viewBox', `${view.x.toFixed(1)} ${view.y.toFixed(1)} ${view.w.toFixed(1)} ${view.h.toFixed(1)}`);
  $('zoom-out').hidden = finished(a) || view.w >= MAP_W;
  mapSvg.replaceChildren();
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
      el('line', { class: 'od-miss', x1: px.toFixed(1), y1: py.toFixed(1), x2: tx.toFixed(1), y2: ty.toFixed(1) }, mapSvg);
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
  hintBtn.disabled = busy || state.done || finished(a) || left <= 0 || (stepOne ? a.hintPick : a.hintPlace);
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
    km <= FULL_KM ? `Right on target: ${r.name} is in green, your drop is dashed.` : `Your drop was ${km.toLocaleString()} km from ${r.name} (in green).`;
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
  const dots = rounds.flatMap((r, i) => {
    const a = state.attempts[i];
    const c = COUNTRIES[r.code];
    if (!c || (!finished(a) && i !== state.cursor)) return [];
    return [{ lon: c.lon, lat: c.lat, level: finished(a) ? (roundScore(a) >= 70 ? 1 : roundScore(a) >= 40 ? 3 : 4) : 5 }];
  });
  mini.setDots(dots);
  const c = COUNTRIES[rounds[state.cursor].code];
  if (c && !state.done) mini.focus([c]);
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
    // A short beat on the highlighted answer, then on to the map.
    setTimeout(() => {
      busy = false;
      renderCard();
      showFromTop(card);
    }, reducedMotion() ? 0 : 900);
  } else {
    renderOptions();
  }
}

optionsEl.addEventListener('click', (e) => {
  const b = (e.target as HTMLElement).closest<HTMLButtonElement>('.od-option');
  if (b?.dataset.code && !b.disabled) pick(b.dataset.code);
});

/* ---------- Step 2: drop it on the map ---------- */
function toLonLat(e: PointerEvent): LonLat | null {
  const m = mapSvg.getScreenCTM();
  if (!m) return null;
  const p = new DOMPoint(e.clientX, e.clientY).matrixTransform(m.inverse());
  const ll = projection.invert?.([p.x, p.y]);
  return ll && ll.every(Number.isFinite) ? (ll as LonLat) : null;
}

mapSvg.addEventListener('pointerup', (e) => {
  const a = state.attempts[state.cursor];
  if (busy || state.done || a.pickScore === null || finished(a) || e.button !== 0) return;
  const ll = toLonLat(e);
  if (!ll) return;
  a.pin = [Math.round(ll[0] * 100) / 100, Math.round(ll[1] * 100) / 100];
  persist();
  if (view.w >= MAP_W) {
    // First tap on the whole world: zoom in around it so the drop can be fine-tuned.
    const [x, y] = projection(a.pin) ?? [MAP_W / 2, MAP_H / 2];
    view = viewAround(x, y, MAP_W / 2.6);
  }
  haptic.select();
  renderMap();
  lockBtn.disabled = false;
  statusEl.textContent = 'Happy with that? Lock it in, or tap again to move it.';
});

function lockIn() {
  const i = state.cursor;
  const r = rounds[i];
  const a = state.attempts[i];
  if (busy || !a.pin || finished(a)) return;
  a.km = kmBetween(a.pin, geoCentroid(r.target) as LonLat);
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
    if (a.hintPick) return;
    a.hintPick = true;
    statusEl.textContent = 'Two wrong outlines removed.';
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
      detail.textContent = `Outline +${a.pickScore ?? 0} · Map +${a.placeScore ?? 0}${a.km !== null ? ` (${Math.round(a.km).toLocaleString()} km off)` : ''}`;
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
render();
void arrive(mini, $('mini-globe'));
watchDayChange(todayKey);
addTestReset('outline-sketch', STATE_KEY, todayKey);
