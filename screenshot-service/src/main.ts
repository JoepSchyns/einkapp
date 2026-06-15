import http from 'node:http';
import { chromium, type Browser } from 'playwright';

const PORT = Number(process.env.PORT ?? 3001);

let browser: Browser | null = null;
let browserLaunchPromise: Promise<Browser> | null = null;

async function getBrowser(): Promise<Browser> {
  if (browser?.isConnected()) return browser;
  // Prevent concurrent launches if multiple requests arrive before the first resolves
  if (!browserLaunchPromise) {
    browserLaunchPromise = chromium
      .launch({ args: ['--no-sandbox', '--disable-setuid-sandbox'] })
      .then((b) => {
        browser = b;
        browserLaunchPromise = null;
        return b;
      })
      .catch((err) => {
        browserLaunchPromise = null;
        throw err;
      });
  }
  return browserLaunchPromise;
}

function parsePositiveInt(value: string | null, fallback: number): number {
  if (value === null) return fallback;
  const n = parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

const server = http.createServer(async (req, res) => {
  let parsed: URL;
  try {
    parsed = new URL(req.url ?? '/', `http://localhost:${PORT}`);
  } catch {
    res.writeHead(400);
    res.end('Bad request');
    return;
  }

  if (req.method !== 'GET' || parsed.pathname !== '/screenshot') {
    res.writeHead(404);
    res.end('Not found');
    return;
  }

  const url = parsed.searchParams.get('url');
  if (!url) {
    res.writeHead(400);
    res.end('Missing required parameter: url');
    return;
  }

  const width = parsePositiveInt(parsed.searchParams.get('width'), 250);
  const height = parsePositiveInt(parsed.searchParams.get('height'), 122);
  const selector = parsed.searchParams.get('selector');
  const waitForSelector = parsed.searchParams.get('waitFor');

  let b: Browser;
  try {
    b = await getBrowser();
  } catch (err) {
    console.error('Browser launch error:', err);
    res.writeHead(503);
    res.end(`Browser unavailable: ${errorMessage(err)}`);
    return;
  }

  const context = await b.newContext({ viewport: { width, height } });
  const page = await context.newPage();
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded' });

    if (waitForSelector) {
      try {
        await page.waitForSelector(waitForSelector, { timeout: 10_000 });
      } catch {
        console.warn(`Timeout waiting for selector "${waitForSelector}" on ${url}`);
        // Timeout — screenshot whatever is rendered
      }
    }

    let screenshot: Buffer;
    if (selector) {
      const element = await page.$(selector);
      screenshot = element
        ? await element.screenshot({ type: 'png' })
        : await page.screenshot({ type: 'png', clip: { x: 0, y: 0, width, height } });
    } else {
      screenshot = await page.screenshot({ type: 'png', clip: { x: 0, y: 0, width, height } });
    }

    res.writeHead(200, { 'Content-Type': 'image/png' });
    res.end(screenshot);
  } catch (err) {
    console.error('Screenshot error:', err);
    res.writeHead(500);
    res.end(`Screenshot failed: ${errorMessage(err)}`);
  } finally {
    await context.close();
  }
});

server.listen(PORT, () => {
  console.log(`Screenshot service listening on port ${PORT}`);
});

function shutdown(): void {
  server.closeAllConnections();
  server.close();
  (browser?.close() ?? Promise.resolve()).catch((err) =>
    console.error('Error closing browser on shutdown:', err),
  );
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
