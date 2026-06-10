import { Store } from '../Store.js';
import type { ContentInfo, JsonObject } from '../types/index.js';

export class ImageGeneratorStore<PrevDataT extends JsonObject> extends Store {
  constructor(
    private sessionId: string,
    private generatorName: string
  ) {
    super();
  }

  getPrevData(): PrevDataT | null {
    const row = Store.db
      .prepare(
        `SELECT prev_data FROM session_generator_data WHERE session_id = ? AND generator_name = ?`
      )
      .get(this.sessionId, this.generatorName) as { prev_data: string } | undefined;
    if (!row) {
      return null;
    }
    return JSON.parse(row.prev_data) as PrevDataT;
  }

  setPrevData(prevData: PrevDataT) {
    Store.db
      .prepare(
        `INSERT INTO session_generator_data (session_id, generator_name, prev_data) VALUES (?, ?, ?) ON CONFLICT(session_id, generator_name) DO UPDATE SET prev_data = excluded.prev_data`
      )
      .run(this.sessionId, this.generatorName, JSON.stringify(prevData));
  }

  setInfo(info: ContentInfo) {
    Store.db
      .prepare(
        `INSERT INTO session_generator_data (session_id, generator_name, prev_info_title, prev_info_description, prev_info_source_url) VALUES (?, ?, ?, ?, ?) ON CONFLICT(session_id, generator_name) DO UPDATE SET prev_info_title = excluded.prev_info_title, prev_info_description = excluded.prev_info_description, prev_info_source_url = excluded.prev_info_source_url`
      )
      .run(
        this.sessionId,
        this.generatorName,
        info?.title ?? null,
        info?.description ?? null,
        info?.sourceUrl ?? null
      );
  }

  getInfo(): ContentInfo {
    const row = Store.db
      .prepare(
        `SELECT prev_info_title, prev_info_description, prev_info_source_url FROM session_generator_data WHERE session_id = ? AND generator_name = ?`
      )
      .get(this.sessionId, this.generatorName) as
      | {
          prev_info_title: string | null;
          prev_info_description: string | null;
          prev_info_source_url: string | null;
        }
      | undefined;
    if (!row) {
      return null;
    }
    return {
      title: row.prev_info_title ?? '',
      description: row.prev_info_description ?? '',
      sourceUrl: row.prev_info_source_url ?? '',
    };
  }
}
