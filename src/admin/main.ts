// Owner dashboard: reads /api/stats with the admin key and draws the anonymous analytics.
import '@fontsource-variable/bricolage-grotesque';
import '@fontsource-variable/instrument-sans';
import '@fontsource-variable/jetbrains-mono';
import '../shared/base.css';
import './admin.css';

const GAME_NAMES: Record<string, string> = {
  'globe-links': 'Globe Links',
  'fact-or-fib': 'Fact or Fib',
  'rank-the-world': 'Rank the World',
  'mystery-passport': 'Mystery Passport',
  'outline-sketch': 'Outline Drop',
  'flag-forge': 'Flag Forge',
};
const PAGE_NAMES: Record<string, string> = { '/': 'Home', '/about': 'About', '/privacy': 'Privacy', '/terms': 'Terms', other: 'Other' };
const GRADE_BANDS = ['A', 'B', 'C', 'D', 'F'] as const;

interface Day { day: string; visitors: number; players: number; views: number; secs: number; feedback: number; games: number }
interface Game { id: string; finishes: number; avgPct: number | null; avgSecs: number | null; grades: Record<string, number>; puzzles: { puzzle: number; plays: number; avg: number }[] }
interface Stats {
  range: { from: string; to: string; days: number };
  summary: { visitors: number; players: number; views: number; games: number; feedback: number; secs: number; visitorDays: number };
  series: Day[];
  pages: Record<string, number>;
  refs: Record<string, number>;
  devices: Record<string, number>;
  games: Game[];
}

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const NS = 'http://www.w3.org/2000/svg';
const KEY_STORE = 'gg-admin-key';
let key = '';
let days = 30;
let timer = 0;

const fmt = (n: number) => n.toLocaleString();
const fmtTime = (s: number) => (s < 60 ? `${Math.round(s)}s` : `${Math.floor(s / 60)}m ${String(Math.round(s % 60)).padStart(2, '0')}s`);
const shortDay = (d: string) => new Date(`${d}T12:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
const h = <K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text = '') => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text) n.textContent = text;
  return n;
};
const svgEl = (tag: string, attrs: Record<string, string | number>) => {
  const n = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, String(v));
  return n;
};

/* ---------- Tooltip ---------- */
const tip = $('tip');
function showTip(e: PointerEvent | FocusEvent, text: string) {
  tip.textContent = text;
  tip.hidden = false;
  const r = (e.target as Element).getBoundingClientRect();
  const x = 'clientX' in e && e.clientX ? e.clientX : r.left + r.width / 2;
  const y = r.top;
  tip.style.left = `${Math.min(Math.max(8, x - tip.offsetWidth / 2), innerWidth - tip.offsetWidth - 8)}px`;
  tip.style.top = `${Math.max(8, y - tip.offsetHeight - 8) + scrollY}px`;
}
const hideTip = () => (tip.hidden = true);
function hoverable(el: Element, text: string) {
  el.setAttribute('tabindex', '0');
  el.setAttribute('aria-label', text);
  el.addEventListener('pointerenter', (e) => showTip(e as PointerEvent, text));
  el.addEventListener('pointermove', (e) => showTip(e as PointerEvent, text));
  el.addEventListener('pointerleave', hideTip);
  el.addEventListener('focus', (e) => showTip(e as FocusEvent, text));
  el.addEventListener('blur', hideTip);
}

/* ---------- Charts ---------- */
/** Single-series column chart over days: one hue, thin columns, recessive grid, hover per column. */
function columns(target: HTMLElement, data: Day[], value: (d: Day) => number, unit: string) {
  const W = 640;
  const H = 180;
  const padL = 34;
  const padB = 22;
  const max = Math.max(1, ...data.map(value));
  const nice = (() => {
    const step = 10 ** Math.floor(Math.log10(max));
    return Math.ceil(max / step) * step;
  })();
  const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, class: 'ad-svg', role: 'img', 'aria-label': `${unit} per day` });
  for (const f of [0, 0.5, 1]) {
    const y = H - padB - f * (H - padB - 8);
    svg.append(svgEl('line', { x1: padL, x2: W, y1: y, y2: y, class: 'ad-grid-line' }));
    const t = svgEl('text', { x: padL - 6, y: y + 4, class: 'ad-axis', 'text-anchor': 'end' });
    t.textContent = fmt(Math.round(nice * f));
    svg.append(t);
  }
  const slot = (W - padL) / data.length;
  const bw = Math.max(2, Math.min(28, slot - 2));
  data.forEach((d, i) => {
    const v = value(d);
    const bh = (v / nice) * (H - padB - 8);
    const x = padL + i * slot + (slot - bw) / 2;
    const y = H - padB - bh;
    // Rounded top, square base anchored to the baseline.
    const r = Math.min(4, bw / 2, bh);
    const path = bh > 0 ? `M${x} ${H - padB}V${y + r}Q${x} ${y} ${x + r} ${y}H${x + bw - r}Q${x + bw} ${y} ${x + bw} ${y + r}V${H - padB}Z` : '';
    if (path) svg.append(svgEl('path', { d: path, class: 'ad-bar' }));
    // A full-height hit target, bigger than the mark.
    const hit = svgEl('rect', { x: padL + i * slot, y: 0, width: slot, height: H - padB, class: 'ad-hit' });
    hoverable(hit, `${shortDay(d.day)}: ${fmt(v)} ${unit}`);
    svg.append(hit);
  });
  const labels = data.length <= 10 ? data.map((_, i) => i) : [0, Math.floor(data.length / 2), data.length - 1];
  for (const i of labels) {
    const t = svgEl('text', { x: padL + i * slot + slot / 2, y: H - 6, class: 'ad-axis', 'text-anchor': 'middle' });
    t.textContent = shortDay(data[i].day);
    svg.append(t);
  }
  target.replaceChildren(svg);
}

/** Ranked horizontal bars for a breakdown (sources, pages, devices). */
function ranked(target: HTMLElement, obj: Record<string, number>, label: (k: string) => string, limit = 8) {
  const rows = Object.entries(obj).sort((a, b) => b[1] - a[1]);
  if (!rows.length) return target.replaceChildren(h('p', 'ad-empty', 'No data yet.'));
  const total = rows.reduce((a, [, v]) => a + v, 0);
  const shown = rows.slice(0, limit);
  const rest = rows.slice(limit).reduce((a, [, v]) => a + v, 0);
  if (rest) shown.push(['__other', rest]);
  const max = shown[0][1];
  const list = h('ol', 'ad-ranked');
  for (const [k, v] of shown) {
    const li = h('li');
    const name = h('span', 'ad-r-name', k === '__other' ? 'Everything else' : label(k));
    const track = h('span', 'ad-r-track');
    const fill = h('span', 'ad-r-fill');
    fill.style.width = `${Math.max(2, (v / max) * 100)}%`;
    track.append(fill);
    const val = h('span', 'ad-r-val', `${fmt(v)} · ${Math.round((v / total) * 100)}%`);
    li.append(name, track, val);
    list.append(li);
  }
  target.replaceChildren(list);
}

/* ---------- Render ---------- */
function kpi(label: string, value: string, note = '') {
  const d = h('div', 'ad-kpi');
  d.append(h('p', 'ad-kpi-label', label), h('p', 'ad-kpi-value', value));
  if (note) d.append(h('p', 'ad-kpi-note', note));
  return d;
}

function render(s: Stats) {
  const sum = s.summary;
  $('range-label').textContent = days === 1 ? 'Today' : `Last ${s.range.days} days · ${shortDay(s.range.from)} to ${shortDay(s.range.to)}`;
  const perVisit = sum.visitorDays ? sum.secs / sum.visitorDays : 0;
  const gamesPerPlayer = sum.players ? sum.games / sum.players : 0;
  const avgScore = sum.games ? Math.round(s.games.reduce((a, g) => a + (g.avgPct ?? 0) * g.finishes, 0) / sum.games) : null;
  $('kpis').replaceChildren(
    kpi('Visitors', fmt(sum.visitors), days === 1 ? 'unique today' : 'unique in this range'),
    kpi('Games finished', fmt(sum.games)),
    kpi('Games per player', gamesPerPlayer ? gamesPerPlayer.toFixed(1) : '–', `${fmt(sum.players)} people finished a game`),
    kpi('Time on site', perVisit ? fmtTime(perVisit) : '–', 'average per visitor per day'),
    kpi('Average score', avgScore === null ? '–' : `${avgScore}%`, 'across all finished games'),
    kpi('Page views', fmt(sum.views), `${fmt(sum.feedback)} recommendations sent`),
  );

  columns($('chart-visitors'), s.series, (d) => d.visitors, 'visitors');
  columns($('chart-games'), s.series, (d) => d.games, 'games finished');

  // Games table with a grade-spread bar (A darkest to F lightest, one hue: it's an ordered scale).
  const table = h('table', 'ad-table');
  const head = h('tr');
  ['Game', 'Finished', 'Avg score', 'Avg time', 'Grades'].forEach((t) => head.append(h('th', '', t)));
  table.append(head);
  for (const g of [...s.games].sort((a, b) => b.finishes - a.finishes)) {
    const tr = h('tr');
    tr.append(
      h('td', 'ad-t-name', GAME_NAMES[g.id] ?? g.id),
      h('td', 'ad-num', fmt(g.finishes)),
      h('td', 'ad-num', g.avgPct === null ? '–' : `${g.avgPct}%`),
      h('td', 'ad-num', g.avgSecs === null ? '–' : fmtTime(g.avgSecs)),
    );
    const cell = h('td');
    const bands: Record<string, number> = { A: 0, B: 0, C: 0, D: 0, F: 0 };
    for (const [grade, n] of Object.entries(g.grades)) bands[grade[0]] = (bands[grade[0]] ?? 0) + n;
    const total = Object.values(bands).reduce((a, b) => a + b, 0);
    if (total) {
      const bar = h('div', 'ad-spread');
      for (const b of GRADE_BANDS) {
        if (!bands[b]) continue;
        const seg = h('span', `ad-seg-${b}`);
        seg.style.flexGrow = String(bands[b]);
        hoverable(seg, `${GAME_NAMES[g.id]}: ${bands[b]} ${b} grade${bands[b] === 1 ? '' : 's'} (${Math.round((bands[b] / total) * 100)}%)`);
        bar.append(seg);
      }
      cell.append(bar);
    } else cell.append(h('span', 'ad-empty', 'No games yet'));
    tr.append(cell);
    table.append(tr);
  }
  const legend = h('p', 'ad-legend');
  for (const b of GRADE_BANDS) {
    const k = h('span', 'ad-key');
    k.append(h('i', `ad-seg-${b}`), document.createTextNode(b));
    legend.append(k);
  }
  const wrap = h('div', 'ad-table-wrap');
  wrap.append(table);
  $('games-table').replaceChildren(wrap, legend);

  ranked($('refs'), s.refs, (k) => (k === 'direct' ? 'Direct or unknown' : k));
  ranked($('pages'), s.pages, (k) => PAGE_NAMES[k] ?? GAME_NAMES[k.replace('/games/', '')] ?? k);
  ranked($('devices'), s.devices, (k) => k[0].toUpperCase() + k.slice(1));

  // Hardest and easiest puzzles per game.
  const pz = h('div', 'ad-puzzles');
  for (const g of s.games) {
    const played = g.puzzles.filter((p) => p.plays >= 2).sort((a, b) => a.avg - b.avg);
    if (!played.length) continue;
    const box = h('div', 'ad-pz');
    box.append(h('h3', '', GAME_NAMES[g.id] ?? g.id));
    const hard = played[0];
    const easy = played[played.length - 1];
    box.append(h('p', '', `Hardest: No. ${hard.puzzle}, ${hard.avg}% avg (${hard.plays} plays)`));
    if (easy !== hard) box.append(h('p', '', `Easiest: No. ${easy.puzzle}, ${easy.avg}% avg (${easy.plays} plays)`));
    pz.append(box);
  }
  $('puzzles').replaceChildren(pz.childElementCount ? pz : h('p', 'ad-empty', 'Not enough plays yet.'));

  $('updated').textContent = `Live · updated ${new Date().toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}, refreshes every minute`;
}

/* ---------- Data + login ---------- */
async function load(): Promise<boolean> {
  const res = await fetch(`/api/stats?days=${days}`, { headers: { 'x-admin-key': key }, cache: 'no-store' }).catch(() => null);
  if (!res) {
    $('updated').textContent = 'Offline. Retrying in a minute.';
    return true;
  }
  if (res.status === 401) return false;
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    $('updated').textContent = (body as { error?: string }).error ?? 'Something went wrong.';
    return true;
  }
  render(body as Stats);
  return true;
}

async function open() {
  const ok = await load();
  if (!ok) {
    sessionStorage.removeItem(KEY_STORE);
    try {
      localStorage.removeItem(KEY_STORE);
    } catch {
      /* ignore */
    }
    $('login').hidden = false;
    $('board').hidden = true;
    $('login-error').textContent = 'That key is not right.';
    return;
  }
  $('login').hidden = true;
  $('board').hidden = false;
  clearInterval(timer);
  timer = window.setInterval(() => !document.hidden && void load(), 60_000);
}

$('login-form').addEventListener('submit', (e) => {
  e.preventDefault();
  key = $<HTMLInputElement>('key').value.trim();
  if (!key) return;
  sessionStorage.setItem(KEY_STORE, key);
  if ($<HTMLInputElement>('remember').checked) {
    try {
      localStorage.setItem(KEY_STORE, key);
    } catch {
      /* ignore */
    }
  }
  $('login-error').textContent = '';
  void open();
});
$('logout').addEventListener('click', () => {
  sessionStorage.removeItem(KEY_STORE);
  try {
    localStorage.removeItem(KEY_STORE);
  } catch {
    /* ignore */
  }
  clearInterval(timer);
  key = '';
  $('board').hidden = true;
  $('login').hidden = false;
});
document.querySelectorAll<HTMLButtonElement>('.ad-seg button').forEach((b) =>
  b.addEventListener('click', () => {
    days = Number(b.dataset.days);
    document.querySelectorAll('.ad-seg button').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    void load();
  }),
);

try {
  key = sessionStorage.getItem(KEY_STORE) || localStorage.getItem(KEY_STORE) || '';
} catch {
  key = '';
}
if (key) void open();
