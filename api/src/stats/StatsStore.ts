import { Store } from '../Store.js';
import type { SessionRecord } from '../application/ApplicationStore.js';

export const STATS_RETENTION_DAYS = 90;

export interface ImageEvent {
  sessionId: string;
  deviceKey: string | null;
  generatorName: string;
  success: boolean;
  durationMs: number;
  error?: string | null;
}

export class StatsStore extends Store {
  logImageEvent(event: ImageEvent) {
    Store.db
      .prepare(
        `INSERT INTO image_events (ts, session_id, device_key, generator_name, success, duration_ms, error)
         VALUES (unixepoch(), ?, ?, ?, ?, ?, ?)`
      )
      .run(
        event.sessionId,
        event.deviceKey,
        event.generatorName,
        event.success ? 1 : 0,
        Math.round(event.durationMs),
        event.error?.slice(0, 500) ?? null
      );
  }

  pruneOldEvents(retentionDays = STATS_RETENTION_DAYS) {
    Store.db
      .prepare(`DELETE FROM image_events WHERE ts < unixepoch() - ?`)
      .run(retentionDays * 24 * 3600);
  }

  /**
   * @param since unix seconds; the viewer passes local midnight at the start of the period
   * @param timeZone IANA time zone the viewer groups days and hours in
   */
  getSessionStats(session: SessionRecord, since: number, timeZone: string) {
    const db = Store.db;
    const id = session.id;

    const totals = db
      .prepare(
        `SELECT COUNT(*) AS total, COALESCE(SUM(success), 0) AS succeeded,
                COUNT(DISTINCT device_key) AS devices
         FROM image_events WHERE session_id = ? AND ts >= ?`
      )
      .get(id, since) as { total: number; succeeded: number; devices: number };

    const perSource = db
      .prepare(
        `SELECT generator_name AS name, COUNT(*) AS total, SUM(success) AS succeeded,
                AVG(CASE WHEN success = 1 THEN duration_ms END) AS avgDurationMs,
                (SELECT f.error FROM image_events f
                 WHERE f.session_id = e.session_id AND f.generator_name = e.generator_name
                   AND f.success = 0 AND f.ts >= ?
                 ORDER BY f.ts DESC, f.id DESC LIMIT 1) AS lastError
         FROM image_events e WHERE session_id = ? AND ts >= ?
         GROUP BY generator_name ORDER BY succeeded DESC`
      )
      .all(since, id, since) as {
      name: string;
      total: number;
      succeeded: number;
      avgDurationMs: number | null;
      lastError: string | null;
    }[];

    // Grouped in the viewer's time zone: SQLite only knows the server's (usually UTC)
    const images = db
      .prepare(`SELECT ts, generator_name AS name FROM image_events WHERE session_id = ? AND ts >= ? AND success = 1`)
      .all(id, since) as { ts: number; name: string }[];
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      hourCycle: 'h23',
    });
    const dailyCounts = new Map<string, { day: string; name: string; count: number }>();
    const hourCounts = new Array<number>(24).fill(0);
    for (const image of images) {
      const p = Object.fromEntries(parts.formatToParts(new Date(image.ts * 1000)).map((x) => [x.type, x.value]));
      const day = `${p.year}-${p.month}-${p.day}`;
      const entry = dailyCounts.get(`${day}|${image.name}`) ?? { day, name: image.name, count: 0 };
      entry.count++;
      dailyCounts.set(`${day}|${image.name}`, entry);
      hourCounts[Number(p.hour)]++;
    }

    const perDevice = db
      .prepare(
        `SELECT e.device_key AS key, d.label AS label, COUNT(*) AS count, MAX(e.ts) AS lastTs
         FROM image_events e
         LEFT JOIN session_devices d ON d.session_id = e.session_id AND d.device_key = e.device_key
         WHERE e.session_id = ? AND e.ts >= ? AND e.success = 1
         GROUP BY e.device_key ORDER BY count DESC`
      )
      .all(id, since) as { key: string | null; label: string | null; count: number; lastTs: number }[];

    // Failures grouped by source and message, most recent first
    const problems = db
      .prepare(
        `SELECT generator_name AS name, error, COUNT(*) AS count, MIN(ts) AS firstTs, MAX(ts) AS lastTs
         FROM image_events WHERE session_id = ? AND ts >= ? AND success = 0
         GROUP BY generator_name, error ORDER BY lastTs DESC LIMIT 25`
      )
      .all(id, since) as { name: string; error: string | null; count: number; firstTs: number; lastTs: number }[];

    const allTime = db
      .prepare(`SELECT COUNT(*) AS count FROM image_events WHERE session_id = ? AND success = 1`)
      .get(id) as { count: number };

    return {
      since: new Date(since * 1000).toISOString(),
      createdAt: session.createdAt,
      totals: { ...totals, failed: totals.total - totals.succeeded },
      allTimeImages: allTime.count,
      perSource,
      daily: [...dailyCounts.values()].sort((x, y) => x.day.localeCompare(y.day)),
      hourly: hourCounts.map((count, hour) => ({ hour, count })),
      problems: problems.map((p) => ({
        name: p.name,
        error: p.error ?? 'Unknown error',
        count: p.count,
        firstAt: new Date(p.firstTs * 1000).toISOString(),
        lastAt: new Date(p.lastTs * 1000).toISOString(),
      })),
      perDevice: perDevice.map((d) => ({
        key: d.key,
        label: d.label ?? (d.key?.startsWith('name:') ? d.key.slice(5) : 'Removed display'),
        count: d.count,
        lastAt: new Date(d.lastTs * 1000).toISOString(),
      })),
    };
  }
}
