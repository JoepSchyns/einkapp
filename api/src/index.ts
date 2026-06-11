import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { Application } from './application/Application.js';
import { streamSSE } from 'hono/streaming';
import sharp from 'sharp';
import type { FitEnum } from 'sharp';
import { Readable } from 'node:stream';
import { createAdminRouter } from './admin/admin.js';

const application = new Application();

const app = new Hono();

app.onError((error, c) => {
  console.error(error);
  return c.text(error.message, 500);
});

const api = new Hono();

api.get('/session/:id/image', async (c) => {
  const id = c.req.param('id');
  const { stream, contentType } = await application.getContent(id);
  return c.body(stream, 200, { 'Content-Type': contentType });
});

api.get('/session/:id/image/resize', async (c) => {
  const id = c.req.param('id');
  const w = parseInt(c.req.query('w') ?? '', 10);
  const h = parseInt(c.req.query('h') ?? '', 10);
  const fitParam = c.req.query('fit') ?? 'cover';
  const validFits: (keyof FitEnum)[] = ['cover', 'contain', 'fill', 'inside', 'outside'];
  if (!validFits.includes(fitParam as keyof FitEnum)) {
    return c.text(`Query parameter fit must be one of: ${validFits.join(', ')}.`, 400);
  }
  const fit = fitParam as keyof FitEnum;
  if (!w || !h || w <= 0 || h <= 0) {
    return c.text('Query parameters w and h must be positive integers.', 400);
  }
  const { stream, contentType } = await application.getContent(id);
  const pipeline = Readable.fromWeb(stream).pipe(sharp().resize(w, h, { fit }));
  return c.body(Readable.toWeb(pipeline) as ReadableStream, 200, { 'Content-Type': contentType });
});

api.get('/session/:id/info', async (c) => {
  const id = c.req.param('id');
  const info = await application.getInfo(id);
  return c.json(info);
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
      stream.writeSSE({data: JSON.stringify(info)});
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
    port: 3000,
  },
  (info) => {
    console.log(`Server is running on http://localhost:${info.port}`);
  }
);
