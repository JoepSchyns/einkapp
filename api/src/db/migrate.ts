import type { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Umzug, type UmzugStorage } from 'umzug';
import { db } from './database.js';

interface Migration {
  up(db: DatabaseSync): void;
  down(db: DatabaseSync): void;
}

class SqliteStorage implements UmzugStorage {
  constructor(private db: DatabaseSync) {
    db.exec(`CREATE TABLE IF NOT EXISTS umzug_migrations (name TEXT PRIMARY KEY, executed_unix INTEGER NOT NULL)`);
  }

  async logMigration({ name }: { name: string }) {
    this.db.prepare(`INSERT INTO umzug_migrations (name, executed_unix) VALUES (?, unixepoch())`).run(name);
  }

  async unlogMigration({ name }: { name: string }) {
    this.db.prepare(`DELETE FROM umzug_migrations WHERE name = ?`).run(name);
  }

  async executed() {
    const rows = this.db.prepare(`SELECT name FROM umzug_migrations ORDER BY name`).all() as { name: string }[];
    return rows.map((r) => r.name);
  }
}

/**
 * Every file in ./migrations is a migration, run in file name order (hence the 0001_ prefixes).
 * They are .ts under tsx and .js once built, so the name is stored without extension.
 */
export function createMigrator() {
  return new Umzug({
    migrations: {
      glob: [
        'migrations/*.{ts,js}',
        { cwd: path.dirname(fileURLToPath(import.meta.url)), ignore: ['**/*.d.ts'] },
      ],
      resolve: ({ name, path: file }) => {
        const load = async () => (await import(pathToFileURL(file!).href)) as Migration;
        return {
          name: name.replace(/\.(ts|js)$/, ''),
          // Each migration runs in a transaction so a failure leaves the schema untouched
          up: async () => {
            const migration = await load();
            runInTransaction(db, () => migration.up(db));
          },
          down: async () => {
            const migration = await load();
            runInTransaction(db, () => migration.down(db));
          },
        };
      },
    },
    storage: new SqliteStorage(db),
    logger: console,
  });
}

function runInTransaction(db: DatabaseSync, fn: () => void) {
  db.exec('BEGIN');
  try {
    fn();
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

export async function migrate() {
  await createMigrator().up();
}
