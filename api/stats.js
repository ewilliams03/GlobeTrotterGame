// Private: returns the aggregate analytics for the owner's dashboard. Requires the ADMIN_KEY
// environment variable to be sent in the x-admin-key header. Only counts and averages exist.
import { timingSafeEqual } from 'node:crypto';
import { pipeline, redisReady, dayKey } from './_lib/redis.js';

const GAMES = ['globe-links', 'fact-or-fib', 'rank-the-world', 'mystery-passport', 'outline-sketch', 'flag-forge'];
const json = (status, body) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-robots-tag': 'noindex' },
  });

function authorised(request) {
  const want = process.env.ADMIN_KEY || '';
  const got = request.headers.get('x-admin-key') || '';
  if (want.length < 8 || got.length !== want.length) return false;
  return timingSafeEqual(Buffer.from(got), Buffer.from(want));
}

// Redis hashes come back as [field, value, field, value, ...].
const hashToObj = (arr) => {
  const o = {};
  if (Array.isArray(arr)) for (let i = 0; i < arr.length; i += 2) o[arr[i]] = Number(arr[i + 1]) || 0;
  return o;
};
const addInto = (into, obj) => {
  for (const [k, v] of Object.entries(obj)) into[k] = (into[k] || 0) + v;
  return into;
};

export async function GET(request) {
  if (!authorised(request)) return json(401, { error: 'Wrong or missing key.' });
  if (!redisReady()) return json(503, { error: 'Analytics storage is not connected yet.' });

  const daysWanted = Math.min(Math.max(Number(new URL(request.url).searchParams.get('days')) || 30, 1), 365);
  const days = [];
  for (let i = daysWanted - 1; i >= 0; i--) days.push(dayKey(new Date(Date.now() - i * 86_400_000)));
  // Daylight-saving shifts can repeat a date; keep each once.
  const uniqDays = [...new Set(days)];

  const PER_DAY = ['hll:v', 'hll:p', 'views', 'secs', 'fb', 'pages', 'refs', 'dev', 'fin', 'pct', 'gsecs', 'gsecsn', ...GAMES.map((g) => `grades:${g}`)];
  const cmds = [];
  for (const d of uniqDays) {
    const k = (s) => `d:${d}:${s}`;
    cmds.push(
      ['PFCOUNT', k('hll:v')],
      ['PFCOUNT', k('hll:p')],
      ['GET', k('views')],
      ['GET', k('secs')],
      ['GET', k('fb')],
      ['HGETALL', k('pages')],
      ['HGETALL', k('refs')],
      ['HGETALL', k('dev')],
      ['HGETALL', k('fin')],
      ['HGETALL', k('pct')],
      ['HGETALL', k('gsecs')],
      ['HGETALL', k('gsecsn')],
      ...GAMES.map((g) => ['HGETALL', k(`grades:${g}`)]),
    );
  }
  // Unique visitors across the whole range (a union of the daily counters).
  cmds.push(['PFCOUNT', ...uniqDays.map((d) => `d:${d}:hll:v`)]);
  cmds.push(['PFCOUNT', ...uniqDays.map((d) => `d:${d}:hll:p`)]);
  for (const g of GAMES) cmds.push(['HGETALL', `pz:${g}`]);

  let r;
  try {
    r = await pipeline(cmds);
  } catch {
    return json(502, { error: 'Could not read analytics storage.' });
  }

  const totals = { pages: {}, refs: {}, dev: {}, fin: {}, pct: {}, gsecs: {}, gsecsn: {}, grades: Object.fromEntries(GAMES.map((g) => [g, {}])) };
  const series = uniqDays.map((d, i) => {
    const o = r.slice(i * PER_DAY.length, (i + 1) * PER_DAY.length);
    const fin = hashToObj(o[8]);
    addInto(totals.pages, hashToObj(o[5]));
    addInto(totals.refs, hashToObj(o[6]));
    addInto(totals.dev, hashToObj(o[7]));
    addInto(totals.fin, fin);
    addInto(totals.pct, hashToObj(o[9]));
    addInto(totals.gsecs, hashToObj(o[10]));
    addInto(totals.gsecsn, hashToObj(o[11]));
    GAMES.forEach((g, gi) => addInto(totals.grades[g], hashToObj(o[12 + gi])));
    return {
      day: d,
      visitors: Number(o[0]) || 0,
      players: Number(o[1]) || 0,
      views: Number(o[2]) || 0,
      secs: Number(o[3]) || 0,
      feedback: Number(o[4]) || 0,
      games: Object.values(fin).reduce((a, b) => a + b, 0),
    };
  });
  const base = uniqDays.length * PER_DAY.length;
  const visitors = Number(r[base]) || 0;
  const players = Number(r[base + 1]) || 0;

  const games = GAMES.map((g, gi) => {
    const n = totals.fin[g] || 0;
    const pz = hashToObj(r[base + 2 + gi]);
    const puzzles = Object.keys(pz)
      .filter((f) => f.endsWith(':n'))
      .map((f) => {
        const no = Number(f.split(':')[0]);
        const count = pz[f];
        return { puzzle: no, plays: count, avg: count ? Math.round(pz[`${no}:sum`] / count) : 0 };
      })
      .filter((p) => p.plays >= 1)
      .sort((a, b) => a.puzzle - b.puzzle);
    return {
      id: g,
      finishes: n,
      avgPct: n ? Math.round((totals.pct[g] || 0) / n) : null,
      avgSecs: totals.gsecsn[g] ? Math.round(totals.gsecs[g] / totals.gsecsn[g]) : null,
      grades: totals.grades[g],
      puzzles,
    };
  });

  const sum = (key) => series.reduce((a, d) => a + d[key], 0);
  return json(200, {
    range: { from: uniqDays[0], to: uniqDays[uniqDays.length - 1], days: uniqDays.length },
    summary: {
      visitors,
      players,
      views: sum('views'),
      games: sum('games'),
      feedback: sum('feedback'),
      secs: sum('secs'),
      // Daily visitors summed (a person counted once per day they came), used for per-visit averages.
      visitorDays: sum('visitors'),
    },
    series,
    pages: totals.pages,
    refs: totals.refs,
    devices: totals.dev,
    games,
  });
}
