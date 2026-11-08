// Small helpers every game shares: day rollover, safe stats, and focus management.
import { dayKey } from './daily';
import { load, save } from './storage';

/**
 * Reload when the player's local date changes (tab left open overnight, laptop asleep,
 * phone in the background). Checks on a timer and whenever the page becomes visible again.
 */
export function watchDayChange(loadedKey: string) {
  const check = () => {
    if (dayKey() !== loadedKey) window.location.reload();
  };
  window.setInterval(check, 30_000);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) check();
  });
  window.addEventListener('pageshow', check);
  window.addEventListener('focus', check);
}

export interface DayStats {
  played: number;
  total: number;
  best: number;
  streak: number;
  lastDay: number;
}
const fresh = (): DayStats => ({ played: 0, total: 0, best: 0, streak: 0, lastDay: -2 });

/** Stats from storage, validated so a tampered or old value can never crash a game. */
export function readStats(key: string): DayStats {
  const s = load<Partial<DayStats> | null>(key, null);
  if (!s || typeof s !== 'object') return fresh();
  const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
  return { played: num(s.played, 0), total: num(s.total, 0), best: num(s.best, 0), streak: num(s.streak, 0), lastDay: num(s.lastDay, -2) };
}

/**
 * Count today's finished game exactly once, even across two tabs or a reset of today's progress:
 * if today is already recorded, nothing changes.
 */
export function recordDay(key: string, today: number, score: number): DayStats {
  const st = readStats(key);
  if (st.lastDay === today) return st;
  st.played += 1;
  st.total += score;
  st.best = Math.max(st.best, score);
  st.streak = st.lastDay === today - 1 ? st.streak + 1 : 1;
  st.lastDay = today;
  save(key, st);
  return st;
}

/** Move keyboard/screen-reader focus to an element that isn't normally focusable (e.g. a heading). */
export function focusQuietly(el: HTMLElement | null) {
  if (!el) return;
  if (!el.hasAttribute('tabindex')) el.setAttribute('tabindex', '-1');
  el.focus({ preventScroll: true });
}

const smooth = () => (window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth') as ScrollBehavior;

/** After a game ends, take the player to the very top so the grade and result are the first thing they see. */
export function scrollToTop() {
  window.scrollTo({ top: 0, behavior: smooth() });
}

/** When answers are revealed, bring the card's top into view (clear of the sticky header). */
export function showFromTop(el: Element | null) {
  el?.scrollIntoView({ block: 'start', behavior: smooth() });
}
