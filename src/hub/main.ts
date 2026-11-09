import '../shared/base';
import './hub.css';
import { geoOrthographic, geoPath, geoGraticule10, geoInterpolate } from 'd3-geo';
import type { LineString } from 'geojson';
import { getLand, reducedMotion } from '../shared/geo';
import { COUNTRIES } from '../data/countries';
import { haptic } from '../shared/haptics';
import { depart, type Rotation } from '../shared/travel';
import { GAMES, readToday, overall, bandOf } from '../shared/grades';
import { dayKey } from '../shared/daily';
import { watchDayChange } from '../shared/session';

/* ---------- Departures-board clock ---------- */
const clock = document.getElementById('clock');
if (clock) {
  const fmt = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' });
  const tick = () => (clock.textContent = fmt.format(new Date()));
  tick();
  setInterval(tick, 15_000);
}

// On click, not pointerdown: a finger that lands on a card only to scroll the page shouldn't buzz.
document.querySelectorAll('a.route-link, .hero-actions .btn').forEach((el) => el.addEventListener('click', () => haptic.tap()));

/* ---------- Today's report card (read from this browser only) ---------- */
/** Departures board: each route says whether today's game is done. */
function renderDepartures(results: ReturnType<typeof readToday>) {
  for (const g of GAMES) {
    const status = document.querySelector<HTMLElement>(`a[href="/games/${g.id}"] .route-status`);
    const text = status?.querySelector('.route-status-text');
    if (!status || !text) continue;
    const done = Boolean(results[g.id]);
    status.classList.toggle('is-done', done);
    text.textContent = done ? 'Played today' : 'Not played today';
  }
}

function renderReport() {
  const results = readToday();
  renderDepartures(results);
  const list = document.getElementById('report-list');
  if (!list) return;
  list.replaceChildren(
    ...GAMES.map((g) => {
      const r = results[g.id];
      const li = document.createElement('li');
      const a = document.createElement('a');
      a.href = `/games/${g.id}`;
      a.textContent = g.name;
      const chip = document.createElement('span');
      chip.className = 'report-chip';
      if (r) {
        chip.textContent = r.grade;
        chip.dataset.band = bandOf(r.grade);
        chip.title = `${r.pct}% of a perfect game`;
        chip.setAttribute('aria-label', `Grade ${r.grade}, ${r.pct}%`);
      } else {
        chip.classList.add('is-empty');
        chip.textContent = 'Not played';
      }
      li.append(a, chip);
      return li;
    }),
  );
  const total = overall(results);
  const played = Object.keys(results).length;
  const box = document.getElementById('report-overall')!;
  const letter = document.getElementById('report-letter')!;
  const sub = document.getElementById('report-sub')!;
  if (total) {
    box.dataset.band = bandOf(total.grade);
    letter.textContent = total.grade;
    letter.setAttribute('aria-label', `Overall grade ${total.grade}`);
    sub.textContent = played === GAMES.length ? `All six games done: ${total.pct}% overall. Come back tomorrow for a new trip.` : `${played} of ${GAMES.length} games played, ${total.pct}% so far.`;
  } else {
    delete box.dataset.band;
    letter.textContent = '–';
    sub.textContent = 'Play any game today and your grades show up here.';
  }
}
renderReport();
// Left open past midnight: start the new day with a fresh report card.
watchDayChange(dayKey());
// Coming back from a game with the back button restores this page from cache: refresh the grades.
window.addEventListener('pageshow', (e) => {
  if (e.persisted) renderReport();
});

/* ---------- Draggable globe ---------- */
const svg = document.getElementById('globe') as SVGSVGElement | null;
const globe = svg ? drawGlobe(svg) : null;

/* ---------- Travel into a game: the globe zooms in, the game page zooms back out ---------- */
// Delegated, so the report-card links (re-rendered when the page comes back from the cache) travel too.
document.addEventListener('click', (e) => {
  const link = (e.target as Element | null)?.closest?.<HTMLAnchorElement>('a[href^="/games/"]');
  if (!link || !svg || !globe || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  e.preventDefault();
  depart(link.getAttribute('href')!, svg, globe.rotation());
});

function drawGlobe(svg: SVGSVGElement) {
  const NS = 'http://www.w3.org/2000/svg';
  const size = 600;
  const projection = geoOrthographic()
    .scale(size / 2 - 8)
    .translate([size / 2, size / 2])
    .clipAngle(90)
    .precision(0.6)
    .rotate([-20, -18, 0]);
  // One decimal is plenty at this size and keeps each frame's path strings short.
  const path = geoPath(projection).digits(1);
  const land = getLand();
  const graticule = geoGraticule10();

  const el = (tag: string, cls: string) => {
    const node = document.createElementNS(NS, tag);
    node.setAttribute('class', cls);
    svg.appendChild(node);
    return node;
  };

  const sphere = el('path', 'globe-sphere');
  const grat = el('path', 'globe-grat');
  const landPath = el('path', 'globe-land');

  // Decorative "flight routes" between capitals, in the route-line colours.
  // Spain isn't in the country table, so add it locally for the decoration.
  const extra: Record<string, [number, number]> = { es: [-3.7, 40.42] };
  const coord = (c: string): [number, number] => extra[c] ?? [COUNTRIES[c].lon, COUNTRIES[c].lat];
  const routes = [
    ['gb', 'jp', '--signal'],
    ['br', 'za', '--route-1'],
    ['us', 'in', '--route-2'],
    ['eg', 'au', '--route-4'],
    ['mx', 'es', '--route-3'],
    ['ke', 'id', '--route-1'],
    ['ar', 'nz', '--route-2'],
  ].map(([a, b, color]) => {
    const interp = geoInterpolate(coord(a), coord(b));
    const line: LineString = { type: 'LineString', coordinates: Array.from({ length: 48 }, (_, i) => interp(i / 47)) };
    const arc = el('path', 'globe-arc');
    arc.setAttribute('stroke', `var(${color})`);
    const stops = [coord(a), coord(b)].map(() => {
      const dot = el('circle', 'globe-stop');
      dot.setAttribute('r', '5');
      dot.setAttribute('fill', `var(${color})`);
      return dot;
    });
    return { line, arc, stops, ends: [coord(a), coord(b)] as [number, number][] };
  });

  const rim = el('path', 'globe-rim');

  const render = () => {
    sphere.setAttribute('d', path({ type: 'Sphere' }) ?? '');
    rim.setAttribute('d', path({ type: 'Sphere' }) ?? '');
    grat.setAttribute('d', path(graticule) ?? '');
    landPath.setAttribute('d', path(land) ?? '');
    const [lambda, phi] = projection.rotate();
    const center: [number, number] = [-lambda, -phi];
    for (const r of routes) {
      r.arc.setAttribute('d', path(r.line) ?? '');
      r.ends.forEach((p, i) => {
        const visible = angularDistance(p, center) < 90;
        const xy = projection(p);
        const dot = r.stops[i];
        if (visible && xy) {
          dot.setAttribute('cx', xy[0].toFixed(1));
          dot.setAttribute('cy', xy[1].toFixed(1));
          dot.setAttribute('opacity', '1');
        } else {
          dot.setAttribute('opacity', '0');
        }
      });
    }
  };

  // Spin: slow idle rotation, drag with pointer capture, release with momentum.
  let velocity = reducedMotion() ? 0 : 0.06; // degrees per ms of longitude
  const idleSpeed = velocity; // reduced-motion visitors get a still globe they can drag
  let dragging = false;
  let lastX = 0;
  let lastY = 0;
  let lastT = 0;
  let pointerId: number | null = null;
  let buzzed = false;

  svg.addEventListener('pointerdown', (e) => {
    if (pointerId !== null) return; // ignore extra fingers
    pointerId = e.pointerId;
    dragging = true;
    svg.setPointerCapture(e.pointerId);
    lastX = e.clientX;
    lastY = e.clientY;
    lastT = performance.now();
    velocity = 0;
    buzzed = false;
    svg.closest('.hero-globe')?.setAttribute('data-touched', '');
  });
  svg.addEventListener('pointermove', (e) => {
    if (!dragging || e.pointerId !== pointerId) return;
    const now = performance.now();
    const k = 180 / (svg.getBoundingClientRect().width || size);
    const dx = (e.clientX - lastX) * k;
    const dy = (e.clientY - lastY) * k;
    // Buzz once the globe actually turns (a vertical swipe that scrolls the page never gets here).
    if (!buzzed && Math.abs(dx) > 0.5) {
      buzzed = true;
      haptic.select();
    }
    const [l, p] = projection.rotate();
    projection.rotate([l + dx, Math.max(-60, Math.min(60, p - dy)), 0]);
    velocity = dx / Math.max(1, now - lastT);
    lastX = e.clientX;
    lastY = e.clientY;
    lastT = now;
    render();
  });
  const release = (e: PointerEvent) => {
    if (e.pointerId !== pointerId) return;
    dragging = false;
    pointerId = null;
    wake(); // let the throw's momentum play out
  };
  svg.addEventListener('pointerup', release);
  svg.addEventListener('pointercancel', release);

  let prev = performance.now();
  const frame = (now: number) => {
    const dt = Math.min(48, now - prev);
    prev = now;
    if (!dragging) {
      // Momentum decays smoothly back toward the gentle idle spin.
      velocity += (idleSpeed - velocity) * Math.min(1, dt * 0.0025);
      if (Math.abs(velocity) > 0.0005) {
        const [l, p] = projection.rotate();
        projection.rotate([l + velocity * dt * 0.4, p, 0]);
        render();
      }
    }
    // Nothing left to animate (paused and settled): stop the loop entirely until something wakes it.
    const settled = !dragging && idleSpeed === 0 && Math.abs(velocity) <= 0.0005;
    if (!document.hidden && onScreen && !settled) requestAnimationFrame(frame);
    else running = false;
  };
  render();
  // Only animate while the globe is actually on screen and the tab is visible (saves battery on phones).
  let onScreen = true;
  let running = true;
  const wake = () => {
    if (running || document.hidden || !onScreen) return;
    running = true;
    prev = performance.now();
    requestAnimationFrame(frame);
  };
  new IntersectionObserver(([entry]) => {
    onScreen = entry.isIntersecting;
    wake();
  }).observe(svg);
  requestAnimationFrame(frame);
  document.addEventListener('visibilitychange', () => {
    wake();
  });
  return { rotation: () => projection.rotate() as Rotation };
}

function angularDistance([l1, p1]: [number, number], [l2, p2]: [number, number]): number {
  const r = Math.PI / 180;
  const c = Math.sin(p1 * r) * Math.sin(p2 * r) + Math.cos(p1 * r) * Math.cos(p2 * r) * Math.cos((l1 - l2) * r);
  return Math.acos(Math.max(-1, Math.min(1, c))) / r;
}

/* ---------- Recommendations form: posts to this site's own /api/feedback, which emails it on ---------- */
(() => {
  const form = document.getElementById('ideas-form') as HTMLFormElement | null;
  if (!form) return;
  const status = document.getElementById('ideas-status')!;
  const send = document.getElementById('ideas-send') as HTMLButtonElement;
  const message = document.getElementById('ideas-message') as HTMLTextAreaElement;
  const email = document.getElementById('ideas-email') as HTMLInputElement;
  const opened = performance.now();
  let sending = false;
  class ServerSaid extends Error {}
  const say = (text: string, kind: '' | 'ok' | 'error' = '') => {
    status.textContent = text;
    status.classList.toggle('is-ok', kind === 'ok');
    status.classList.toggle('is-error', kind === 'error');
  };
  // Once they start fixing what the error pointed at, clear it.
  form.addEventListener('input', () => {
    if (status.classList.contains('is-error')) say('');
  });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = message.value.trim();
    if (text.length < 5) {
      say('Please write a little more first.', 'error');
      message.focus();
      return;
    }
    if (email.value && !email.checkValidity()) {
      say('That email address looks off. You can also leave it blank.', 'error');
      email.focus();
      return;
    }
    if (sending) return; // a second tap or Enter while the first send is in flight
    const data = new FormData(form);
    sending = true;
    send.disabled = true;
    say('Sending…');
    try {
      const res = await fetch('/api/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({
          game: data.get('game'),
          message: text,
          email: email.value.trim(),
          website: data.get('website'),
          elapsed: Math.round(performance.now() - opened),
        }),
      });
      const body = (await res.json().catch(() => ({}))) as { error?: unknown };
      if (!res.ok) throw new ServerSaid(typeof body.error === 'string' ? body.error : '');
      form.reset();
      haptic.success();
      say('Thank you! Your recommendation is on its way.', 'ok');
    } catch (err) {
      haptic.error();
      // Only the server's own sentences are shown; browser network errors ("Failed to fetch",
      // Safari's "Load failed", Firefox's "NetworkError…") get one friendly line instead.
      const msg = err instanceof ServerSaid && err.message ? err.message : "Couldn't send right now. Please try again in a bit.";
      say(msg, 'error');
    } finally {
      sending = false;
      send.disabled = false;
    }
  });
})();
