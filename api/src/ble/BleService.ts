export interface BleDevice {
  mac: string;
  name: string | null;
}

export interface ScannedDevice {
  mac: string;
  name: string;
}

export class BleService {
  private readonly baseUrl: string;

  constructor() {
    this.baseUrl = (process.env.BLE_SERVICE_URL ?? 'http://ble-service:8000').replace(/\/$/, '');
  }

  async scan(timeout = 5): Promise<ScannedDevice[]> {
    const res = await fetch(`${this.baseUrl}/scan?timeout=${timeout}`);
    if (!res.ok) {
      throw new Error(`BLE scan failed: ${res.status} ${res.statusText}`);
    }
    const data = (await res.json()) as { devices: ScannedDevice[] };
    return data.devices;
  }

  async pushImage(devices: BleDevice[], imageBytes: Buffer, contentType: string): Promise<void> {
    await Promise.all(
      devices.map(async (device) => {
        const mac = encodeURIComponent(device.mac);
        const res = await fetch(`${this.baseUrl}/push/${mac}`, {
          method: 'POST',
          headers: { 'Content-Type': contentType },
          body: new Uint8Array(imageBytes),
        });
        if (!res.ok) {
          throw new Error(`BLE push to ${device.mac} failed: ${res.status} ${res.statusText}`);
        }
      }),
    );
  }
}
