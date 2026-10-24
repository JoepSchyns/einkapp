import { Store } from '../Store.js';
import {
  DEFAULT_SESSION_SETTINGS,
  parseSessionSettings,
  type InfoDisplay,
  type InfoDisplayVia,
  type SessionSettings,
} from '../types/index.js';

export interface SessionRecord {
  id: string;
  name: string | null;
  createdAt: string | null;
  lastAccessedAt: string;
  generatorName: string | null;
  settings: SessionSettings;
}

interface SessionRow {
  id: string;
  name: string | null;
  created_unix: number | null;
  last_accessed_unix: number;
  last_accessed_generator_name: string | null;
  settings: string | null;
}

const SESSION_COLUMNS = `id, name, created_unix, last_accessed_unix, last_accessed_generator_name, settings`;

function toRecord(row: SessionRow): SessionRecord {
  return {
    id: row.id,
    name: row.name,
    createdAt: row.created_unix ? new Date(row.created_unix * 1000).toISOString() : null,
    lastAccessedAt: new Date(row.last_accessed_unix * 1000).toISOString(),
    generatorName: row.last_accessed_generator_name,
    settings: parseSessionSettings(row.settings),
  };
}

export class ApplicationStore extends Store {
  sessionExists(sessionId: string): boolean {
    return Boolean(Store.db.prepare(`SELECT 1 FROM sessions WHERE id = ?`).get(sessionId));
  }

  setNewSession(
    sessionId: string,
    name: string | null = null,
    settings: SessionSettings = DEFAULT_SESSION_SETTINGS
  ) {
    Store.db
      .prepare(
        `INSERT INTO sessions (id, name, settings, created_unix) VALUES (?, ?, ?, unixepoch())`
      )
      .run(sessionId, name, JSON.stringify(settings));
  }

  updateSession(sessionId: string, name: string | null, settings: SessionSettings) {
    Store.db
      .prepare(`UPDATE sessions SET name = ?, settings = ? WHERE id = ?`)
      .run(name, JSON.stringify(settings), sessionId);
  }

  updateSessionAccessTime(sessionId: string) {
    Store.db
      .prepare(`UPDATE sessions SET last_accessed_unix = unixepoch() WHERE id = ?`)
      .run(sessionId);
  }

  deleteSession(sessionId: string) {
    Store.db.prepare(`DELETE FROM sessions WHERE id = ?`).run(sessionId);
    // Statistics are per session, so they go with it
    Store.db.prepare(`DELETE FROM image_events WHERE session_id = ?`).run(sessionId);
  }

  getSessions(): SessionRecord[] {
    const rows = Store.db
      .prepare(`SELECT ${SESSION_COLUMNS} FROM sessions ORDER BY last_accessed_unix DESC`)
      .all() as unknown as SessionRow[];
    return rows.map(toRecord);
  }

  getSessionById(sessionId: string): SessionRecord | null {
    const row = Store.db
      .prepare(`SELECT ${SESSION_COLUMNS} FROM sessions WHERE id = ?`)
      .get(sessionId) as unknown as SessionRow | undefined;
    return row ? toRecord(row) : null;
  }

  getSessionInfoDisplays(sessionId: string): InfoDisplay[] {
    const rows = Store.db
      .prepare(
        `SELECT mac_address, device_name, via, webhook FROM session_ble_devices WHERE session_id = ?`
      )
      .all(sessionId) as {
      mac_address: string;
      device_name: string | null;
      via: InfoDisplayVia;
      webhook: string | null;
    }[];
    return rows.map((r) => ({
      mac: r.mac_address,
      name: r.device_name,
      via: r.via,
      webhook: r.webhook,
    }));
  }

  addSessionInfoDisplay(sessionId: string, device: InfoDisplay): void {
    Store.db
      .prepare(
        `INSERT INTO session_ble_devices (session_id, mac_address, device_name, via, webhook)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (session_id, mac_address) DO UPDATE
         SET device_name = excluded.device_name, via = excluded.via, webhook = excluded.webhook`
      )
      .run(sessionId, device.mac, device.name ?? null, device.via, device.webhook);
  }

  removeSessionInfoDisplay(sessionId: string, mac: string): void {
    Store.db
      .prepare(`DELETE FROM session_ble_devices WHERE session_id = ? AND mac_address = ?`)
      .run(sessionId, mac);
  }
}
