// Anonymous, aggregate analytics for the site owner's dashboard.
// No cookies, nothing stored in this browser, no ID of any kind. Each event says only what
// happened (a page was viewed, a game was finished with this score), never who did it.
// Browsers that send Do Not Track or Global Privacy Control are skipped entirely.

type Event =
  | { t: 'view'; path: string; ref: string; dev: 'phone' | 'tablet' | 'computer' }
  | { t: 'leave'; secs: number }
  | { t: 'finish'; game: string; pct: number; grade: string; puzzle: number; secs: number };

const optedOut = () => {
  const n = navigator as Navigator & { globalPrivacyControl?: boolean };
  return n.globalPrivacyControl === true || n.doNotTrack === '1';
};
const skip = () => optedOut() || location.pathname.startsWith('/admin') || !/^https?:$/.test(location.protocol);

export function track(ev: Event, leaving = false) {
  if (skip()) return;
  const body = JSON.stringify(ev);
  try {
    // While leaving the page, a beacon is the only request the browser reliably finishes.
    if (leaving && navigator.sendBeacon?.('/api/track', new Blob([body], { type: 'application/json' }))) return;
    void fetch('/api/track', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, keepalive: true, credentials: 'omit' }).catch(() => {});
  } catch {
    /* never let analytics break the page */
  }
}

/** Page view now, then the time the page was actually on screen when it's left. */
export function trackPage() {
  if (skip()) return;
  let ref = '';
  try {
    const r = document.referrer ? new URL(document.referrer).hostname : '';
    ref = r && r !== location.hostname ? r : '';
  } catch {
    /* no referrer */
  }
  const w = Math.min(screen.width, screen.height);
  const dev = w < 600 ? 'phone' : w < 1000 && navigator.maxTouchPoints > 0 ? 'tablet' : 'computer';
  track({ t: 'view', path: location.pathname.replace(/\/$/, '') || '/', ref: ref || 'direct', dev });

  let shownSince = document.hidden ? 0 : performance.now();
  let total = 0;
  const pause = () => {
    if (shownSince) total += performance.now() - shownSince;
    shownSince = 0;
  };
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      pause();
      // Phones often never fire pagehide; report what we have so far each time the page hides.
      if (total >= 1000) track({ t: 'leave', secs: Math.round(total / 1000) }, true);
      total = 0;
    } else shownSince = performance.now();
  });
  addEventListener('pagehide', () => {
    pause();
    if (total >= 1000) track({ t: 'leave', secs: Math.round(total / 1000) }, true);
    total = 0;
  });
}
