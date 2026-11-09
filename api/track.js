// Anonymous, aggregate analytics. Nothing here identifies a person:
// - no cookies, nothing stored in the visitor's browser
// - unique visitors are counted by adding a one-way hash of (daily secret + IP + browser) to a
//   Redis HyperLogLog, which can only report "how many distinct", never list them; the secret
//   changes every day, so the same visitor can't be linked across days, and the IP is never stored
// - games send only: which game, score %, puzzle number, seconds taken
import { createHash } from 'node:crypto';
import { pipeline, redisReady, redisSecret, dayKey, TTL } from './_lib/redis.js';

const GAMES = new Set(['globe-links', 'fact-or-fib', 'rank-the-world', 'mystery-passport', 'outline-sketch', 'flag-forge']);
const PAGES = new Set(['/', '/about', '/privacy', '/terms', ...[...GAMES].map((g) => `/games/${g}`)]);
const ok = () => new Response(null, { status: 204, headers: { 'cache-control': 'no-store' } });

let windowStart = 0;
let windowCount = 0;

export async function POST(request) {
  if (!redisReady()) return ok();
  const origin = request.headers.get('origin');
  const host = request.headers.get('host');
  try {
    if (!origin || !host || new URL(origin).host !== host) return ok();
  } catch {
    return ok();
  }
  // Flood guard per warm instance: plenty for real traffic, caps a runaway script.
  const now = Date.now();
  if (now - windowStart > 60_000) {
    windowStart = now;
    windowCount = 0;
  }
  if (++windowCount > 2000) return ok();

  let ev;
  try {
    const text = await request.text();
    if (text.length > 2000) return ok();
    ev = JSON.parse(text);
  } catch {
    return ok();
  }
  if (!ev || typeof ev !== 'object') return ok();

  const day = dayKey();
  const k = (s) => `d:${day}:${s}`;
  const ip = (request.headers.get('x-real-ip') || request.headers.get('x-forwarded-for') || '').split(',')[0].trim();
  const ua = request.headers.get('user-agent') || '';
  if (/bot|crawl|spider|slurp|preview|lighthouse|headless/i.test(ua)) return ok();
  const visitor = createHash('sha256').update(`${redisSecret()}|${day}|${ip}|${ua}`).digest('base64url').slice(0, 22);

  const cmds = [];
  const touch = (key) => cmds.push(['EXPIRE', key, TTL]);

  if (ev.t === 'view') {
    const path = PAGES.has(ev.path) ? ev.path : 'other';
    const ref = typeof ev.ref === 'string' && /^[a-z0-9.-]{1,80}$/i.test(ev.ref) ? ev.ref.toLowerCase().replace(/^www\./, '') : 'direct';
    const dev = ev.dev === 'phone' || ev.dev === 'tablet' ? ev.dev : 'computer';
    cmds.push(['PFADD', k('hll:v'), visitor], ['INCR', k('views')], ['HINCRBY', k('pages'), path, 1], ['HINCRBY', k('refs'), ref, 1], ['HINCRBY', k('dev'), dev, 1]);
    ['hll:v', 'views', 'pages', 'refs', 'dev'].forEach((s) => touch(k(s)));
  } else if (ev.t === 'leave') {
    const secs = Math.round(Number(ev.secs));
    if (!Number.isFinite(secs) || secs < 1) return ok();
    cmds.push(['INCRBY', k('secs'), Math.min(secs, 3600)]);
    touch(k('secs'));
  } else if (ev.t === 'finish') {
    if (!GAMES.has(ev.game)) return ok();
    const pct = Math.round(Number(ev.pct));
    const puzzle = Math.round(Number(ev.puzzle));
    const secs = Math.round(Number(ev.secs));
    if (!Number.isFinite(pct) || pct < 0 || pct > 100) return ok();
    const grade = typeof ev.grade === 'string' && /^[A-DF][+-]?$/.test(ev.grade) ? ev.grade : null;
    cmds.push(['PFADD', k('hll:p'), visitor], ['HINCRBY', k('fin'), ev.game, 1], ['HINCRBY', k('pct'), ev.game, pct]);
    ['hll:p', 'fin', 'pct'].forEach((s) => touch(k(s)));
    if (grade) {
      cmds.push(['HINCRBY', k(`grades:${ev.game}`), grade, 1]);
      touch(k(`grades:${ev.game}`));
    }
    if (Number.isFinite(secs) && secs > 0) {
      cmds.push(['HINCRBY', k('gsecs'), ev.game, Math.min(secs, 3600)], ['HINCRBY', k('gsecsn'), ev.game, 1]);
      touch(k('gsecs'));
      touch(k('gsecsn'));
    }
    if (Number.isFinite(puzzle) && puzzle > 0 && puzzle < 100000) {
      cmds.push(['HINCRBY', `pz:${ev.game}`, `${puzzle}:sum`, pct], ['HINCRBY', `pz:${ev.game}`, `${puzzle}:n`, 1]);
      touch(`pz:${ev.game}`);
    }
  } else {
    return ok();
  }

  try {
    await pipeline(cmds);
  } catch {
    /* analytics must never break the site */
  }
  return ok();
}

export function GET() {
  return new Response(null, { status: 405, headers: { Allow: 'POST' } });
}
