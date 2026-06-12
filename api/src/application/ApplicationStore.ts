import { Store } from '../Store.js';

export class ApplicationStore extends Store {
  getSessionIds(): string[] {
    const rows = Store.db.prepare(`SELECT id FROM sessions`).all() as { id: string }[];
    return rows.map((row) => row.id);
  }

  setNewSession(sessionId: string) {
    Store.db.prepare(`INSERT INTO sessions (id) VALUES (?)`).run(sessionId);
  }

  updateSessionAccessTime(sessionId: string) {
    Store.db
      .prepare(`UPDATE sessions SET last_accessed_unix = unixepoch() WHERE id = ?`)
      .run(sessionId);
  }

  getSessionLastAccessTime(sessionId: string): number {
    const row = Store.db
      .prepare(`SELECT last_accessed_unix FROM sessions WHERE id = ?`)
      .get(sessionId) as { last_accessed_unix: number } | undefined;
    if (!row) {
      throw new Error(`Session with id ${sessionId} not found.`);
    }
    return row.last_accessed_unix * 1000;
  }

  setSessionLastAccessTime(sessionId: string, timestamp: number = Date.now()) {
    Store.db
      .prepare(`UPDATE sessions SET last_accessed_unix = ? WHERE id = ?`)
      .run(Math.floor(timestamp / 1000), sessionId);
  }

  deleteSession(sessionId: string) {
    Store.db.prepare(`DELETE FROM sessions WHERE id = ?`).run(sessionId);
  }

  getSessionsWithDetails(): { id: string; lastAccessedAt: string; generatorName: string | null }[] {
    const rows = Store.db
      .prepare(
        `SELECT id, last_accessed_unix, last_accessed_generator_name FROM sessions ORDER BY last_accessed_unix DESC`,
      )
      .all() as { id: string; last_accessed_unix: number; last_accessed_generator_name: string | null }[];
    return rows.map((row) => ({
      id: row.id,
      lastAccessedAt: new Date(row.last_accessed_unix * 1000).toISOString(),
      generatorName: row.last_accessed_generator_name,
    }));
  }

  getSessionBleDevices(sessionId: string): { mac: string; name: string | null }[] {
    const rows = Store.db
      .prepare(`SELECT mac_address, device_name FROM session_ble_devices WHERE session_id = ?`)
      .all(sessionId) as { mac_address: string; device_name: string | null }[];
    return rows.map((r) => ({ mac: r.mac_address, name: r.device_name }));
  }

  addSessionBleDevice(sessionId: string, mac: string, name: string | null): void {
    Store.db
      .prepare(
        `INSERT INTO session_ble_devices (session_id, mac_address, device_name)
         VALUES (?, ?, ?)
         ON CONFLICT (session_id, mac_address) DO UPDATE SET device_name = excluded.device_name`,
      )
      .run(sessionId, mac, name ?? null);
  }

  removeSessionBleDevice(sessionId: string, mac: string): void {
    Store.db
      .prepare(`DELETE FROM session_ble_devices WHERE session_id = ? AND mac_address = ?`)
      .run(sessionId, mac);
  }
}
