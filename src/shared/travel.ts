// The "travel" transition between the hub and a game:
//   hub:  the spinning globe flies to the centre and zooms in until the ocean fills the screen
//   game: the globe zooms back out of the ocean and settles into the corner mini globe
// Pure SVG redrawn every frame (crisp at any scale), works in every modern browser,
// and is skipped entirely for reduced-motion users.
import { geoOrthographic, geoPath, geoGraticule10 } from 'd3-geo';
import { getLand, reducedMotion } from './geo';

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
const easeOutQuart = (t: number) => 1 - (1 - t) ** 4;
const easeInQuad = (t: number) => t * t;
const clamp01 = (t: number) => Math.max(0, Math.min(1, t));
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
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

/* ---------- hub → game ---------- */
let departing = false;

export function depart(href: string, from: SVGSVGElement, rotate: Rotation, radiusRatio = 292 / 600) {
  if (departing) return;
  if (reducedMotion()) {
    window.location.href = href;
    return;
  }
  departing = true;
  const L = layer();
  L.root.classList.add('is-departing');
  const box = from.getBoundingClientRect();
  const r0 = (box.width / 2) * (radiusRatio * 2);
  const c0 = [box.left + box.width / 2, box.top + box.height / 2];
  const c1 = [L.W / 2, L.H / 2];
  const r1 = Math.hypot(L.W, L.H) * 0.62;
  const page = [...document.querySelectorAll<HTMLElement>('.site-header, main, .site-footer')];

  L.sea.style.opacity = '0';
  L.globe.draw(c0[0], c0[1], r0, rotate);
  from.style.visibility = 'hidden';
  const fades = page.map((el) =>
    el.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 380, easing: 'ease-out', fill: 'forwards' }),
  );

  let finalRot = rotate;
  void tween(820, (t) => {
    const p = easeInOutCubic(t);
    finalRot = [rotate[0] + 70 * easeInQuad(t), rotate[1], 0];
    L.globe.draw(lerp(c0[0], c1[0], p), lerp(c0[1], c1[1], p), zoomLerp(r0, r1 * 2.4, easeInQuad(t) * 0.55 + p * 0.45), finalRot);
    L.sea.style.opacity = String(clamp01((t - 0.62) / 0.3));
  }).then(() => {
    saveRotation(finalRot);
    window.location.href = `${href}#arrive`;
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
    const dl = ((to[0] - from[0] + 540) % 360) - 180;
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

/* ---------- game page: arrive from the hub ---------- */
export async function arrive(mini: ReturnType<typeof miniGlobe>, container: HTMLElement): Promise<void> {
  const html = document.documentElement;
  const arriving = window.location.hash === '#arrive';
  if (arriving) history.replaceState(null, '', window.location.pathname + window.location.search);
  // From here on the JS controls the arrival, not the CSS :target failsafe.
  html.classList.add('arrival-done');
  // If today's puzzle took a while to load, the CSS failsafe has already shown the page: don't replay.
  if (!arriving || reducedMotion() || performance.now() > 2200) return;

  html.classList.add('arrival-run');
  const L = layer(document.getElementById('arrive'));
  const start = loadRotation();
  const box = container.getBoundingClientRect();
  const c1 = [box.left + box.width / 2, box.top + box.height / 2];
  const r1 = (box.width / 2) * 0.94;
  const c0 = [L.W / 2, L.H / 2];
  const r0 = Math.hypot(L.W, L.H) * 1.5;
  // Land exactly on whatever the mini globe is showing (it may itself be turning to a country),
  // with one extra full turn on the way out.
  const first = mini.rotation;
  const offset = ((start[0] - first[0] + 540) % 360) - 180 - 360;

  L.svg.style.opacity = '0';
  let revealed = false;
  await tween(1150, (t) => {
    const p = easeOutQuart(t);
    const target = mini.rotation;
    const rot: Rotation = [target[0] + offset * (1 - p), lerp(start[1], target[1], p), 0];
    const move = easeInOutCubic(clamp01((t - 0.05) / 0.95));
    L.globe.draw(lerp(c0[0], c1[0], move), lerp(c0[1], c1[1], move), zoomLerp(r0, r1, p), rot);
    L.svg.style.opacity = String(clamp01(t / 0.12));
    L.sea.style.opacity = String(1 - clamp01((t - 0.12) / 0.32));
    if (!revealed && t > 0.3) {
      revealed = true;
      html.classList.add('arrival-reveal');
      html.classList.remove('arrival-run');
    }
  });
  L.root.style.display = 'none';
  html.classList.remove('arrival-reveal');
}

