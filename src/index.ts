import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { Application } from './application/Application.js';
import { streamSSE } from 'hono/streaming';
import sharp from 'sharp';
import { Readable } from 'node:stream';

const application = new Application();

const app = new Hono();

app.onError((error, c) => {
  console.error(error);
  return c.text(error.message, 500);
});

app.get('/session', async (c) => {
  const id = await application.createNewSession();
  return c.json({ id });
});

app.get('/session/:id/image', async (c) => {
  const id = c.req.param('id');
  const { stream, contentType } = await application.getContent(id);
  return c.body(stream, 200, { 'Content-Type': contentType });
});

app.get('/session/:id/image/resize', async (c) => {
  const id = c.req.param('id');
  const w = parseInt(c.req.query('w') ?? '', 10);
  const h = parseInt(c.req.query('h') ?? '', 10);
  if (!w || !h || w <= 0 || h <= 0) {
    return c.text('Query parameters w and h must be positive integers.', 400);
  }
  const { stream, contentType } = await application.getContent(id);
  const pipeline = Readable.fromWeb(stream).pipe(sharp().resize(w, h, { fit: 'fill' }));
  return c.body(Readable.toWeb(pipeline) as ReadableStream, 200, { 'Content-Type': contentType });
});

app.get('/session/:id/info', async (c) => {
  const id = c.req.param('id');
  const info = await application.getInfo(id);
  return c.json(info);
});

app.get('/session/:id/info-sse', (c) => {
  const id = c.req.param('id');
  return streamSSE(c, async (stream) => {
    const unsubscribe = await application.subscribeToInfoUpdates(id, (info) => {
      stream.writeSSE({data: JSON.stringify(info)});
    });
    stream.onAbort(unsubscribe);
    await new Promise<void>((resolve) => stream.onAbort(resolve));
  });
});


app.use('/*', serveStatic({ root: './public' }));

serve(
  {
    fetch: app.fetch,
    port: 3000,
  },
  (info) => {
    console.log(`Server is running on http://localhost:${info.port}`);
  }
);
