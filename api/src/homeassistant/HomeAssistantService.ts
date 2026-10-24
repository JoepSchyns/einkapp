import type { InfoDisplay } from '../types/index.js';
import { HomeAssistantStore } from './HomeAssistantStore.js';

const CALL_TIMEOUT_MS = 10 * 1000;

/**
 * Asks Home Assistant to update info displays through its OpenDisplay integration, for displays our
 * own BLE service can't reach. It only calls one of the session's webhooks: the automation behind it
 * (shown on the session's info displays tab) builds the image URL itself, finds the display and
 * retries until it wakes, so this app holds no Home Assistant credentials.
 */
export class HomeAssistantService {
  readonly webhooks = new HomeAssistantStore();

  /** Tells Home Assistant to show the session's current info image on each display */
  async pushImage(devices: InfoDisplay[], sessionId: string): Promise<void> {
    // Every display is tried, and every failure reported, even when an earlier one fails
    const results = await Promise.allSettled(
      devices.map(async (device) => {
        const webhook = device.webhook ? this.webhooks.get(sessionId, device.webhook) : null;
        if (!webhook) {
          throw new Error(`Info display ${device.mac} has no Home Assistant webhook`);
        }
        // Home Assistant answers 200 to every webhook call, so this only confirms it was reached
        const res = await fetch(`${webhook.homeAssistantUrl}/api/webhook/${webhook.webhookId}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ mac: device.mac.toUpperCase(), session: sessionId }),
          signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
        });
        if (!res.ok) {
          throw new Error(
            `Home Assistant webhook ${webhook.name} for ${device.mac} failed: ${res.status} ${res.statusText}`
          );
        }
      })
    );
    const errors = results.flatMap((r) => (r.status === 'rejected' ? [r.reason] : []));
    if (errors.length > 0) {
      throw new AggregateError(
        errors,
        `${errors.length} of ${devices.length} Home Assistant info displays failed`
      );
    }
  }
}
