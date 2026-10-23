import type { DatabaseSync } from 'node:sqlite';

export function up(db: DatabaseSync) {
  db.exec(`
    ALTER TABLE sessions ADD COLUMN name TEXT DEFAULT NULL;
    ALTER TABLE sessions ADD COLUMN settings TEXT DEFAULT NULL;
    ALTER TABLE sessions ADD COLUMN created_unix INTEGER DEFAULT NULL;
    UPDATE sessions SET created_unix = last_accessed_unix WHERE created_unix IS NULL;

    CREATE TABLE settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
    );

    -- No foreign key: rows are removed with their session (ApplicationStore.deleteSession) and by retention pruning
    CREATE TABLE image_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL,
        session_id TEXT,
        device_key TEXT,
        generator_name TEXT NOT NULL,
        success INTEGER NOT NULL,
        duration_ms INTEGER,
        error TEXT
    );
    CREATE INDEX image_events_ts ON image_events (ts);
    CREATE INDEX image_events_generator ON image_events (generator_name);

    CREATE TABLE session_devices (
        session_id TEXT NOT NULL,
        device_key TEXT NOT NULL,
        label TEXT NOT NULL,
        last_seen_unix INTEGER NOT NULL,
        generator_name TEXT,
        title TEXT,
        source_url TEXT,
        resize_params TEXT,
        thumbnail BLOB,
        PRIMARY KEY (session_id, device_key),
        FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
    );
  `);
}

export function down(db: DatabaseSync) {
  db.exec(`
    DROP TABLE IF EXISTS session_devices;
    DROP TABLE IF EXISTS image_events;
    DROP TABLE IF EXISTS settings;
    ALTER TABLE sessions DROP COLUMN created_unix;
    ALTER TABLE sessions DROP COLUMN settings;
    ALTER TABLE sessions DROP COLUMN name;
  `);
}
