// Loads today's puzzle for a game: one small JSON file, fetched from this site only.
import { dayIndex } from './daily';

declare const __BANK_SIZES__: Record<string, number>;

export class DayLoadError extends Error {}

export async function loadToday<T>(game: string): Promise<T> {
  const size = __BANK_SIZES__[game] ?? 0;
  if (!size) throw new DayLoadError(`No puzzles for ${game}`);
  const index = dayIndex() % size;
  const res = await fetch(`/data/${game}/${index}.json`, { credentials: 'omit' });
  if (!res.ok) throw new DayLoadError(`HTTP ${res.status}`);
  return (await res.json()) as T;
}

/** Shown in place of the board if today's file can't be fetched (offline, for example). */
export function showLoadError(container: HTMLElement | null) {
  if (!container) return;
  const p = document.createElement('p');
  p.className = 'noscript';
  p.textContent = "Couldn't load today's puzzle. Check your connection and refresh the page.";
  container.replaceChildren(p);
  document.documentElement.classList.add('arrival-done');
}
