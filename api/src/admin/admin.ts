import { randomBytes } from 'node:crypto';
import { Hono } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { sign, verify } from 'hono/jwt';
import type { MiddlewareHandler } from 'hono';
import { AdminStore } from './AdminStore.js';
import type { Application } from '../application/Application.js';

const JWT_SECRET = (() => {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    const ephemeral = randomBytes(32).toString('hex');
    console.warn('[admin] JWT_SECRET not set — using ephemeral secret, admin sessions reset on restart.');
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

  admin.post('/login', async (c) => {
    let username: string;
    let password: string;
    try {
      ({ username, password } = await c.req.json<{ username: string; password: string }>());
    } catch {
      return c.json({ error: 'Invalid request body' }, 400);
    }
    if (typeof username !== 'string' || typeof password !== 'string') {
      return c.json({ error: 'Invalid request body' }, 400);
    }
    if (username.length > 128 || password.length > 1024) {
      return c.json({ error: 'Invalid request body' }, 400);
    }

    const user = adminStore.getUserByUsername(username);
    // Always run comparison to prevent timing-based username enumeration
    const valid = AdminStore.verifyPassword(password, user?.password_hash ?? DUMMY_HASH);
    if (!user || !valid) {
      return c.json({ error: 'Invalid credentials' }, 401);
    }

    const now = Math.floor(Date.now() / 1000);
    const token = await sign(
      { sub: username, iat: now, exp: now + 8 * 3600 },
      JWT_SECRET,
      'HS256',
    );
    const secure = process.env.NODE_ENV === 'production';
    setCookie(c, 'admin_token', token, { httpOnly: true, sameSite: 'Strict', path: '/', secure });
    return c.json({ ok: true });
  });

  admin.post('/logout', (c) => {
    deleteCookie(c, 'admin_token', { path: '/' });
    return c.json({ ok: true });
  });

  admin.get('/sessions', requireAuth, (c) => {
    return c.json(application.getAdminSessions());
  });

  admin.post('/session', requireAuth, async (c) => {
    const id = await application.createNewSession();
    return c.json({ id }, 201);
  });

  admin.delete('/session/:id', requireAuth, (c) => {
    const id = c.req.param('id');
    try {
      application.deleteSession(id);
      return c.json({ ok: true });
    } catch {
      return c.json({ error: 'Session not found' }, 404);
    }
  });

  return admin;
}
