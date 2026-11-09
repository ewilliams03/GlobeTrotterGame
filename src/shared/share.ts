// Sharing is always player-initiated. We hand text to the OS share sheet (touch devices)
// or the clipboard. Nothing goes through our servers, because we have none.
// 'cancelled' means the player closed the share sheet themselves: not an error, so show nothing.
export async function shareText(text: string): Promise<'shared' | 'copied' | 'cancelled' | 'failed'> {
  const coarse = window.matchMedia('(pointer: coarse)').matches;
  if (coarse && typeof navigator.share === 'function') {
    try {
      await navigator.share({ text });
      return 'shared';
    } catch (e) {
      if ((e as DOMException).name === 'AbortError') return 'cancelled';
    }
  }
  try {
    await navigator.clipboard.writeText(text);
    return 'copied';
  } catch {
    return 'failed';
  }
}
