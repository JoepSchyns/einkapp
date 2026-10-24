import { randomBytes } from 'node:crypto';
import { Hono } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { sign, verify } from 'hono/jwt';
import { streamSSE } from 'hono/streaming';
import { emitAdminEvent, onAdminEvent } from '../events/adminEvents.js';
import type { MiddlewareHandler } from 'hono';
import { AdminStore } from './AdminStore.js';
import type { Application } from '../application/Application.js';
import { describeSources } from '../imagegenerator/GeneratorRegistry.js';
import { getSessionTtlHours, saveGlobalSettings } from '../settings/settings.js';
import {
  bleDeviceSchema,
  checkSources,
  globalSettingsSchema,
  homeAssistantWebhookSchema,
  loginSchema,
  sessionOptionsSchema,
  sessionOverrides,
  statsQuerySchema,
  valid,
} from './validation.js';

const BLUETOOTH_MAX_SCAN_TIMEOUT = 30; // seconds

const JWT_SECRET = (() => {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    const ephemeral = randomBytes(32).toString('hex');
    console.warn(
      '[admin] JWT_SECRET not set — using ephemeral secret, admin sessions reset on restart.'
    );
    return ephemeral;
  }
  if (Buffer.byteLength(secret) < 32) {
    throw new Error('[admin] JWT_SECRET must be at least 32 bytes.');
  }
  return secret;
})();

const adminStore = new AdminStore();

// Seed initial admin user from env vars if it does not yet exist
const seedUsername = process.env.ADMIN_USERNAME;
const seedPassword = process.env.ADMIN_PASSWORD;
if (seedUsername && seedPassword && !adminStore.getUserByUsername(seedUsername)) {
  adminStore.createUser(seedUsername, seedPassword);
  console.info(`[admin] Created admin user '${seedUsername}'.`);
}

// Dummy hash used to prevent username-enumeration via timing differences
const DUMMY_HASH = `${'0'.repeat(32)}:${'0'.repeat(128)}`;

const requireAuth: MiddlewareHandler = async (c, next) => {
  const token = getCookie(c, 'admin_token');
  if (!token) return c.json({ error: 'Unauthorized' }, 401);
  try {
    await verify(token, JWT_SECRET, 'HS256');
  } catch {
    return c.json({ error: 'Unauthorized' }, 401);
  }
  await next();
};

export function createAdminRouter(application: Application) {
  const admin = new Hono();

  admin.post('/login', valid('json', loginSchema), async (c) => {
    const { username, password } = c.req.valid('json');
    const user = adminStore.getUserByUsername(username);
    // Always run comparison to prevent timing-based username enumeration
    const valid = AdminStore.verifyPassword(password, user?.password_hash ?? DUMMY_HASH);
    if (!user || !valid) {
      return c.json({ error: 'Invalid credentials' }, 401);
    }

    const now = Math.floor(Date.now() / 1000);
    const token = await sign({ sub: username, iat: now, exp: now + 8 * 3600 }, JWT_SECRET, 'HS256');
    const secure = process.env.NODE_ENV === 'production';
    setCookie(c, 'admin_token', token, { httpOnly: true, sameSite: 'Strict', path: '/', secure });
    return c.json({ ok: true });
  });

  admin.post('/logout', (c) => {
    deleteCookie(c, 'admin_token', { path: '/' });
    return c.json({ ok: true });
  });

  // Pushes AdminEvents so the admin interface updates live
  admin.get('/events', requireAuth, (c) =>
    streamSSE(c, async (stream) => {
      const unsubscribe = onAdminEvent((event) => {
        stream.writeSSE({ data: JSON.stringify(event) }).catch(() => unsubscribe());
      });
      // Keeps proxies from closing an idle connection
      const heartbeat = setInterval(() => {
        stream.writeSSE({ event: 'ping', data: '' }).catch(() => undefined);
      }, 25_000);
      await new Promise<void>((resolve) => stream.onAbort(resolve));
      clearInterval(heartbeat);
      unsubscribe();
    })
  );

  admin.get('/sessions', requireAuth, async (c) => {
    return c.json(await application.getSessions());
  });

  admin.get('/session/:id', requireAuth, async (c) => {
    const id = c.req.param('id');
    const session = await application.getSession(id);
    if (!session) return c.json({ error: 'Session not found' }, 404);
    return c.json(session);
  });

  admin.post('/session', requireAuth, valid('json', sessionOptionsSchema), async (c) => {
    const { name, ttlHours, sources = {} } = c.req.valid('json');
    const error = await checkSources(sources, 'session');
    if (error) return c.json({ error }, 400);
    const id = application.createNewSession(name ?? null, {
      ttlHours: ttlHours ?? null,
      sources: sessionOverrides(sources),
    });
    return c.json({ id }, 201);
  });

  admin.patch('/session/:id', requireAuth, valid('json', sessionOptionsSchema), async (c) => {
    const id = c.req.param('id');
    const session = await application.getSession(id);
    if (!session) return c.json({ error: 'Session not found' }, 404);
    const { name, ttlHours, sources } = c.req.valid('json');
    if (sources) {
      const error = await checkSources(sources, 'session');
      if (error) return c.json({ error }, 400);
    }
    // Fields that are left out keep their current value
    application.updateSession(id, name === undefined ? session.name : name, {
      ttlHours: ttlHours === undefined ? session.settings.ttlHours : ttlHours,
      sources: sources ? sessionOverrides(sources) : session.settings.sources,
    });
    return c.json(await application.getSession(id));
  });

  // From here on an unknown session throws NotFoundError, which the app turns into a 404
  admin.delete('/session/:id', requireAuth, (c) => {
    application.deleteSession(c.req.param('id'));
    return c.json({ ok: true });
  });

  admin.get('/session/:id/devices', requireAuth, (c) => {
    return c.json({ devices: application.getSessionDevices(c.req.param('id')) });
  });

  admin.get('/session/:id/device/:key/thumbnail', requireAuth, (c) => {
    const thumbnail = application.getDeviceThumbnail(c.req.param('id'), c.req.param('key'));
    if (!thumbnail) return c.json({ error: 'Thumbnail not found' }, 404);
    return c.body(new Uint8Array(thumbnail), 200, {
      'Content-Type': 'image/jpeg',
      'Cache-Control': 'private, no-cache',
    });
  });

  admin.delete('/session/:id/device/:key', requireAuth, (c) => {
    const removed = application.removeSessionDevice(c.req.param('id'), c.req.param('key'));
    if (!removed) return c.json({ error: 'Device not found' }, 404);
    return c.json({ ok: true });
  });

  admin.get('/settings', requireAuth, async (c) => {
    return c.json({ sessionTtlHours: getSessionTtlHours(), sources: await describeSources() });
  });

  admin.put('/settings', requireAuth, valid('json', globalSettingsSchema), async (c) => {
    const { sessionTtlHours, sources } = c.req.valid('json');
    const error = await checkSources(sources, 'global');
    if (error) return c.json({ error }, 400);
    saveGlobalSettings({ sessionTtlHours: sessionTtlHours ?? getSessionTtlHours(), sources });
    emitAdminEvent({ type: 'settings' });
    return c.json({ sessionTtlHours: getSessionTtlHours(), sources: await describeSources() });
  });

  // ?from=<unix seconds>&tz=<IANA time zone>, so days and hours match the viewer's clock
  admin.get('/session/:id/stats', requireAuth, valid('query', statsQuerySchema), (c) => {
    const { from, tz } = c.req.valid('query');
    return c.json(application.getSessionStats(c.req.param('id'), from, tz));
  });

  admin.get('/ble/scan', requireAuth, async (c) => {
    const timeout = Math.min(Number(c.req.query('timeout') ?? 5), BLUETOOTH_MAX_SCAN_TIMEOUT);
    try {
      const devices = await application.scanBleDevices(timeout);
      return c.json({ devices });
    } catch (err) {
      console.error('[BLE] scan error:', err);
      return c.json({ error: 'BLE scan failed. Is the BLE service running?' }, 503);
    }
  });

  admin.get('/session/:id/ble-devices', requireAuth, (c) => {
    return c.json({ devices: application.getSessionInfoDisplays(c.req.param('id')) });
  });

  admin.get('/session/:id/homeassistant-webhooks', requireAuth, (c) => {
    return c.json({ webhooks: application.getHomeAssistantWebhooks(c.req.param('id')) });
  });

  admin.post(
    '/session/:id/homeassistant-webhooks',
    requireAuth,
    valid('json', homeAssistantWebhookSchema),
    (c) => {
      const { name, homeAssistantUrl } = c.req.valid('json');
      return c.json(
        application.addHomeAssistantWebhook(c.req.param('id'), name, homeAssistantUrl),
        201
      );
    }
  );

  admin.put(
    '/session/:id/homeassistant-webhooks/:webhook',
    requireAuth,
    valid('json', homeAssistantWebhookSchema),
    (c) => {
      const { name, homeAssistantUrl } = c.req.valid('json');
      const webhook = application.updateHomeAssistantWebhook(
        c.req.param('id'),
        c.req.param('webhook'),
        name,
        homeAssistantUrl
      );
      if (!webhook) return c.json({ error: 'Webhook not found' }, 404);
      return c.json(webhook);
    }
  );

  admin.delete('/session/:id/homeassistant-webhooks/:webhook', requireAuth, (c) => {
    if (!application.removeHomeAssistantWebhook(c.req.param('id'), c.req.param('webhook'))) {
      return c.json({ error: 'Webhook not found' }, 404);
    }
    return c.json({ ok: true });
  });

  admin.post('/session/:id/ble-device', requireAuth, valid('json', bleDeviceSchema), (c) => {
    const id = c.req.param('id');
    const device = c.req.valid('json');
    if (device.webhook && !application.getHomeAssistantWebhook(id, device.webhook)) {
      return c.json({ error: 'Unknown Home Assistant webhook' }, 400);
    }
    application.addSessionInfoDisplay(id, device);
    return c.json({ ok: true }, 201);
  });

  admin.delete('/session/:id/ble-device/:mac', requireAuth, (c) => {
    application.removeSessionInfoDisplay(c.req.param('id'), c.req.param('mac').toUpperCase());
    return c.json({ ok: true });
  });

  return admin;
}
