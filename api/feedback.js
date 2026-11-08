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

const reply = (status, body) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
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
  if (!origin || !host || new URL(origin).host !== host) return reply(403, { error: 'forbidden' });
  if (!(request.headers.get('content-type') ?? '').includes('application/json')) return reply(415, { error: 'json only' });
  if (Number(request.headers.get('content-length') ?? 0) > 10_000) return reply(413, { error: 'too large' });

  let data;
  try {
    data = await request.json();
  } catch {
    return reply(400, { error: 'bad json' });
  }

  // Honeypot: a field real visitors never see. Pretend success so bots don't retry.
  if (clean(data.website, 200)) return reply(200, { ok: true });
  const elapsed = Number(data.elapsed);
  if (!Number.isFinite(elapsed) || elapsed < MIN_FILL_MS) return reply(200, { ok: true });

  const message = clean(data.message, MAX_MESSAGE);
  const game = clean(data.game, 40);
  const email = clean(data.email, 200);
  if (message.length < 5) return reply(400, { error: 'Please write a little more.' });
  if (!GAMES.has(game)) return reply(400, { error: 'Unknown game.' });
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return reply(400, { error: 'That email address looks off.' });

  const key = process.env.RESEND_API_KEY || process.env.resendapykey;
  const to = process.env.FEEDBACK_TO;
  if (!key || !to) return reply(503, { error: 'Feedback is not set up yet.' });

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
  return reply(200, { ok: true });
}

export function GET() {
  return reply(405, { error: 'POST only' });
}
