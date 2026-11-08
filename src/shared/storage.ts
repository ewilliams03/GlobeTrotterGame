// Tiny wrapper over localStorage. Everything stays on the player's device; nothing is
// ever sent anywhere. Every access is guarded because storage can be blocked or full.
const PREFIX = 'gg:';

export function load<T>(key: string, fallback: T): T {
  try {
    const raw = window.localStorage.getItem(PREFIX + key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

export function save(key: string, value: unknown): void {
  try {
    window.localStorage.setItem(PREFIX + key, JSON.stringify(value));
  } catch {
    /* storage unavailable: the game still works, it just won't remember */
  }
}

export function clearAll(): void {
  for (const store of ['localStorage', 'sessionStorage'] as const) {
    try {
      const s = window[store];
      Object.keys(s)
        .filter((k) => k.startsWith(PREFIX))
        .forEach((k) => s.removeItem(k));
    } catch {
      /* nothing to clear */
    }
  }
}

export function remove(key: string): void {
  try {
    window.localStorage.removeItem(PREFIX + key);
  } catch {
    /* nothing to remove */
  }
}
