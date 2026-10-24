import type { DatabaseSync } from 'node:sqlite';

/** Info displays reached through Home Assistant are updated by calling one of their session's webhooks */
export function up(db: DatabaseSync) {
  db.exec(`
    CREATE TABLE homeassistant_webhooks (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        name TEXT NOT NULL,
        homeassistant_url TEXT NOT NULL,
        webhook_id TEXT NOT NULL UNIQUE,
        FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
    );
    CREATE INDEX homeassistant_webhooks_session ON homeassistant_webhooks (session_id);

    -- Displays linked through Home Assistant before webhooks existed can't be reached anymore
    DELETE FROM session_ble_devices WHERE via = 'homeassistant';
    ALTER TABLE session_ble_devices ADD COLUMN webhook TEXT DEFAULT NULL REFERENCES homeassistant_webhooks(id) ON DELETE CASCADE;
  `);
}

export function down(db: DatabaseSync) {
  db.exec(`
    ALTER TABLE session_ble_devices DROP COLUMN webhook;
    DROP TABLE IF EXISTS homeassistant_webhooks;
  `);
}
