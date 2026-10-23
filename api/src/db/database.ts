import { DatabaseSync } from 'node:sqlite';

/** The single SQLite connection, shared by the stores and the migrations */
export const db = new DatabaseSync('data/db.sqlite');

// SQLite only enforces foreign keys (and ON DELETE CASCADE) when enabled, per connection
db.exec('PRAGMA foreign_keys = ON;');
