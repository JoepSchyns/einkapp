import type { DatabaseSync } from 'node:sqlite';

export function up(db: DatabaseSync) {
  db.exec(`
    -- Expensive lists fetched by generators (e.g. Wikidata query results), shared by all sessions
    CREATE TABLE generator_cache (
        key TEXT PRIMARY KEY,
        fetched_unix INTEGER NOT NULL,
        value TEXT NOT NULL
    );
  `);
}

export function down(db: DatabaseSync) {
  db.exec(`DROP TABLE IF EXISTS generator_cache;`);
}
