// The "travel" transition between the hub and a game:
//   hub:  the spinning globe flies to the centre and zooms in until the ocean fills the screen
//   game: the globe zooms back out of the ocean and settles into the corner mini globe
// Pure SVG redrawn every frame (crisp at any scale), works in every modern browser,
// and is skipped entirely for reduced-motion users.
import { geoOrthographic, geoPath, geoGraticule10 } from 'd3-geo';
import { getLand, reducedMotion } from './geo';
import { todayDataUrl } from './bank';

export type Rotation = [number, number, number];
export interface Dot {
  lon: number;
  lat: number;
  level: number;
}

const NS = 'http://www.w3.org/2000/svg';
const ROT_KEY = 'gg:travel-rotation';
const DEFAULT_ROT: Rotation = [-20, -18, 0];

/* ---------- easing ---------- */
const easeInOutCubic = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
const clamp01 = (t: number) => Math.max(0, Math.min(1, t));
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
/** Any angle as the equivalent in [-180, 180): the short way round, even for negative or large inputs. */
const wrap180 = (deg: number) => ((((deg + 180) % 360) + 360) % 360) - 180;
/** Interpolate radius on a log scale so the zoom speed feels constant. */
const zoomLerp = (a: number, b: number, t: number) => a * (b / a) ** t;

function tween(duration: number, frame: (t: number) => void): Promise<void> {
  return new Promise((resolve) => {
    const start = performance.now();
    const step = (now: number) => {
      const t = clamp01((now - start) / duration);
      frame(t);
      if (t < 1) requestAnimationFrame(step);
      else resolve();
    };
    requestAnimationFrame(step);
  });
}

/* ---------- rotation hand-off (sessionStorage: this tab only, never leaves the device) ---------- */
function saveRotation(r: Rotation) {
  try {
    sessionStorage.setItem(ROT_KEY, JSON.stringify(r));
  } catch {
    /* fine without it */
  }
}
function loadRotation(): Rotation {
  try {
    const v = JSON.parse(sessionStorage.getItem(ROT_KEY) ?? 'null');
    if (Array.isArray(v) && v.length === 3 && v.every((n) => Number.isFinite(n))) return v as Rotation;
  } catch {
    /* fall through */
  }
  return DEFAULT_ROT;
}

/* ---------- a globe drawn into any <svg> ---------- */
export function drawableGlobe(svg: SVGSVGElement) {
  const projection = geoOrthographic().clipAngle(90).precision(0.7);
  const path = geoPath(projection);
  const land = getLand();
  const grat = geoGraticule10();
  const make = (tag: string, cls: string, parent: Element = svg) => {
    const n = document.createElementNS(NS, tag);
    n.setAttribute('class', cls);
    parent.appendChild(n);
    return n;
  };
  const sphere = make('path', 'globe-sphere');
  const gratPath = make('path', 'globe-grat');
  const landPath = make('path', 'globe-land');
  const dotLayer = make('g', 'globe-dots');
  const rim = make('path', 'globe-rim');
  let dots: Dot[] = [];
  const dotEls: SVGCircleElement[] = [];

  function draw(cx: number, cy: number, r: number, rotate: Rotation) {
    projection.translate([cx, cy]).scale(r).rotate(rotate);
    const s = path({ type: 'Sphere' }) ?? '';
    sphere.setAttribute('d', s);
    rim.setAttribute('d', s);
    gratPath.setAttribute('d', path(grat) ?? '');
    landPath.setAttribute('d', path(land) ?? '');
    const centre: [number, number] = [-rotate[0], -rotate[1]];
    dots.forEach((d, i) => {
      const el = dotEls[i];
      const xy = projection([d.lon, d.lat]);
      const visible = angular([d.lon, d.lat], centre) < 88;
      if (xy && visible) {
        el.setAttribute('cx', xy[0].toFixed(1));
        el.setAttribute('cy', xy[1].toFixed(1));
        el.removeAttribute('visibility');
      } else {
        el.setAttribute('visibility', 'hidden');
      }
    });
  }

  function setDots(next: Dot[], radius = 7) {
    dots = next;
    while (dotEls.length < dots.length) dotEls.push(make('circle', 'globe-dot', dotLayer) as SVGCircleElement);
    dotEls.forEach((el, i) => {
      const d = dots[i];
      if (!d) {
        el.setAttribute('visibility', 'hidden');
        return;
      }
      el.setAttribute('r', String(radius));
      el.setAttribute('data-level', String(d.level));
    });
    dotEls.splice(dots.length).forEach((el) => el.remove());
  }

  return { draw, setDots, projection };
}

function angular([l1, p1]: [number, number], [l2, p2]: [number, number]): number {
  const r = Math.PI / 180;
  const c = Math.sin(p1 * r) * Math.sin(p2 * r) + Math.cos(p1 * r) * Math.cos(p2 * r) * Math.cos((l1 - l2) * r);
  return Math.acos(Math.max(-1, Math.min(1, c))) / r;
}

/* ---------- full-screen layer used by both halves of the transition ---------- */
function layer(existing?: HTMLElement | null) {
  const root = existing ?? document.createElement('div');
  if (!existing) {
    root.className = 'arrival';
    root.setAttribute('aria-hidden', 'true');
    document.body.appendChild(root);
  }
  root.replaceChildren();
  const sea = document.createElement('div');
  sea.className = 'arrival-sea';
  const svg = document.createElementNS(NS, 'svg') as SVGSVGElement;
  const W = window.innerWidth;
  const H = window.innerHeight;
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  root.append(sea, svg);
  return { root, sea, svg, W, H, globe: drawableGlobe(svg) };
}

/* ---------- hub → game ----------
   One continuous dive. The hub globe accelerates toward you (log-radius ease-in) and dissolves into
   open ocean; the game page opens on that same ocean and the globe pulls back out at the speed the
   dive ended with (log-radius ease-out), settling into the corner mini globe. The two durations are
   chosen so the zoom speed at the hand-off matches, which is what makes it read as one motion. */
let departing = false;
const DIVE_MS = 640;
const SURFACE_MS = 1000;
const DIVE_SPIN = 40; // degrees the globe turns while diving in

/** Quietly fetch a game page, its code and today's puzzle so the trip doesn't wait on the network. */
const warmed = new Set<string>();
export function warm(href: string) {
  if (warmed.has(href)) return;
  warmed.add(href);
  const hint = (rel: string, url: string, as?: string) => {
    if (warmed.has(url)) return;
    warmed.add(url);
    const l = document.createElement('link');
    l.rel = rel;
    l.href = url;
    if (as) l.as = as;
    document.head.append(l);
  };
  void fetch(href, { credentials: 'same-origin' })
    .then((r) => (r.ok ? r.text() : ''))
    .then((html) => {
      for (const m of html.matchAll(/(?:src|href)="(\/assets\/[^"]+\.(js|css))"/g)) hint(m[2] === 'js' ? 'modulepreload' : 'preload', m[1], m[2] === 'css' ? 'style' : undefined);
    })
    .catch(() => {});
  const game = href.split('/').filter(Boolean).pop() ?? '';
  const data = todayDataUrl(game);
  if (data) void fetch(data, { credentials: 'same-origin' }).catch(() => {});
}

export function depart(href: string, from: SVGSVGElement, rotate: Rotation, radiusRatio = 292 / 600) {
  if (departing) return;
  if (reducedMotion()) {
    window.location.href = href;
    return;
  }
  departing = true;
  warm(href);
  const L = layer();
  L.root.classList.add('is-departing');
  const box = from.getBoundingClientRect();
  const r0 = (box.width / 2) * (radiusRatio * 2);
  const c0 = [box.left + box.width / 2, box.top + box.height / 2];
  const c1 = [L.W / 2, L.H / 2];
  const rCover = Math.hypot(L.W, L.H) * 3;
  const page = [...document.querySelectorAll<HTMLElement>('.site-header, main, .site-footer')];

  // The game page picks up exactly where the dive leaves off.
  const finalRot: Rotation = [rotate[0] + DIVE_SPIN, rotate[1], 0];
  saveRotation(finalRot);

  L.sea.style.opacity = '0';
  L.globe.draw(c0[0], c0[1], r0, rotate);
  from.style.visibility = 'hidden';
  const fades = page.map((el) => el.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 300, easing: 'ease-out', fill: 'forwards' }));

  let navigated = false;
  void tween(DIVE_MS, (t) => {
    const zoom = t * t * t; // ease-in: always speeding up, so there's no stop before the cut
    const move = 1 - (1 - clamp01(t / 0.75)) ** 3; // reaches the centre early, then just dives
    L.globe.draw(lerp(c0[0], c1[0], move), lerp(c0[1], c1[1], move), zoomLerp(r0, rCover, zoom), [rotate[0] + DIVE_SPIN * t * t, rotate[1], 0]);
    // Behind the globe the page becomes ocean; then the globe dissolves into it.
    L.sea.style.opacity = String(clamp01((t - 0.25) / 0.35));
    L.svg.style.opacity = String(1 - clamp01((t - 0.62) / 0.28));
    // Leave as soon as the screen is ocean: the next page opens on the same colour.
    if (!navigated && t >= 0.88) {
      navigated = true;
      window.location.href = `${href}#arrive`;
    }
  });

  // Coming back with the browser's back button restores the page from cache: undo everything.
  window.addEventListener(
    'pageshow',
    (e) => {
      if (!e.persisted) return;
      departing = false;
      fades.forEach((a) => a.cancel());
      from.style.visibility = '';
      L.root.remove();
    },
    { once: true },
  );
}

/* ---------- the corner mini globe on game pages ---------- */
export function miniGlobe(container: HTMLElement) {
  const svg = document.createElementNS(NS, 'svg') as SVGSVGElement;
  svg.setAttribute('viewBox', '0 0 200 200');
  container.replaceChildren(svg);
  const g = drawableGlobe(svg);
  let rot: Rotation = loadRotation();
  let focusTween = 0;

  // No idle animation loop: the globe only redraws while it's turning to a new focus (saves battery).
  const render = () => g.draw(100, 100, 94, rot);
  render();

  /** Turn the globe to face a set of points (e.g. the countries just solved). */
  function focus(points: { lon: number; lat: number }[]) {
    if (!points.length) return;
    const target = centroid(points);
    const to: Rotation = [-target[0], Math.max(-55, Math.min(55, -target[1])), 0];
    const from = rot;
    // shortest way round
    const dl = wrap180(to[0] - from[0]);
    const id = ++focusTween;
    if (reducedMotion()) {
      rot = to;
      render();
    } else {
      void tween(1100, (t) => {
        if (id !== focusTween) return;
        const p = easeInOutCubic(t);
        rot = [from[0] + dl * p, lerp(from[1], to[1], p), 0];
        render();
      });
    }
  }

  function setDots(dots: Dot[]) {
    g.setDots(dots, 9);
    render();
  }

  return {
    svg,
    focus,
    setDots,
    get rotation() {
      return rot;
    },
    set rotation(r: Rotation) {
      rot = r;
      render();
    },
  };
}

function centroid(points: { lon: number; lat: number }[]): [number, number] {
  // Average on the sphere (via unit vectors) so it works across the date line.
  let x = 0;
  let y = 0;
  let z = 0;
  const r = Math.PI / 180;
  for (const p of points) {
    x += Math.cos(p.lat * r) * Math.cos(p.lon * r);
    y += Math.cos(p.lat * r) * Math.sin(p.lon * r);
    z += Math.sin(p.lat * r);
  }
  const lon = Math.atan2(y, x) / r;
  const lat = Math.atan2(z, Math.hypot(x, y)) / r;
  return [lon, lat];
}

/* ---------- game page: arrive from the hub ----------
   Starts the moment this module runs, before the game has fetched today's puzzle, so the pull-back
   follows the dive with no pause. The game's own mini globe takes over once it exists. */
const easeOutCubic = (t: number) => 1 - (1 - t) ** 3;
type Handoff = { mini: ReturnType<typeof miniGlobe>; container: HTMLElement };
let handoff: Handoff | null = null;
let surfacing: { done: boolean; finish: () => void } | null = null;

function surface() {
  const html = document.documentElement;
  if (window.location.hash !== '#arrive') return;
  history.replaceState(null, '', window.location.pathname + window.location.search);
  // From here on the JS controls the arrival, not the CSS :target failsafe.
  html.classList.add('arrival-done');
  const container = document.getElementById('mini-globe');
  // If the page's code arrived late, the CSS failsafe has already shown the page: don't replay over it.
  if (!container || reducedMotion() || performance.now() > 2200) return;

  html.classList.add('arrival-run');
  const L = layer(document.getElementById('arrive'));
  const start = loadRotation();
  const rStart = Math.hypot(L.W, L.H) * 3; // the same radius the dive ended at
  const c0 = [L.W / 2, L.H / 2];
  const state = {
    done: false,
    finish() {
      // Hold the last frame until the game's mini globe exists, then swap without a seam.
      if (!state.done || !handoff) return;
      L.root.style.display = 'none';
      html.classList.remove('arrival-reveal', 'arrival-run');
    },
  };
  surfacing = state;

  L.sea.style.opacity = '1';
  L.svg.style.opacity = '0';
  let revealed = false;
  void tween(SURFACE_MS, (t) => {
    const p = easeOutCubic(t); // starts at full speed, glides to a stop
    const box = container.getBoundingClientRect(); // live: the page may shift as the game loads
    const r1 = (box.width / 2) * 0.94;
    const c1 = [box.left + box.width / 2, box.top + box.height / 2];
    // Land on whatever the mini globe shows (it may already be turning to today's country),
    // unwinding one full turn on the way out in the same direction the dive was spinning.
    const target = handoff ? handoff.mini.rotation : start;
    const turn = wrap180(start[0] - target[0]) - 360;
    const rot: Rotation = [target[0] + turn * (1 - p), lerp(start[1], target[1], p), 0];
    const move = easeOutCubic(clamp01((t - 0.06) / 0.94));
    L.globe.draw(lerp(c0[0], c1[0], move), lerp(c0[1], c1[1], move), zoomLerp(rStart, r1, p), rot);
    // Mirror of the dive: the globe condenses out of the ocean, then the ocean clears.
    L.svg.style.opacity = String(clamp01(t / 0.1));
    L.sea.style.opacity = String(1 - clamp01((t - 0.12) / 0.3));
    if (!revealed && t > 0.22) {
      revealed = true;
      html.classList.add('arrival-reveal');
      html.classList.remove('arrival-run');
    }
  }).then(() => {
    state.done = true;
    state.finish();
  });
}
surface();

/** Called by each game once its mini globe exists: lets the arrival hand over to it. */
export async function arrive(mini: ReturnType<typeof miniGlobe>, container: HTMLElement): Promise<void> {
  handoff = { mini, container };
  document.documentElement.classList.add('arrival-done');
  surfacing?.finish();
}
