import { Session } from '../session/Session.js';
import { getSessionSourceSettings, paramsDiffer, type ContentInfo, type SessionSettings } from '../types/index.js';
import { ImageGeneratorStore } from '../imagegenerator/imageGeneratorStore.js';
import { ApplicationStore, type SessionRecord } from './ApplicationStore.js';
import { BleService } from '../ble/BleService.js';
import type { BleDevice, ScannedDevice } from '../ble/BleService.js';
import { ScreenshotService } from '../screenshot/ScreenshotService.js';
import { DeviceStore, type ResizeParams, type SessionDevice } from '../devices/DeviceStore.js';
import { StatsStore } from '../stats/StatsStore.js';
import { getSessionTtlHours } from '../settings/settings.js';
import { getUsableGeneratorNames } from '../imagegenerator/GeneratorRegistry.js';
import { makeThumbnail, resizeImage } from '../image/imageProcessing.js';
import { emitAdminEvent } from '../events/adminEvents.js';

const HOUR_MS = 60 * 60 * 1000;

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
  private readonly screenshotService = new ScreenshotService();

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
        throw new Error(`Session with id ${sessionId} not found.`);
      }
      session = new Session(sessionId);
      this.sessions.set(sessionId, session);
    }
    return session;
  }

  /** Generates a new image for a display and remembers what that device is now showing. */
  async getDisplayImage(sessionId: string, request: DisplayRequest): Promise<{ body: Buffer; contentType: string }> {
    const session = this.getSessionById(sessionId);
    this.store.updateSessionAccessTime(sessionId);
    const resize = request.resize;
    let output;
    try {
      output = await session.getContent(request.device.key, resize ? (image) => resizeImage(image.buffer, resize) : undefined);
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

    // Notify all info-sse subscribers first so info is up-to-date before screenshotting
    const subscribers = this.infoSubscribers.get(sessionId) || [];
    subscribers.forEach((cb) => cb(info));

    // Push a screenshot of the info page to all linked BLE displays
    const bleDevices = this.store.getSessionBleDevices(sessionId);
    if (bleDevices.length > 0) {
      try {
        const frontendUrl = (process.env.FRONTEND_INTERNAL_URL ?? 'http://frontend').replace(/\/$/, '');
        const infoUrl = `${frontendUrl}/info?id=${encodeURIComponent(sessionId)}`;
        const imageBytes = await this.screenshotService.screenshot(infoUrl, 250, 122, '#title:not(.hidden)');
        await this.bleService.pushImage(bleDevices, imageBytes, 'image/png');
      } catch (err) {
        console.error('Failed to push screenshot to BLE devices:', err);
      }
    }

    return { body: output.buffer, contentType: output.contentType };
  }

  getInfo(sessionId: string): Promise<ContentInfo> {
    const session = this.getSessionById(sessionId);
    return session.getInfo();
  }

  async subscribeToInfoUpdates(sessionId: string, callback: (info: ContentInfo) => void){
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
      throw new Error('Session not found');
    }
    this.store.updateSession(sessionId, name, settings);
    for (const generatorName of new Set([...Object.keys(current.settings.sources), ...Object.keys(settings.sources)])) {
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
      throw new Error('Session not found');
    }
    this.store.deleteSession(sessionId);
    this.sessions.delete(sessionId);
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
      effectiveSources: usable.filter((name) => getSessionSourceSettings(record.settings, name).enabled),
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
      throw new Error('Session not found');
    }
    return this.statsStore.getSessionStats(session, since, timeZone);
  }

  scanBleDevices(timeout = 5): Promise<ScannedDevice[]> {
    return this.bleService.scan(timeout);
  }

  getSessionBleDevices(sessionId: string): BleDevice[] {
    this.getSessionById(sessionId); // validates session exists
    return this.store.getSessionBleDevices(sessionId);
  }

  addSessionBleDevice(sessionId: string, mac: string, name: string | null): void {
    this.getSessionById(sessionId); // validates session exists
    this.store.addSessionBleDevice(sessionId, mac, name);
    emitAdminEvent({ type: 'session', sessionId });
  }

  removeSessionBleDevice(sessionId: string, mac: string): void {
    this.getSessionById(sessionId); // validates session exists
    this.store.removeSessionBleDevice(sessionId, mac);
    emitAdminEvent({ type: 'session', sessionId });
  }
}
