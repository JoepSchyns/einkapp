export type AdminEvent =
  | { type: 'image'; sessionId: string }
  | { type: 'session'; sessionId: string; deleted?: boolean }
  | { type: 'settings' };

/**
 * Listens to live changes from the API. EventSource reconnects by itself after a dropped
 * connection; `onReconnect` lets the caller catch up on changes it missed meanwhile.
 */
export function subscribeAdminEvents(
  onEvent: (event: AdminEvent) => void,
  onReconnect?: () => void,
): () => void {
  const source = new EventSource('/api/admin/events');
  let wasOpen = false;
  source.addEventListener('open', () => {
    if (wasOpen) onReconnect?.();
    wasOpen = true;
  });
  source.addEventListener('message', (e) => onEvent(JSON.parse(e.data) as AdminEvent));
  return () => source.close();
}

/** Runs `fn` once after a burst of calls, e.g. several displays fetching images at once */
export function debounce(fn: () => void, ms = 300): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return () => {
    clearTimeout(timer);
    timer = setTimeout(fn, ms);
  };
}
