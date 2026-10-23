import { api, type GlobalSettings, type SessionDetails, type SessionDevice } from '../../lib/adminApi';
import { debounce, subscribeAdminEvents } from '../../lib/adminEvents';

/**
 * Shared state of the session page. It loads the session, global settings and displays once,
 * keeps them up to date through the admin event stream, and notifies the tab components.
 */

export const sessionId = new URLSearchParams(window.location.search).get('id') ?? '';
export const sessionPath = `/session/${encodeURIComponent(sessionId)}`;

export const state = {
  session: null as SessionDetails | null,
  global: null as GlobalSettings | null,
  devices: [] as SessionDevice[],
};

/**
 * - session:  the session or the global settings changed
 * - devices:  the list of displays changed
 * - ble:      linked info displays may have changed
 * - image:    a display fetched (or failed to fetch) an image
 * - settings: the global settings changed
 * - tick:     every 30 seconds, to keep relative times ("2 minutes ago") current
 */
type PageEvent = 'session' | 'devices' | 'ble' | 'image' | 'settings' | 'tick';
const listeners = new Map<PageEvent, Set<() => void>>();

/**
 * Listens to a page event. 'session', 'devices' and 'ble' also fire right away when the page has
 * already loaded, so it doesn't matter whether a component's script runs before or after the start.
 */
export function on(event: PageEvent, listener: () => void) {
  if (!listeners.has(event)) listeners.set(event, new Set());
  listeners.get(event)!.add(listener);
  const loaded = event === 'session' ? Boolean(state.session) : (event === 'devices' || event === 'ble') && started;
  if (loaded) listener();
}

function emit(event: PageEvent) {
  listeners.get(event)?.forEach((listener) => listener());
}

/** After the page itself changed the session, e.g. saved its settings */
export function setSession(session: SessionDetails) {
  state.session = session;
  emit('session');
}

export async function refreshSession() {
  try {
    setSession(await api<SessionDetails>(sessionPath));
  } catch {
    // Deleted or expired in the meantime; the admin event stream reports that
  }
}

export async function loadDevices() {
  try {
    ({ devices: state.devices } = await api<{ devices: SessionDevice[] }>(`${sessionPath}/devices`));
    emit('devices');
  } catch {
    // Keep the last known list
  }
}

export function thumbnailUrl(device: SessionDevice) {
  const lastSeen = new Date(device.lastSeenAt).getTime();
  return `/api/admin${sessionPath}/device/${encodeURIComponent(device.key)}/thumbnail?t=${lastSeen}`;
}

let started = false;

/** Loads everything and shows the page; shows "not found" when the session doesn't exist */
export async function startSessionPage() {
  const show = (id: string) => {
    for (const el of ['loading', 'notFound', 'sessionDetail']) {
      document.getElementById(el)!.classList.toggle('hidden', el !== id);
    }
  };
  if (!sessionId) return show('notFound');
  try {
    [state.session, state.global] = await Promise.all([
      api<SessionDetails>(sessionPath),
      api<GlobalSettings>('/settings'),
    ]);
  } catch {
    return show('notFound');
  }
  show('sessionDetail');
  emit('session');
  await loadDevices();
  started = true;
  emit('ble');

  const onImage = debounce(() => {
    loadDevices();
    refreshSession();
    emit('image');
  });
  const onChange = debounce(() => {
    loadDevices();
    refreshSession();
    emit('ble');
  });
  subscribeAdminEvents((event) => {
    if (event.type === 'settings') {
      api<GlobalSettings>('/settings').then((global) => {
        state.global = global;
        emit('settings');
        refreshSession();
      });
      return;
    }
    if (event.sessionId !== sessionId) return;
    if (event.type === 'session' && event.deleted) {
      show('notFound');
      document.querySelector('#notFound p')!.textContent = 'This session has been deleted.';
    } else if (event.type === 'image') {
      onImage();
    } else {
      onChange();
    }
  }, onChange);

  setInterval(() => document.visibilityState === 'visible' && emit('tick'), 30_000);
}
