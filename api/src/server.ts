import { serve } from '@hono/node-server';
import { getConnInfo } from '@hono/node-server/conninfo';
import { Hono, type Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { createHash } from 'node:crypto';
import { Application } from './application/Application.js';
import { streamSSE } from 'hono/streaming';
import type { FitEnum } from 'sharp';
import { MAX_RESIZE_DIMENSION, VALID_FITS } from './image/imageProcessing.js';
import { NotFoundError, ServiceUnavailableError } from './types/index.js';
import { createAdminRouter } from './admin/admin.js';

const application = new Application();

const app = new Hono();

app.onError((error, c) => {
  // Errors Hono raises on purpose, e.g. 400 for malformed JSON
  if (error instanceof HTTPException) {
    return c.json({ error: error.message }, error.status);
  }
  if (error instanceof NotFoundError) {
    return c.json({ error: error.message }, 404);
  }
  console.error(error);
  if (error instanceof ServiceUnavailableError) {
    return c.text(error.message, 503);
  }
  return c.text(error.message, 500);
});

const api = new Hono();

/** Identifies the display from ?device=<name>, falling back to a hash of its IP and user agent */
function identifyDevice(c: Context): { key: string; label: string } {
  const name = c.req.query('device')?.trim().slice(0, 64);
  if (name) {
    return { key: `name:${name}`, label: name };
  }
  const ip = c.req.header('X-Real-IP') ?? getConnInfo(c).remote.address ?? 'unknown';
  const userAgent = c.req.header('User-Agent') ?? '';
  const hash = createHash('sha256').update(`${ip}|${userAgent}`).digest('hex').slice(0, 16);
  return { key: `anon:${hash}`, label: `Unnamed (${ip})` };
}

api.get('/session/:id/image', async (c) => {
  const id = c.req.param('id');
  const { body, contentType } = await application.getDisplayImage(id, {
    device: identifyDevice(c),
    resize: null,
  });
  return c.body(new Uint8Array(body), 200, { 'Content-Type': contentType });
});

api.get('/session/:id/image/resize', async (c) => {
  const id = c.req.param('id');
  const w = parseInt(c.req.query('w') ?? '', 10);
  const h = parseInt(c.req.query('h') ?? '', 10);
  const fit = c.req.query('fit') ?? 'cover';
  const brightness = Number(c.req.query('brightness') ?? 1);
  if (!VALID_FITS.includes(fit as keyof FitEnum)) {
    return c.text(`Query parameter fit must be one of: ${VALID_FITS.join(', ')}.`, 400);
  }
  if (!w || !h || w <= 0 || h <= 0 || w > MAX_RESIZE_DIMENSION || h > MAX_RESIZE_DIMENSION) {
    return c.text(
      `Query parameters w and h must be integers between 1 and ${MAX_RESIZE_DIMENSION}.`,
      400
    );
  }
  if (!Number.isFinite(brightness) || brightness < 0) {
    return c.text('Query parameter brightness must be a non-negative number.', 400);
  }
  const { body, contentType } = await application.getDisplayImage(id, {
    device: identifyDevice(c),
    resize: { w, h, fit, brightness },
  });
  return c.body(new Uint8Array(body), 200, { 'Content-Type': contentType });
});

api.get('/session/:id/info', async (c) => {
  const id = c.req.param('id');
  const info = await application.getInfo(id);
  return c.json(info);
});

api.get('/session/:id/info.png', async (c) => {
  const id = c.req.param('id');
  const body = await application.getInfoImage(id);
  return c.body(new Uint8Array(body), 200, {
    'Content-Type': 'image/png',
    'Cache-Control': 'no-store',
  });
});

api.get('/session/:id/source', async (c) => {
  const id = c.req.param('id');
  const info = await application.getInfo(id);
  if (!info?.sourceUrl) {
    return c.text('No source URL available.', 404);
  }
  return c.redirect(info.sourceUrl, 302);
});

api.get('/session/:id/info-sse', (c) => {
  const id = c.req.param('id');
  return streamSSE(c, async (stream) => {
    const unsubscribe = await application.subscribeToInfoUpdates(id, (info) => {
      stream.writeSSE({ data: JSON.stringify(info) });
    });
    stream.onAbort(unsubscribe);
    await new Promise<void>((resolve) => stream.onAbort(resolve));
  });
});

api.route('/admin', createAdminRouter(application));

app.route('/api', api);

serve(
  {
    fetch: app.fetch,
    port: Number(process.env.API_PORT ?? 3000),
  },
  (info) => {
    console.log(`Server is running on http://localhost:${info.port}`);
  }
);
