// Tiny Upstash Redis REST client (no dependencies). Files under api/_lib are not exposed as endpoints.
// Works with either env naming that Vercel's Upstash integration creates.
const url = () => process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const token = () => process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

export const redisReady = () => Boolean(url() && token());
export const redisSecret = () => token() || '';

/** Run several commands in one round trip. Returns each command's result (or null on error). */
export async function pipeline(commands) {
  if (!redisReady() || !commands.length) return [];
  const res = await fetch(`${url()}/pipeline`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(commands),
  });
  if (!res.ok) throw new Error(`redis ${res.status}`);
  const out = await res.json();
  return out.map((r) => (r && 'result' in r ? r.result : null));
}

/** Calendar day in the site owner's time zone, e.g. 2026-11-09. */
export function dayKey(date = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}

export const TTL = 60 * 60 * 24 * 400; // keep daily counts a little over a year
