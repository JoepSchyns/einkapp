export type JsonPrimitive = string | number | boolean | null;
export type JsonArray = JsonType[];
export type JsonObject = { [key: string]: JsonType };
export type JsonType = JsonPrimitive | JsonArray | JsonObject;

export function isJsonObject(value: JsonType): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export type ContentInfo = {
  title: string;
  description: string;
  sourceUrl: string;
} | null;

export interface EinkApplication {
  getContent(...args: unknown[]): Promise<{ stream: ReadableStream; contentType: string }>;
  getInfo(...args: unknown[]): Promise<ContentInfo>;
}

/** Per-session overrides for one source. Empty values fall back to the global settings. */
export interface SessionSourceSettings {
  enabled: boolean;
  weight: number | null;
  params: Record<string, string>;
}

export interface SessionSettings {
  /** Overrides per generator name; a source without an entry is used with the global settings */
  sources: Record<string, SessionSourceSettings>;
  /** Inactivity timeout; null means the global default, 0 means never expire */
  ttlHours: number | null;
}

export const DEFAULT_SESSION_SETTINGS: SessionSettings = { sources: {}, ttlHours: null };

/** Parses the session settings JSON stored in the sessions table */
export function parseSessionSettings(json: string | null): SessionSettings {
  const raw: unknown = json ? JSON.parse(json) : null;
  const value = (raw && typeof raw === 'object' ? raw : {}) as { sources?: unknown; ttlHours?: unknown };
  const sources =
    value.sources && typeof value.sources === 'object' && !Array.isArray(value.sources)
      ? (value.sources as Record<string, SessionSourceSettings>)
      : {};
  return { sources, ttlHours: typeof value.ttlHours === 'number' ? value.ttlHours : null };
}

/** A session's settings for one source; sources without an entry are enabled with global settings */
export function getSessionSourceSettings(settings: SessionSettings, name: string): SessionSourceSettings {
  const entry = settings.sources[name];
  return { enabled: entry?.enabled ?? true, weight: entry?.weight ?? null, params: { ...entry?.params } };
}

/** Whether two sets of generator parameters differ, ignoring key order and empty values */
export function paramsDiffer(a: Record<string, string> = {}, b: Record<string, string> = {}): boolean {
  const normalize = (params: Record<string, string>) =>
    JSON.stringify(
      Object.entries(params)
        .filter(([, value]) => value)
        .sort(([x], [y]) => x.localeCompare(y))
    );
  return normalize(a) !== normalize(b);
}

/** Thrown when a request can't be served because of configuration, mapped to HTTP 503 */
export class ServiceUnavailableError extends Error {}
