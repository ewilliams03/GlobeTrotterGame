// Light tactile feedback on devices that support the Vibration API (mostly Android).
// Silently does nothing elsewhere, and never fires for reduced-motion users.
const reduce = window.matchMedia('(prefers-reduced-motion: reduce)');

function buzz(pattern: number | number[]): void {
  if (reduce.matches || typeof navigator.vibrate !== 'function') return;
  // Browsers only allow vibration after a real user gesture; skip until then.
  const activation = (navigator as Navigator & { userActivation?: { hasBeenActive: boolean } }).userActivation;
  if (activation && !activation.hasBeenActive) return;
  try {
    navigator.vibrate(pattern);
  } catch {
    /* unsupported */
  }
}

export const haptic = {
  tap: () => buzz(6),
  select: () => buzz(4),
  success: () => buzz([10, 40, 18]),
  error: () => buzz([24, 30, 24]),
};
