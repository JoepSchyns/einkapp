import { randomBytes, randomUUID } from 'node:crypto';
import { Store } from '../Store.js';

/** A webhook in Home Assistant that updates the session's info displays linked through it */
export interface HomeAssistantWebhook {
  id: string;
  name: string;
  /** Base URL einkapp reaches Home Assistant on, e.g. http://homeassistant.local:8123 */
  homeAssistantUrl: string;
  /** Secret id of the webhook trigger in Home Assistant, generated here */
  webhookId: string;
}

interface WebhookRow {
  id: string;
  name: string;
  homeassistant_url: string;
  webhook_id: string;
}

const COLUMNS = 'id, name, homeassistant_url, webhook_id';

const toWebhook = (row: WebhookRow): HomeAssistantWebhook => ({
  id: row.id,
  name: row.name,
  homeAssistantUrl: row.homeassistant_url,
  webhookId: row.webhook_id,
});

/** Webhooks belong to a session and are removed with it */
export class HomeAssistantStore extends Store {
  list(sessionId: string): HomeAssistantWebhook[] {
    const rows = Store.db
      .prepare(`SELECT ${COLUMNS} FROM homeassistant_webhooks WHERE session_id = ? ORDER BY name`)
      .all(sessionId) as unknown as WebhookRow[];
    return rows.map(toWebhook);
  }

  get(sessionId: string, id: string): HomeAssistantWebhook | null {
    const row = Store.db
      .prepare(`SELECT ${COLUMNS} FROM homeassistant_webhooks WHERE session_id = ? AND id = ?`)
      .get(sessionId, id) as unknown as WebhookRow | undefined;
    return row ? toWebhook(row) : null;
  }

  create(sessionId: string, name: string, homeAssistantUrl: string): HomeAssistantWebhook {
    const webhook = {
      id: randomUUID(),
      name,
      homeAssistantUrl,
      webhookId: `einkapp-${randomBytes(24).toString('hex')}`,
    };
    Store.db
      .prepare(
        `INSERT INTO homeassistant_webhooks (id, session_id, name, homeassistant_url, webhook_id) VALUES (?, ?, ?, ?, ?)`
      )
      .run(webhook.id, sessionId, webhook.name, webhook.homeAssistantUrl, webhook.webhookId);
    return webhook;
  }

  update(sessionId: string, id: string, name: string, homeAssistantUrl: string): boolean {
    const result = Store.db
      .prepare(
        `UPDATE homeassistant_webhooks SET name = ?, homeassistant_url = ? WHERE session_id = ? AND id = ?`
      )
      .run(name, homeAssistantUrl, sessionId, id);
    return result.changes > 0;
  }

  /** Also unlinks every info display that used this webhook */
  delete(sessionId: string, id: string): boolean {
    return (
      Store.db
        .prepare(`DELETE FROM homeassistant_webhooks WHERE session_id = ? AND id = ?`)
        .run(sessionId, id).changes > 0
    );
  }
}
