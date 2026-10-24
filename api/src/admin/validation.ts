import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { getGeneratorClasses, isAvailable } from '../imagegenerator/GeneratorRegistry.js';
import { getSourceSettings } from '../settings/settings.js';

const MAX_TTL_HOURS = 24 * 365;
const MAX_WEIGHT = 100;

/** Validates a request part against a schema; failures become `400 { error }` like the other routes */
export const valid = <T extends z.ZodType>(target: 'json' | 'query', schema: T) =>
  zValidator(target, schema, (result, c) => {
    if (!result.success) {
      const [issue] = result.error.issues;
      const path = issue.path.join('.');
      return c.json({ error: path ? `${path}: ${issue.message}` : issue.message }, 400);
    }
  });

// --- Request schemas ---

const weight = z.number().min(0).max(MAX_WEIGHT);

/** Generator parameters; empty values are dropped so they fall back to the defaults */
const params = z
  .record(z.string(), z.string().trim().max(500))
  .default({})
  .transform((p) => Object.fromEntries(Object.entries(p).filter(([, value]) => value)));

export const loginSchema = z.object({
  username: z.string().max(128),
  password: z.string().max(1024),
});

export const globalSettingsSchema = z.object({
  sessionTtlHours: z.number().int().min(1).max(MAX_TTL_HOURS).optional(),
  sources: z.record(z.string(), z.object({ enabled: z.boolean(), weight, params })).default({}),
});

/** Create/update a session. Fields that are left out keep their current value. */
export const sessionOptionsSchema = z.object({
  name: z
    .string()
    .trim()
    .max(100)
    .nullable()
    .optional()
    .transform((name) => (name === undefined ? undefined : name || null)),
  // null = global default, 0 = never expire
  ttlHours: z.number().min(0).max(MAX_TTL_HOURS).nullable().optional(),
  // Overrides per source; empty weight/params fall back to the global settings
  sources: z
    .record(
      z.string(),
      z.object({
        enabled: z.boolean().default(true),
        weight: weight.nullable().default(null),
        params,
      })
    )
    .optional(),
});

export const bleDeviceSchema = z
  .object({
    mac: z
      .string()
      .regex(/^([0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}$/, 'Invalid MAC address')
      .transform((mac) => mac.toUpperCase()),
    name: z.string().max(100).nullable().default(null),
    via: z.enum(['bluetooth', 'homeassistant']).default('bluetooth'),
    // Required when the display is reached through Home Assistant
    webhook: z.string().uuid().nullable().default(null),
  })
  .refine((d) => (d.via === 'homeassistant') === (d.webhook !== null), {
    message:
      'A Home Assistant webhook is required for, and only for, displays reached through Home Assistant',
    path: ['webhook'],
  });

export const homeAssistantWebhookSchema = z.object({
  name: z.string().trim().min(1).max(100),
  homeAssistantUrl: z
    .string()
    .trim()
    .url()
    .refine((url) => /^https?:\/\//.test(url), 'must be an http(s) URL')
    .transform((url) => url.replace(/\/+$/, '')),
});

export const statsQuerySchema = z.object({
  // Start of the period in unix seconds; the admin page passes local midnight
  from: z.coerce
    .number()
    .int()
    .refine((from) => {
      const now = Date.now() / 1000;
      return from <= now && from >= now - 366 * 24 * 3600;
    }, 'must be a unix timestamp within the last year')
    .default(() => Math.floor(Date.now() / 1000) - 30 * 24 * 3600),
  // IANA time zone to group days and hours in
  tz: z
    .string()
    .refine((timeZone) => {
      try {
        new Intl.DateTimeFormat('en', { timeZone });
        return true;
      } catch {
        return false;
      }
    }, 'unknown time zone')
    .default('UTC'),
});

// --- Checks that depend on the installed generators and the current settings ---

type SourceInput = { enabled: boolean; weight: number | null; params: Record<string, string> };

/**
 * Checks source settings against the generators: known names, known parameters, allowed values,
 * and that at least one source can still be picked (a weight of 0 never is). Returns an error
 * message, or null when valid.
 * - global:  `enabled` makes a source available to sessions, which needs its environment variables
 * - session: values left empty fall back to the global settings
 */
export async function checkSources(
  sources: Record<string, SourceInput>,
  scope: 'global' | 'session'
) {
  const generators = await getGeneratorClasses();
  for (const [name, source] of Object.entries(sources)) {
    const generator = generators.find((g) => g.name === name);
    if (!generator) return `Unknown source: ${name}`;
    if (scope === 'global' && source.enabled && !isAvailable(generator)) {
      return `${name} cannot be enabled: required environment variables are missing`;
    }
    for (const [key, value] of Object.entries(source.params)) {
      const param = generator.params.find((p) => p.key === key);
      if (!param) return `${name}: unknown parameter ${key}`;
      const options = param.options;
      if (options) {
        const values = param.multiple ? value.split(',').map((v) => v.trim()) : [value];
        if (values.some((v) => !options.some((o) => o.value === v))) {
          return `${name}: ${key} must be ${param.multiple ? 'a comma separated list of' : 'one of'} ${options.map((o) => o.value).join(', ')}`;
        }
      }
    }
  }

  const canPick = generators.some((g) => {
    if (!isAvailable(g)) return false;
    const global = getSourceSettings(g.name);
    const own = sources[g.name];
    if (scope === 'global') {
      const source = own ?? global;
      return source.enabled && (source.weight ?? 0) > 0;
    }
    return global.enabled && (own?.enabled ?? true) && (own?.weight ?? global.weight) > 0;
  });
  if (!canPick) {
    return scope === 'global'
      ? 'Switch on at least one available source with a weight above 0'
      : 'Switch on at least one source with a weight above 0';
  }
  return null;
}

/** Keeps only real session overrides, so new global defaults still apply to everything else */
export function sessionOverrides(sources: Record<string, SourceInput>) {
  return Object.fromEntries(
    Object.entries(sources).filter(
      ([, s]) => !s.enabled || s.weight !== null || Object.keys(s.params).length > 0
    )
  );
}
