// Turns each game's content bank into one small JSON document per day.
// The site never ships the whole bank: a game page fetches only /data/<game>/<n>.json for today,
// so the bank can grow to thousands of puzzles without making any page heavier.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const json = (root, p) => JSON.parse(readFileSync(join(root, p), 'utf8'));

export function buildBanks(root) {
  const cats = json(root, 'src/games/globe-links/categories.json');
  const rank = json(root, 'src/games/rank-the-world/rank.json');
  const passport = json(root, 'src/games/mystery-passport/passport.json');

  return {
    'globe-links': json(root, 'src/games/globe-links/puzzles.json').map((p) => ({
      groups: p.groups.map((g) => ({ ...g, label: cats[g.category].label })),
    })),

    'fact-or-fib': json(root, 'src/games/fact-or-fib/facts.json'),

    // Each day carries only the stat values its own rounds need.
    'rank-the-world': rank.days.map((day) => {
      const stats = {};
      for (const r of day.rounds) {
        const s = rank.stats[r.stat];
        const pick = (obj) => (obj ? Object.fromEntries(r.countries.filter((c) => c in obj).map((c) => [c, obj[c]])) : undefined);
        const prev = stats[r.stat];
        stats[r.stat] = {
          ...s,
          values: s.values ? { ...prev?.values, ...pick(s.values) } : undefined,
          labels: s.labels ? { ...prev?.labels, ...pick(s.labels) } : undefined,
        };
      }
      return { rounds: day.rounds, stats };
    }),

    'mystery-passport': passport.days.map((day) => ({ costs: passport.costs, countries: day.countries })),

    'outline-sketch': buildOutlineDays(root),

    'flag-forge': (() => {
      const ff = json(root, 'src/games/flag-forge/flags.json');
      const worldTs = readFileSync(join(root, 'src/data/world.ts'), 'utf8');
      const names = Object.fromEntries([...worldTs.matchAll(/^  ([a-z]{2}): \{ name: (['"])(.*?)\2/gm)].map((m) => [m[1], m[3]]));
      return ff.days.map((codes) => ({
        flags: codes.map((code) => ({ code, name: names[code], spec: ff.flags[code], sourceUrl: `https://en.wikipedia.org/wiki/${ff.sources[code]}` })),
      }));
    })(),
  };
}

/* ---------- Outline Sketch: cut each day's map out of Natural Earth 1:50m ---------- */
let outlineCache = null;
function buildOutlineDays(root) {
  if (outlineCache) return outlineCache;
  const { feature } = require('topojson-client');
  const topo = json(root, 'node_modules/world-atlas/countries-50m.json');
  const all = feature(topo, topo.objects.countries).features;
  const cfg = json(root, 'src/games/outline-sketch/outline.json');
  const worldTs = readFileSync(join(root, 'src/data/world.ts'), 'utf8');
  const names = Object.fromEntries([...worldTs.matchAll(/^  ([a-z]{2}): \{ name: (['"])(.*?)\2/gm)].map((m) => [m[1], m[3]]));
  const countriesTs = readFileSync(join(root, 'src/data/countries.ts'), 'utf8');
  const capitals = Object.fromEntries([...countriesTs.matchAll(/^  ([a-z]{2}): \{ name: .*?lat: (-?[\d.]+), lon: (-?[\d.]+)/gm)].map((m) => [m[1], [Number(m[3]), Number(m[2])]]));
  // Only label land with an unambiguous, recognised country name (keeps maps neutral).
  const known = new Set(Object.values(names));
  const fix = { 'United States of America': 'United States', Turkey: 'Türkiye', 'Dem. Rep. Congo': 'DR Congo', 'Central African Rep.': 'Central African Republic', 'Eq. Guinea': 'Equatorial Guinea', 'S. Sudan': 'South Sudan', 'Bosnia and Herz.': 'Bosnia and Herzegovina', "Côte d'Ivoire": "Côte d'Ivoire", Macedonia: 'North Macedonia', 'Czech Rep.': 'Czechia', 'Dominican Rep.': 'Dominican Republic', eSwatini: 'Eswatini', Gambia: 'The Gambia' };

  const polys = (g) => (g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : []);
  const ringArea = (r) => Math.abs(r.reduce((a, p, i) => { const q = r[(i + 1) % r.length]; return a + p[0] * q[1] - q[0] * p[1]; }, 0) / 2);
  const ringCentre = (r) => [r.reduce((a, p) => a + p[0], 0) / r.length, r.reduce((a, p) => a + p[1], 0) / r.length];
  const r3 = (n) => Math.round(n * 1000) / 1000;
  const r2 = (n) => Math.round(n * 100) / 100;

  function simplify(ring, tol, round = r3) {
    const out = [ring[0]];
    for (let i = 1; i < ring.length - 1; i++) {
      const last = out[out.length - 1];
      if (Math.hypot(ring[i][0] - last[0], ring[i][1] - last[1]) >= tol) out.push(ring[i]);
    }
    out.push(ring[ring.length - 1]);
    return out.length >= 4 ? out.map(([x, y]) => [round(x), round(y)]) : null;
  }

  // Sutherland–Hodgman clip of a ring to a lon/lat rectangle.
  function clip(ring, [x0, y0, x1, y1]) {
    const edges = [
      [(p) => p[0] >= x0, (a, b) => [x0, a[1] + ((b[1] - a[1]) * (x0 - a[0])) / (b[0] - a[0])]],
      [(p) => p[0] <= x1, (a, b) => [x1, a[1] + ((b[1] - a[1]) * (x1 - a[0])) / (b[0] - a[0])]],
      [(p) => p[1] >= y0, (a, b) => [a[0] + ((b[0] - a[0]) * (y0 - a[1])) / (b[1] - a[1]), y0]],
      [(p) => p[1] <= y1, (a, b) => [a[0] + ((b[0] - a[0]) * (y1 - a[1])) / (b[1] - a[1]), y1]],
    ];
    let pts = ring.slice(0, -1);
    for (const [inside, cut] of edges) {
      const next = [];
      for (let i = 0; i < pts.length; i++) {
        const a = pts[i];
        const b = pts[(i + 1) % pts.length];
        if (inside(a)) {
          next.push(a);
          if (!inside(b)) next.push(cut(a, b));
        } else if (inside(b)) next.push(cut(a, b));
      }
      pts = next;
      if (!pts.length) return null;
    }
    return pts.length >= 3 ? [...pts, pts[0]] : null;
  }

  // Main-body outline of one country, simplified. `detail` scales the simplification tolerance.
  const shapeOf = (code, detail = 1) => {
      const f = all.find((x) => x.id === cfg.numeric[code]);
      if (!f) throw new Error(`outline-sketch: no shape for ${code}`);
      // Keep the main body: the largest polygon plus nearby ones of meaningful size (drops far-off territories).
      const ps = polys(f.geometry).map((p) => ({ p, area: ringArea(p[0]), c: ringCentre(p[0]) })).sort((a, b) => b.area - a.area);
      const main = ps.filter((x) => x === ps[0] || (x.area >= ps[0].area * 0.004 && Math.hypot(x.c[0] - ps[0].c[0], x.c[1] - ps[0].c[1]) < 12));
      const xs = main.flatMap((x) => x.p[0].map((q) => q[0]));
      const ys = main.flatMap((x) => x.p[0].map((q) => q[1]));
      const [w, e, s, n] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
      const span = Math.max(e - w, n - s);
      const pad = span * 0.45;
      const view = [w - pad, s - pad * 0.8, e + pad, n + pad * 0.8];
      // Clip a little beyond the view so wide screens still see land at the edges.
      const clipBox = [view[0] - span * 0.6, Math.max(-85, view[1] - span * 0.35), view[2] + span * 0.6, Math.min(85, view[3] + span * 0.35)];
      const tol = span * 0.007;
      const minArea = (tol * 3) ** 2;
      return {
        type: 'MultiPolygon',
        coordinates: main.map((x) => x.p.map((r) => simplify(r, tol * 0.5 * detail)).filter(Boolean)).filter((p) => p.length),
      };
  };

  // Decoy outlines come from the same pool of countries, picked by a fixed seed so every
  // player sees the same four choices on a given day.
  const pool = Object.keys(cfg.numeric);
  const rand = (seed) => () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  outlineCache = cfg.days.map((codes, d) => ({
    countries: codes.map((code, k) => {
      const next = rand(d * 97 + k * 13 + 7);
      const decoys = [];
      while (decoys.length < 3) {
        const c = pool[Math.floor(next() * pool.length)];
        if (!codes.includes(c) && !decoys.includes(c)) decoys.push(c);
      }
      const options = [code, ...decoys].sort(() => next() - 0.5);
      return {
        code,
        name: names[code],
        target: shapeOf(code),
        options: options.map((c) => ({ code: c, shape: c === code ? null : shapeOf(c, 2.5) })),
      };
    }),
  }));
  return outlineCache;
}

export const bankSizes = (banks) => Object.fromEntries(Object.entries(banks).map(([k, v]) => [k, v.length]));
