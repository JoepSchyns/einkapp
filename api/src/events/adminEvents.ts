import { EventEmitter } from 'node:events';

/**
 * Changes the admin interface wants to know about, pushed to it over `/api/admin/events`:
 * - image:    a display fetched (or failed to fetch) an image for a session
 * - session:  a session was created, changed or deleted, or its displays changed
 * - settings: the global settings changed
 */
export type AdminEvent =
  | { type: 'image'; sessionId: string }
  | { type: 'session'; sessionId: string; deleted?: boolean }
  | { type: 'settings' };

const emitter = new EventEmitter();
// Every open admin tab adds a listener
emitter.setMaxListeners(0);

export function emitAdminEvent(event: AdminEvent) {
  emitter.emit('event', event);
}

export function onAdminEvent(listener: (event: AdminEvent) => void): () => void {
  emitter.on('event', listener);
  return () => emitter.off('event', listener);
}
