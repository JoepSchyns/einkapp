export class ScreenshotService {
  private readonly baseUrl: string;

  constructor() {
    const url = process.env.SCREENSHOT_SERVICE_URL ?? 'http://screenshot-service';
    const port = process.env.SCREENSHOT_SERVICE_PORT ?? '3001';
    this.baseUrl = `${url}:${port}`.replace(/\/$/, '');
  }

  async screenshot(url: string, width: number, height: number, waitFor?: string): Promise<Buffer> {
    const params = new URLSearchParams({
      url,
      width: String(width),
      height: String(height),
    });
    if (waitFor) params.set('waitFor', waitFor);

    const res = await fetch(`${this.baseUrl}/screenshot?${params}`);
    if (!res.ok) {
      throw new Error(`Screenshot service error: ${res.status} ${res.statusText}`);
    }
    const arrayBuffer = await res.arrayBuffer();
    return Buffer.from(arrayBuffer);
  }
}
