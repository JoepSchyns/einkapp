export interface SourceParam {
  key: string;
  label: string;
  default: string;
  description?: string;
  options?: { value: string; label: string }[];
  multiple?: boolean;
  value: string;
}

export interface SourceInfo {
  name: string;
  label: string;
  available: boolean;
  missingEnv: string[];
  enabled: boolean;
  weight: number;
  params: SourceParam[];
}

export interface GlobalSettings {
  sessionTtlHours: number;
  sources: SourceInfo[];
}

export interface SessionSourceSettings {
  enabled: boolean;
  weight: number | null;
  params: Record<string, string>;
}

export interface SessionSettings {
  /** Overrides per source; sources without an entry use the global settings */
  sources: Record<string, SessionSourceSettings>;
  ttlHours: number | null;
}

export interface SessionDetails {
  id: string;
  name: string | null;
  createdAt: string | null;
  lastAccessedAt: string;
  generatorName: string | null;
  settings: SessionSettings;
  ttlHours: number;
  expiresAt: string | null;
  effectiveSources: string[];
}

export interface ResizeParams {
  w: number;
  h: number;
  fit: string;
  brightness: number;
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

/** A webhook in Home Assistant that updates the info displays linked through it */
export interface HomeAssistantWebhook {
  id: string;
  name: string;
  homeAssistantUrl: string;
  webhookId: string;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** fetch() wrapper for the admin API: JSON in, JSON out, throws ApiError with the server's message */
export async function api<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await fetch(`/api/admin${path}`, {
    method: init.method ?? 'GET',
    headers: init.body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    throw new ApiError(res.status, (data as { error?: string } | null)?.error ?? res.statusText);
  }
  return data as T;
}

export function formatHours(hours: number): string {
  if (hours === 0) return 'never';
  if (hours % 24 === 0) return `${hours / 24} day${hours === 24 ? '' : 's'}`;
  return `${hours} hour${hours === 1 ? '' : 's'}`;
}

/** "in 3 hours" / "5 minutes ago" */
export function formatRelative(iso: string): string {
  const diffS = (new Date(iso).getTime() - Date.now()) / 1000;
  const units: [Intl.RelativeTimeFormatUnit, number][] = [
    ['day', 86400],
    ['hour', 3600],
    ['minute', 60],
  ];
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
  for (const [unit, seconds] of units) {
    if (Math.abs(diffS) >= seconds) return rtf.format(Math.round(diffS / seconds), unit);
  }
  return rtf.format(Math.round(diffS), 'second');
}

export function sourceLabel(sources: SourceInfo[], name: string | null): string {
  if (!name) return '—';
  return sources.find((s) => s.name === name)?.label ?? name;
}
