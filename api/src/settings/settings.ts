import { SettingsStore } from './SettingsStore.js';
import { ImageGeneratorStore } from '../imagegenerator/imageGeneratorStore.js';
import { paramsDiffer } from '../types/index.js';

export interface SourceSettings {
  enabled: boolean;
  weight: number;
  params: Record<string, string>;
}

export interface GlobalSettings {
  sessionTtlHours: number;
  sources: Record<string, SourceSettings>;
}

export const DEFAULT_SESSION_TTL_HOURS = 24;
export const DEFAULT_SOURCE_SETTINGS: SourceSettings = { enabled: true, weight: 1, params: {} };

const store = new SettingsStore();

export function getSessionTtlHours(): number {
  return store.get<number>('sessionTtlHours') ?? DEFAULT_SESSION_TTL_HOURS;
}

function getAllSourceSettings(): Record<string, SourceSettings> {
  return store.get<Record<string, SourceSettings>>('sources') ?? {};
}

export function getSourceSettings(generatorName: string): SourceSettings {
  const stored = getAllSourceSettings()[generatorName];
  return { ...DEFAULT_SOURCE_SETTINGS, ...stored, params: { ...stored?.params } };
}

export function getGlobalSettings(generatorNames: string[]): GlobalSettings {
  return {
    sessionTtlHours: getSessionTtlHours(),
    sources: Object.fromEntries(generatorNames.map((name) => [name, getSourceSettings(name)])),
  };
}

/** Persists already-validated settings. Clears generator cursors whose parameters changed. */
export function saveGlobalSettings(next: GlobalSettings) {
  const previous = getAllSourceSettings();
  for (const [name, source] of Object.entries(next.sources)) {
    if (paramsDiffer(previous[name]?.params, source.params)) {
      ImageGeneratorStore.clearPrevData(name);
    }
  }
  store.set('sessionTtlHours', next.sessionTtlHours);
  store.set('sources', { ...previous, ...next.sources });
}
