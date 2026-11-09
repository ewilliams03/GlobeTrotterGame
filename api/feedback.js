import { pipeline, dayKey, TTL } from './_lib/redis.js';
// Vercel Function: receives a recommendation from the site's form and emails it to the owner
// through Resend. Nothing is stored here: the message is passed straight on and forgotten.
//
// Environment variables (Vercel → Project → Settings → Environment Variables):
//   RESEND_API_KEY  required, from resend.com (mark it Sensitive)
//   FEEDBACK_TO     where messages go, e.g. you@example.com
//   FEEDBACK_FROM   optional sender; defaults to Resend's test sender, which can only
//                   deliver to the email address the Resend account was created with

const GAMES = new Set(['', 'general', 'globe-links', 'fact-or-fib', 'rank-the-world', 'mystery-passport', 'outline-sketch', 'flag-forge']);
const GAME_NAMES = {
  general: 'The site in general',
  'globe-links': 'Globe Links',
  'fact-or-fib': 'Fact or Fib',
  'rank-the-world': 'Rank the World',
  'mystery-passport': 'Mystery Passport',
  'outline-sketch': 'Outline Drop',
  'flag-forge': 'Flag Forge',
};
const MIN_FILL_MS = 3000; // humans take a few seconds to type; instant posts are bots
const MAX_MESSAGE = 2000;
// 2000 characters can take ~12 KB once JSON-escaped (emoji, control characters), so allow some room.
const MAX_BODY = 32_000;
// A flood guard so a script can't empty the email quota or the inbox. Counted per warm
// function instance, in memory only: nothing about the sender (not even an IP) is kept.
const WINDOW_MS = 10 * 60_000;
const MAX_PER_WINDOW = 30;
let windowStart = 0;
let sentInWindow = 0;
const EMAIL = /^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:"]+\.[^\s@<>()[\]\\,;:"]+$/;

const reply = (status, body, extra = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...extra },
  });

// Strip control characters (except newlines/tabs) so nothing odd reaches the email.
const clean = (v, max) =>
  String(v ?? '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .trim()
    .slice(0, max);

export async function POST(request) {
  // Only accept posts from the site's own pages.
  const origin = request.headers.get('origin');
  const host = request.headers.get('host');
  let originHost = '';
  try {
    originHost = new URL(origin ?? '').host; // "null" or junk origins throw: treat as foreign
  } catch {
    /* rejected below */
  }
  const refused = { error: "Couldn't send from here. Please use the form on the home page." };
  if (!originHost || !host || originHost !== host) return reply(403, refused);
  if (!(request.headers.get('content-type') ?? '').includes('application/json')) return reply(415, refused);
  const tooLong = { error: 'That message is too long. Please shorten it and try again.' };
  if (Number(request.headers.get('content-length') ?? 0) > MAX_BODY) return reply(413, tooLong);

  let data;
  try {
    // Read as text so a body with no content-length header still can't be huge.
    const raw = await request.text();
    if (raw.length > MAX_BODY) return reply(413, tooLong);
    data = JSON.parse(raw);
  } catch {
    return reply(400, refused);
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return reply(400, refused);

  // Honeypot: a field real visitors never see. Pretend success so bots don't retry.
  if (clean(data.website, 200)) return reply(200, { ok: true });
  const elapsed = Number(data.elapsed);
  if (!Number.isFinite(elapsed) || elapsed < MIN_FILL_MS) return reply(200, { ok: true });

  const message = clean(data.message, MAX_MESSAGE);
  const game = clean(data.game, 40);
  const email = clean(data.email, 200);
  if (message.length < 5) return reply(400, { error: 'Please write a little more.' });
  if (!GAMES.has(game)) return reply(400, { error: 'Unknown game.' });
  if (email && !EMAIL.test(email)) return reply(400, { error: 'That email address looks off. You can also leave it blank.' });

  const key = process.env.RESEND_API_KEY || process.env.resendapykey;
  const to = process.env.FEEDBACK_TO;
  if (!key || !to) return reply(503, { error: 'Feedback is not set up yet.' });

  const now = Date.now();
  if (now - windowStart > WINDOW_MS) {
    windowStart = now;
    sentInWindow = 0;
  }
  if (sentInWindow >= MAX_PER_WINDOW) {
    return reply(429, { error: 'Lots of recommendations are arriving right now. Please try again in a few minutes.' }, { 'retry-after': '600' });
  }
  sentInWindow += 1;

  const about = GAME_NAMES[game] ?? 'Not specified';
  const text = [
    `New recommendation for Daily World Quiz`,
    ``,
    `About: ${about}`,
    `Reply to: ${email || 'not given'}`,
    ``,
    message,
  ].join('\n');

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: process.env.FEEDBACK_FROM || 'Daily World Quiz <onboarding@resend.dev>',
      to: [to],
      subject: `Recommendation: ${about}`,
      text, // plain text only, so nothing a visitor writes can be rendered as HTML
      ...(email ? { reply_to: email } : {}),
    }),
  }).catch(() => null);

  if (!res || !res.ok) return reply(502, { error: "Couldn't send right now. Please try again later." });
  // Count it for the owner's dashboard (just a number per day, never the message).
  const fbKey = `d:${dayKey()}:fb`;
  await pipeline([['INCR', fbKey], ['EXPIRE', fbKey, TTL]]).catch(() => {});
  return reply(200, { ok: true });
}

export function GET() {
  return reply(405, { error: 'POST only' }, { allow: 'POST' });
}
