import { api, sourceLabel } from '../../../lib/adminApi';
import { sessionPath, state } from '../sessionPage';

/** Loads the session statistics for the Statistics tab and shares them with its parts */

export interface Stats {
  since: string;
  createdAt: string | null;
  totals: { total: number; succeeded: number; failed: number; devices: number };
  allTimeImages: number;
  perSource: { name: string; total: number; succeeded: number; avgDurationMs: number | null; lastError: string | null }[];
  daily: { day: string; name: string; count: number }[];
  hourly: { hour: number; count: number }[];
  perDevice: { key: string | null; label: string; count: number; lastAt: string }[];
  problems: { name: string; error: string; count: number; firstAt: string; lastAt: string }[];
}

/** Length of the period shown, in days */
export let days = 30;
export let current: Stats | null = null;

const listeners: ((stats: Stats) => void)[] = [];

/** Called with every loaded result, and again when the colour scheme changes */
export function onStats(listener: (stats: Stats) => void) {
  listeners.push(listener);
}

export async function loadStats(periodDays = days) {
  days = periodDays;
  // Start at local midnight and group in the browser's time zone, so the bars match the totals
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - (days - 1));
  const query = new URLSearchParams({
    from: String(Math.floor(start.getTime() / 1000)),
    tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
  });
  current = await api<Stats>(`${sessionPath}/stats?${query}`);
  listeners.forEach((listener) => listener(current!));
}

// --- Shared by the parts ---

export const darkQuery = window.matchMedia('(prefers-color-scheme: dark)');
darkQuery.addEventListener('change', () => current && listeners.forEach((listener) => listener(current!)));

// Validated categorical palette (fixed order, light and dark steps)
export const PALETTE_LIGHT = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#6250d6', '#e34948'];
export const PALETTE_DARK = ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300', '#9085e9', '#e66767'];
const OTHER_COLOR = '#8a8984';

function sources() {
  return state.global?.sources ?? [];
}

/** Colour follows the source (its position in the settings list), never its rank */
export function sourceColor(name: string): string {
  const palette = darkQuery.matches ? PALETTE_DARK : PALETTE_LIGHT;
  const index = sources().findIndex((s) => s.name === name);
  return index >= 0 && index < palette.length ? palette[index] : OTHER_COLOR;
}

export function sourceName(name: string): string {
  return sourceLabel(sources(), name);
}

/** Sorts source names in settings order, so colours and legends stay in the same order */
export function bySettingsOrder(a: string, b: string) {
  return sources().findIndex((s) => s.name === a) - sources().findIndex((s) => s.name === b);
}

export function formatMs(ms: number | null): string {
  if (ms === null) return '—';
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms)} ms`;
}

/** A colour swatch for a source, used in tables and lists */
export function swatch(name: string) {
  const el = Object.assign(document.createElement('span'), { className: 'swatch' });
  el.style.background = sourceColor(name);
  return el;
}
