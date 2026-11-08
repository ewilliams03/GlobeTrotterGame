// Sharing is always player-initiated. We hand text to the OS share sheet (touch devices)
// or the clipboard. Nothing goes through our servers, because we have none.
export async function shareText(text: string): Promise<'shared' | 'copied' | 'failed'> {
  const coarse = window.matchMedia('(pointer: coarse)').matches;
  if (coarse && typeof navigator.share === 'function') {
    try {
      await navigator.share({ text });
      return 'shared';
    } catch (e) {
      if ((e as DOMException).name === 'AbortError') return 'failed';
    }
  }
  try {
    await navigator.clipboard.writeText(text);
    return 'copied';
  } catch {
    return 'failed';
  }
}
