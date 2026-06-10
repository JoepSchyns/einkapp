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
}
