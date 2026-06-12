import { Session } from '../session/Session.js';
import type { EinkApplication, ContentInfo } from '../types/index.js';
import { ApplicationStore } from './ApplicationStore.js';
import { BleService } from '../ble/BleService.js';
import type { BleDevice, ScannedDevice } from '../ble/BleService.js';

export class Application implements EinkApplication {
  private static readonly SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 1 day
  private static readonly SESSION_KICK_INTERVAL_MS = 10 * 60 * 1000; // 10 minutes

  private store: ApplicationStore;
  private readonly sessions = new Map<string, Session>();
  private infoSubscribers = new Map<string, ((info: ContentInfo) => void)[]>();
  private readonly bleService = new BleService();
  
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

  private kickOldSessions() {
    const sessionIds = this.store.getSessionIds();
    const now = Date.now();
    for (const sessionId of sessionIds) {
      const lastAccessed = this.store.getSessionLastAccessTime(sessionId);
      if (now - lastAccessed > Application.SESSION_TTL_MS) {
        this.store.deleteSession(sessionId);
        this.sessions.delete(sessionId);
        console.info(`Kicked session ${sessionId} due to inactivity.`);
      }
    }
  }

  private getSessionById(sessionId: string): Session {
    let session = this.sessions.get(sessionId);
    if (!session) {
      const sessionIds = this.store.getSessionIds();
      if (!sessionIds.includes(sessionId)) {
        throw new Error(`Session with id ${sessionId} not found.`);
      }
      session = new Session(sessionId);
      this.sessions.set(sessionId, session);
    }
    return session;
  }

  async getContent(sessionId: string): Promise<{ stream: ReadableStream; contentType: string }> {
    const session = this.getSessionById(sessionId);
    this.store.updateSessionAccessTime(sessionId);
    const content = await session.getContent();

    // TODO notify all BLE devices
    // await Promise.all(this.store.getSessionBleDevices(sessionId).map(device => 
    //   this.bleService.pushImage([device], Buffer.from(TODO), content.contentType)
    // ));

    // Notify all info-sse subscribers
    const subscribers = this.infoSubscribers.get(sessionId) || [];
    await Promise.all(subscribers.map(async (cb) => cb(await session.getInfo())));
    
    return { stream: content.stream, contentType: content.contentType };
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

  async createNewSession(): Promise<string> {
    const newSession = new Session();
    this.sessions.set(newSession.id, newSession);
    await this.store.setNewSession(newSession.id);
    return newSession.id;
  }

  deleteSession(sessionId: string): void {
    if (!this.sessions.has(sessionId)) {
      throw new Error('Session not found');
    }
    this.store.deleteSession(sessionId);
    this.sessions.delete(sessionId);
  }

  getSessions(): { id: string; lastAccessedAt: string; generatorName: string | null }[] {
    return this.store.getSessions();
  }

  getSession(sessionId: string): { id: string; lastAccessedAt: string; generatorName: string | null } | null {
    return this.store.getSessionById(sessionId);
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
  }

  removeSessionBleDevice(sessionId: string, mac: string): void {
    this.getSessionById(sessionId); // validates session exists
    this.store.removeSessionBleDevice(sessionId, mac);
  }
}
