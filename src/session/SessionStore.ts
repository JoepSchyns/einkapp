import { Store } from '../Store.js';

export class SessionStore extends Store {
  constructor(private sessionId: string) {
    super();
  }

  setLastAccessedImageGeneratorName(imageGeneratorName: string) {
    Store.db
      .prepare(`UPDATE sessions SET last_accessed_generator_name = ? WHERE id = ?`)
      .run(imageGeneratorName, this.sessionId);
  }

  getLastAccessedImageGeneratorName(): string | null {
    const row = Store.db
      .prepare(`SELECT last_accessed_generator_name FROM sessions WHERE id = ?`)
      .get(this.sessionId) as { last_accessed_generator_name: string | null } | undefined;
    if (!row) {
      throw new Error(`Session with id ${this.sessionId} not found.`);
    }
    return row.last_accessed_generator_name;
  }

  pruneGeneratorData(activeGeneratorNames: string[]) {
    const placeholders = activeGeneratorNames.map(() => '?').join(', ');
    Store.db
      .prepare(
        `DELETE FROM session_generator_data WHERE session_id = ? AND generator_name NOT IN (${placeholders})`
      )
      .run(this.sessionId, ...activeGeneratorNames);
  }
}
