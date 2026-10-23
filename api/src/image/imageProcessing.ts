import sharp from 'sharp';
import type { FitEnum } from 'sharp';
import type { ResizeParams } from '../devices/DeviceStore.js';

export const VALID_FITS: (keyof FitEnum)[] = ['cover', 'contain', 'fill', 'inside', 'outside'];
export const THUMBNAIL_SIZE = 250;
/** Largest width/height the public resize endpoint accepts; e-paper displays are far smaller */
export const MAX_RESIZE_DIMENSION = 4096;

export async function resizeImage(
  input: Buffer,
  { w, h, fit, brightness }: ResizeParams
): Promise<{ buffer: Buffer; contentType: string }> {
  const { data, info } = await sharp(input)
    .resize(w, h, { fit: fit as keyof FitEnum })
    .modulate({ brightness })
    .toBuffer({ resolveWithObject: true });
  return { buffer: data, contentType: `image/${info.format}` };
}

/** Small JPEG preview of what a device received, stored for the admin interface */
export function makeThumbnail(input: Buffer): Promise<Buffer> {
  return sharp(input)
    .resize(THUMBNAIL_SIZE, THUMBNAIL_SIZE, { fit: 'inside', withoutEnlargement: true })
    .flatten({ background: '#ffffff' })
    .jpeg({ quality: 70 })
    .toBuffer();
}
