import { Store } from '../Store.js';
import type { ContentInfo } from '../types/index.js';

export interface ResizeParams {
  w: number;
  h: number;
  fit: string;
  brightness: number;
}

export interface DeviceUpdate {
  sessionId: string;
  deviceKey: string;
  label: string;
  generatorName: string;
  info: ContentInfo;
  resize: ResizeParams | null;
  thumbnail: Buffer | null;
}

export interface SessionDevice {
  key: string;
  label: string;
  lastSeenAt: string;
  generatorName: string | null;
  title: string | null;
  sourceUrl: string | null;
  resize: ResizeParams | null;
  hasThumbnail: boolean;
}

export class DeviceStore extends Store {
  upsertDevice(update: DeviceUpdate) {
    Store.db
      .prepare(
        `INSERT INTO session_devices (session_id, device_key, label, last_seen_unix, generator_name, title, source_url, resize_params, thumbnail)
         VALUES (?, ?, ?, unixepoch(), ?, ?, ?, ?, ?)
         ON CONFLICT (session_id, device_key) DO UPDATE SET
           label = excluded.label,
           last_seen_unix = excluded.last_seen_unix,
           generator_name = excluded.generator_name,
           title = excluded.title,
           source_url = excluded.source_url,
           resize_params = excluded.resize_params,
           thumbnail = COALESCE(excluded.thumbnail, session_devices.thumbnail)`
      )
      .run(
        update.sessionId,
        update.deviceKey,
        update.label,
        update.generatorName,
        update.info?.title ?? null,
        update.info?.sourceUrl ?? null,
        update.resize ? JSON.stringify(update.resize) : null,
        update.thumbnail
      );
  }

  getDevices(sessionId: string): SessionDevice[] {
    const rows = Store.db
      .prepare(
        `SELECT device_key, label, last_seen_unix, generator_name, title, source_url, resize_params,
                thumbnail IS NOT NULL AS has_thumbnail
         FROM session_devices WHERE session_id = ? ORDER BY last_seen_unix DESC`
      )
      .all(sessionId) as {
      device_key: string;
      label: string;
      last_seen_unix: number;
      generator_name: string | null;
      title: string | null;
      source_url: string | null;
      resize_params: string | null;
      has_thumbnail: number;
    }[];
    return rows.map((r) => ({
      key: r.device_key,
      label: r.label,
      lastSeenAt: new Date(r.last_seen_unix * 1000).toISOString(),
      generatorName: r.generator_name,
      title: r.title,
      sourceUrl: r.source_url,
      resize: r.resize_params ? (JSON.parse(r.resize_params) as ResizeParams) : null,
      hasThumbnail: Boolean(r.has_thumbnail),
    }));
  }

  getThumbnail(sessionId: string, deviceKey: string): Uint8Array | null {
    const row = Store.db
      .prepare(`SELECT thumbnail FROM session_devices WHERE session_id = ? AND device_key = ?`)
      .get(sessionId, deviceKey) as { thumbnail: Uint8Array | null } | undefined;
    return row?.thumbnail ?? null;
  }

  removeDevice(sessionId: string, deviceKey: string): boolean {
    const result = Store.db
      .prepare(`DELETE FROM session_devices WHERE session_id = ? AND device_key = ?`)
      .run(sessionId, deviceKey);
    return result.changes > 0;
  }

  /** Removes devices of this session that have not fetched an image within the TTL */
  removeStaleDevices(sessionId: string, ttlMs: number) {
    Store.db
      .prepare(`DELETE FROM session_devices WHERE session_id = ? AND last_seen_unix < ?`)
      .run(sessionId, Math.floor((Date.now() - ttlMs) / 1000));
  }
}
