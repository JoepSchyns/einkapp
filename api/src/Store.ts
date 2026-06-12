import { DatabaseSync } from 'node:sqlite';

export abstract class Store {
  protected static readonly db = new DatabaseSync('data/db.sqlite');

  static {
    Store.db.exec(`
            CREATE TABLE IF NOT EXISTS sessions (
                id TEXT PRIMARY KEY,
                last_accessed_unix INTEGER NOT NULL DEFAULT (STRFTIME('%s', 'now')),
                last_accessed_generator_name TEXT DEFAULT NULL
            );

            CREATE TABLE IF NOT EXISTS session_generator_data (
                session_id TEXT NOT NULL,
                generator_name TEXT NOT NULL,
                prev_info_title TEXT DEFAULT NULL,
                prev_info_description TEXT DEFAULT NULL,
                prev_info_source_url TEXT DEFAULT NULL,
                prev_data TEXT DEFAULT NULL,
                PRIMARY KEY (session_id, generator_name),
                FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS users (
                username TEXT PRIMARY KEY,
                password_hash TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS session_ble_devices (
                session_id TEXT NOT NULL,
                mac_address TEXT NOT NULL,
                device_name TEXT,
                PRIMARY KEY (session_id, mac_address),
                FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
            );
        `);
  }
}
