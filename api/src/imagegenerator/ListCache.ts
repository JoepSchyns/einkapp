import { Store } from '../Store.js';

interface Entry {
  fetchedAt: number;
  value: unknown;
}

/**
 * Lists that are expensive to fetch and change slowly, such as Wikidata query results. They are kept
 * in memory and in the database, so a restart doesn't fetch them again. A list older than its TTL is
 * still returned right away while a fresh one is fetched in the background; only a list that was
 * never fetched is waited for.
 */
export class ListCache extends Store {
  private static memory = new Map<string, Entry>();
  private static fetching = new Map<string, Promise<unknown>>();

  static async get<T>(key: string, ttlMs: number, fetchList: () => Promise<T>): Promise<T> {
    const cached = this.memory.get(key) ?? this.load(key);
    if (!cached) {
      return this.refresh(key, fetchList);
    }
    if (Date.now() - cached.fetchedAt >= ttlMs) {
      this.refresh(key, fetchList).catch((error: unknown) => {
        // The outdated list keeps being used, the next request tries again
        console.error(`[ListCache] Failed to refresh ${key}:`, error);
      });
    }
    return cached.value as T;
  }

  private static load(key: string): Entry | undefined {
    const row = this.db
      .prepare(`SELECT fetched_unix, value FROM generator_cache WHERE key = ?`)
      .get(key) as { fetched_unix: number; value: string } | undefined;
    if (!row) return undefined;
    const entry = { fetchedAt: row.fetched_unix * 1000, value: JSON.parse(row.value) as unknown };
    this.memory.set(key, entry);
    return entry;
  }

  /** Fetches and stores the list; requests for the same key at the same time share one fetch */
  private static refresh<T>(key: string, fetchList: () => Promise<T>): Promise<T> {
    let promise = this.fetching.get(key) as Promise<T> | undefined;
    if (!promise) {
      promise = fetchList()
        .then((value) => {
          const fetchedAt = Date.now();
          this.memory.set(key, { fetchedAt, value });
          this.db
            .prepare(
              `INSERT INTO generator_cache (key, fetched_unix, value) VALUES (?, ?, ?)
               ON CONFLICT(key) DO UPDATE SET fetched_unix = excluded.fetched_unix, value = excluded.value`
            )
            .run(key, Math.floor(fetchedAt / 1000), JSON.stringify(value));
          return value;
        })
        .finally(() => this.fetching.delete(key));
      this.fetching.set(key, promise);
    }
    return promise;
  }
}
