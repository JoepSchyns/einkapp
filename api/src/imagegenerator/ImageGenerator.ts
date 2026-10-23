import { getSessionSourceSettings, type EinkApplication, type ContentInfo, type JsonObject } from '../types/index.js';
import { ImageGeneratorStore } from './imageGeneratorStore.js';
import { getSourceSettings } from '../settings/settings.js';
import { SessionStore } from '../session/SessionStore.js';

export interface GeneratorParam {
  key: string;
  label: string;
  default: string;
  description?: string;
  /** The allowed values, shown as a dropdown in the admin interface */
  options?: { value: string; label: string }[];
  /** More than one option can be chosen, stored comma separated */
  multiple?: boolean;
}

export abstract class ImageGenerator<
  PrevDataT extends JsonObject = JsonObject,
> implements EinkApplication {
  /** Human readable name shown in the admin interface */
  static label: string = '';
  /** Environment variables that must be set for this source to work */
  static requiredEnv: string[] = [];
  /** Parameters the admin can change globally */
  static params: GeneratorParam[] = [];

  protected store: ImageGeneratorStore<PrevDataT>;
  private sessionStore: SessionStore;
  /** Resolved parameter values; cleared before every image so settings changes apply right away */
  private resolvedParams: Record<string, string> | null = null;
  constructor(sessionId: string) {
    this.store = new ImageGeneratorStore<PrevDataT>(sessionId, this.constructor.name);
    this.sessionStore = new SessionStore(sessionId);
  }

  /** Called before generating an image, so the next param() call reads the current settings */
  resetParams() {
    this.resolvedParams = null;
  }

  /** Parameter value: the session override, else the global setting, else the built-in default. */
  protected param(key: string): string {
    if (!this.resolvedParams) {
      const name = this.constructor.name;
      const session = getSessionSourceSettings(this.sessionStore.getSettings(), name).params;
      const global = getSourceSettings(name).params;
      this.resolvedParams = Object.fromEntries(
        (this.constructor as typeof ImageGenerator).params.map((p) => [
          p.key,
          session[p.key]?.trim() || global[p.key]?.trim() || p.default,
        ])
      );
    }
    const value = this.resolvedParams[key];
    if (value === undefined) {
      throw new Error(`Unknown parameter ${key} for ${this.constructor.name}`);
    }
    return value;
  }

  /** Download an image, failing early on error responses or anything that isn't an image. */
  protected async downloadImage(
    url: string,
    init?: RequestInit
  ): Promise<{ stream: ReadableStream; contentType: string }> {
    const source = (this.constructor as typeof ImageGenerator).label || this.constructor.name;
    const response = await fetch(url, init);
    if (!response.ok) {
      throw new Error(`${source} returned ${response.status} for image ${url}`);
    }
    if (!response.body) {
      throw new Error(`Could not get image stream from ${source}.`);
    }
    const contentType = response.headers.get('Content-Type');
    if (!contentType?.startsWith('image/')) {
      throw new Error(`Unexpected content type from ${source}: ${contentType}`);
    }
    return { stream: response.body, contentType };
  }

  abstract getContent(): Promise<{ stream: ReadableStream; contentType: string }>;
  abstract getInfo(): Promise<ContentInfo>;
}
