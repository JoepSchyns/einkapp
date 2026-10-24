import { Session } from '../session/Session.js';
import {
  getSessionSourceSettings,
  NotFoundError,
  paramsDiffer,
  type ContentInfo,
  type InfoDisplay,
  type SessionSettings,
} from '../types/index.js';
import { ImageGeneratorStore } from '../imagegenerator/imageGeneratorStore.js';
import { ApplicationStore, type SessionRecord } from './ApplicationStore.js';
import { BleService } from '../ble/BleService.js';
import { HomeAssistantService } from '../homeassistant/HomeAssistantService.js';
import type { HomeAssistantWebhook } from '../homeassistant/HomeAssistantStore.js';
import type { ScannedDevice } from '../ble/BleService.js';
import { ScreenshotService } from '../screenshot/ScreenshotService.js';
import { DeviceStore, type ResizeParams, type SessionDevice } from '../devices/DeviceStore.js';
import { StatsStore } from '../stats/StatsStore.js';
import { getSessionTtlHours } from '../settings/settings.js';
import { getUsableGeneratorNames } from '../imagegenerator/GeneratorRegistry.js';
import { makeThumbnail, resizeImage } from '../image/imageProcessing.js';
import { emitAdminEvent } from '../events/adminEvents.js';

const HOUR_MS = 60 * 60 * 1000;
/** How long a failed info screenshot is kept, so repeated requests don't each start a new one */
const INFO_IMAGE_FAILURE_COOLDOWN_MS = 10 * 1000;

export interface DisplayRequest {
  device: { key: string; label: string };
  resize: ResizeParams | null;
}

export interface SessionDetails extends SessionRecord {
  /** null when the session never expires */
  expiresAt: string | null;
  ttlHours: number;
  effectiveSources: string[];
}

export class Application {
  private static readonly SESSION_KICK_INTERVAL_MS = 10 * 60 * 1000; // 10 minutes

  private store: ApplicationStore;
  private readonly deviceStore = new DeviceStore();
  private readonly statsStore = new StatsStore();
  private readonly sessions = new Map<string, Session>();
  private infoSubscribers = new Map<string, ((info: ContentInfo) => void)[]>();
  private readonly bleService = new BleService();
  /** Reaches info displays linked through Home Assistant */
  private readonly homeAssistant = new HomeAssistantService();
  private readonly screenshotService = new ScreenshotService();
  /** Rendered info page per session, dropped whenever the info changes */
  private readonly infoImages = new Map<string, Promise<Buffer>>();

  constructor() {
    this.store = new ApplicationStore();
    const kick = () => {
      try {
        this.kickOldSessions();
      } catch (err) {
        console.error(err);
        process.exit(1);
      }
    };
    kick();
    setInterval(kick, Application.SESSION_KICK_INTERVAL_MS).unref();
  }

  /** Session TTL in hours, taking the global default into account. 0 means never expire. */
  private getEffectiveTtlHours(settings: SessionSettings): number {
    return settings.ttlHours ?? getSessionTtlHours();
  }

  private kickOldSessions() {
    const now = Date.now();
    for (const session of this.store.getSessions()) {
      const ttlMs = this.getEffectiveTtlHours(session.settings) * HOUR_MS;
      if (ttlMs === 0) continue;
      if (now - new Date(session.lastAccessedAt).getTime() > ttlMs) {
        this.store.deleteSession(session.id);
        this.sessions.delete(session.id);
        emitAdminEvent({ type: 'session', sessionId: session.id, deleted: true });
        console.info(`Kicked session ${session.id} due to inactivity.`);
      } else {
        this.deviceStore.removeStaleDevices(session.id, ttlMs);
      }
    }
    this.statsStore.pruneOldEvents();
  }

  private getSessionById(sessionId: string): Session {
    let session = this.sessions.get(sessionId);
    if (!session) {
      if (!this.store.sessionExists(sessionId)) {
        throw new NotFoundError(`Session with id ${sessionId} not found.`);
      }
      session = new Session(sessionId);
      this.sessions.set(sessionId, session);
    }
    return session;
  }

  /** Generates a new image for a display and remembers what that device is now showing. */
  async getDisplayImage(
    sessionId: string,
    request: DisplayRequest
  ): Promise<{ body: Buffer; contentType: string }> {
    const session = this.getSessionById(sessionId);
    this.store.updateSessionAccessTime(sessionId);
    const resize = request.resize;
    let output;
    try {
      output = await session.getContent(
        request.device.key,
        resize ? (image) => resizeImage(image.buffer, resize) : undefined
      );
    } catch (err) {
      // Failures show up in the statistics, so the admin interface still wants to know
      emitAdminEvent({ type: 'image', sessionId });
      throw err;
    }
    const { info } = output;

    let thumbnail: Buffer | null = null;
    try {
      thumbnail = await makeThumbnail(output.buffer);
    } catch (err) {
      console.error('Failed to create thumbnail:', err);
    }
    // The session can be deleted while an image is generated; still serve the image, just don't track it
    if (!this.store.sessionExists(sessionId)) {
      return { body: output.buffer, contentType: output.contentType };
    }
    this.deviceStore.upsertDevice({
      sessionId,
      deviceKey: request.device.key,
      label: request.device.label,
      generatorName: output.generatorName,
      info,
      resize,
      thumbnail,
    });
    emitAdminEvent({ type: 'image', sessionId });

    // Drop the old screenshot, then notify all info-sse subscribers so info is up-to-date before screenshotting
    this.infoImages.delete(sessionId);
    const subscribers = this.infoSubscribers.get(sessionId) || [];
    subscribers.forEach((cb) => cb(info));

    // Push a screenshot of the info page to all linked info displays. Home Assistant runs in the
    // background, so the display requesting this image doesn't wait on it.
    const infoDisplays = this.store.getSessionInfoDisplays(sessionId);
    void this.pushToHomeAssistant(
      sessionId,
      infoDisplays.filter((d) => d.via === 'homeassistant')
    );
    await this.pushToBluetooth(
      sessionId,
      infoDisplays.filter((d) => d.via === 'bluetooth')
    );

    return { body: output.buffer, contentType: output.contentType };
  }

  private async pushToBluetooth(sessionId: string, devices: InfoDisplay[]): Promise<void> {
    if (devices.length === 0) return;
    try {
      const imageBytes = await this.getInfoImage(sessionId);
      await this.bleService.pushImage(devices, imageBytes, 'image/png');
    } catch (err) {
      console.error('Failed to push screenshot to BLE devices:', err);
    }
  }

  private async pushToHomeAssistant(sessionId: string, devices: InfoDisplay[]): Promise<void> {
    if (devices.length === 0) return;
    try {
      // Home Assistant downloads /api/session/:id/info.png itself
      await this.homeAssistant.pushImage(devices, sessionId);
    } catch (err) {
      console.error('Failed to push screenshot through Home Assistant:', err);
    }
  }

  /** Screenshot of the session's info page, sized for the small e-ink info display */
  getInfoImage(sessionId: string): Promise<Buffer> {
    this.getSessionById(sessionId); // validates session exists
    let image = this.infoImages.get(sessionId);
    if (!image) {
      const frontendUrl = (process.env.FRONTEND_INTERNAL_URL ?? 'http://frontend').replace(
        /\/$/,
        ''
      );
      const infoUrl = `${frontendUrl}/info?id=${encodeURIComponent(sessionId)}`;
      const screenshot = this.screenshotService.screenshot(
        infoUrl,
        250,
        122,
        '#title:not(.hidden)'
      );
      // Keep failures only briefly, so a later request tries again. Only drop this screenshot,
      // not a newer one cached after the info changed.
      screenshot.catch(() =>
        setTimeout(() => {
          if (this.infoImages.get(sessionId) === screenshot) this.infoImages.delete(sessionId);
        }, INFO_IMAGE_FAILURE_COOLDOWN_MS).unref()
      );
      this.infoImages.set(sessionId, screenshot);
      image = screenshot;
    }
    return image;
  }

  getInfo(sessionId: string): Promise<ContentInfo> {
    const session = this.getSessionById(sessionId);
    return session.getInfo();
  }

  async subscribeToInfoUpdates(sessionId: string, callback: (info: ContentInfo) => void) {
    const session = this.getSessionById(sessionId);
    const currentInfo = await session.getInfo();
    callback(currentInfo);

    const subscribers = this.infoSubscribers.get(sessionId) || [];
    subscribers.push(callback);
    this.infoSubscribers.set(sessionId, subscribers);

    const unsubscribe = () => {
      const subs = this.infoSubscribers.get(sessionId);
      if (subs) {
        const index = subs.indexOf(callback);
        if (index !== -1) subs.splice(index, 1);
      }
    };
    return unsubscribe;
  }

  createNewSession(name: string | null = null, settings?: SessionSettings): string {
    const newSession = new Session();
    this.store.setNewSession(newSession.id, name, settings);
    this.sessions.set(newSession.id, newSession);
    emitAdminEvent({ type: 'session', sessionId: newSession.id });
    return newSession.id;
  }

  updateSession(sessionId: string, name: string | null, settings: SessionSettings): void {
    const current = this.store.getSessionById(sessionId);
    if (!current) {
      throw new NotFoundError('Session not found');
    }
    this.store.updateSession(sessionId, name, settings);
    for (const generatorName of new Set([
      ...Object.keys(current.settings.sources),
      ...Object.keys(settings.sources),
    ])) {
      const before = getSessionSourceSettings(current.settings, generatorName).params;
      const after = getSessionSourceSettings(settings, generatorName).params;
      if (paramsDiffer(before, after)) {
        ImageGeneratorStore.clearPrevData(generatorName, sessionId);
      }
    }
    emitAdminEvent({ type: 'session', sessionId });
  }

  deleteSession(sessionId: string): void {
    if (!this.store.sessionExists(sessionId)) {
      throw new NotFoundError('Session not found');
    }
    this.store.deleteSession(sessionId);
    this.sessions.delete(sessionId);
    this.infoImages.delete(sessionId);
    emitAdminEvent({ type: 'session', sessionId, deleted: true });
  }

  /**
   * Adds what the admin interface shows but isn't stored: the effective expiry and the sources the
   * session actually uses (`usable` = sources configured and switched on globally).
   */
  private withExpiryAndSources(record: SessionRecord, usable: string[]): SessionDetails {
    const ttlHours = this.getEffectiveTtlHours(record.settings);
    return {
      ...record,
      ttlHours,
      expiresAt:
        ttlHours === 0
          ? null
          : new Date(new Date(record.lastAccessedAt).getTime() + ttlHours * HOUR_MS).toISOString(),
      effectiveSources: usable.filter(
        (name) => getSessionSourceSettings(record.settings, name).enabled
      ),
    };
  }

  async getSessions(): Promise<SessionDetails[]> {
    const usable = await getUsableGeneratorNames();
    return this.store.getSessions().map((s) => this.withExpiryAndSources(s, usable));
  }

  async getSession(sessionId: string): Promise<SessionDetails | null> {
    const record = this.store.getSessionById(sessionId);
    return record ? this.withExpiryAndSources(record, await getUsableGeneratorNames()) : null;
  }

  getSessionDevices(sessionId: string): SessionDevice[] {
    this.getSessionById(sessionId); // validates session exists
    return this.deviceStore.getDevices(sessionId);
  }

  getDeviceThumbnail(sessionId: string, deviceKey: string): Uint8Array | null {
    return this.deviceStore.getThumbnail(sessionId, deviceKey);
  }

  removeSessionDevice(sessionId: string, deviceKey: string): boolean {
    const removed = this.deviceStore.removeDevice(sessionId, deviceKey);
    if (removed) emitAdminEvent({ type: 'session', sessionId });
    return removed;
  }

  getSessionStats(sessionId: string, since: number, timeZone: string) {
    const session = this.store.getSessionById(sessionId);
    if (!session) {
      throw new NotFoundError('Session not found');
    }
    return this.statsStore.getSessionStats(session, since, timeZone);
  }

  scanBleDevices(timeout = 5): Promise<ScannedDevice[]> {
    return this.bleService.scan(timeout);
  }

  getSessionInfoDisplays(sessionId: string): InfoDisplay[] {
    this.getSessionById(sessionId); // validates session exists
    return this.store.getSessionInfoDisplays(sessionId);
  }

  addSessionInfoDisplay(sessionId: string, device: InfoDisplay): void {
    this.getSessionById(sessionId); // validates session exists
    this.store.addSessionInfoDisplay(sessionId, device);
    emitAdminEvent({ type: 'session', sessionId });
  }

  getHomeAssistantWebhooks(sessionId: string): HomeAssistantWebhook[] {
    this.getSessionById(sessionId); // validates session exists
    return this.homeAssistant.webhooks.list(sessionId);
  }

  getHomeAssistantWebhook(sessionId: string, id: string): HomeAssistantWebhook | null {
    return this.homeAssistant.webhooks.get(sessionId, id);
  }

  addHomeAssistantWebhook(
    sessionId: string,
    name: string,
    homeAssistantUrl: string
  ): HomeAssistantWebhook {
    this.getSessionById(sessionId); // validates session exists
    const webhook = this.homeAssistant.webhooks.create(sessionId, name, homeAssistantUrl);
    emitAdminEvent({ type: 'session', sessionId });
    return webhook;
  }

  /** Returns the updated webhook, or null when the session has no such webhook */
  updateHomeAssistantWebhook(
    sessionId: string,
    id: string,
    name: string,
    homeAssistantUrl: string
  ): HomeAssistantWebhook | null {
    if (!this.homeAssistant.webhooks.update(sessionId, id, name, homeAssistantUrl)) return null;
    emitAdminEvent({ type: 'session', sessionId });
    return this.homeAssistant.webhooks.get(sessionId, id);
  }

  /** Also unlinks the info displays that used it; false when the session has no such webhook */
  removeHomeAssistantWebhook(sessionId: string, id: string): boolean {
    if (!this.homeAssistant.webhooks.delete(sessionId, id)) return false;
    emitAdminEvent({ type: 'session', sessionId });
    return true;
  }

  removeSessionInfoDisplay(sessionId: string, mac: string): void {
    this.getSessionById(sessionId); // validates session exists
    this.store.removeSessionInfoDisplay(sessionId, mac);
    emitAdminEvent({ type: 'session', sessionId });
  }
}
