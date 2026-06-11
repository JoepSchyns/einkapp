import type { EinkApplication, ContentInfo, JsonObject } from '../types/index.js';
import { ImageGeneratorStore } from './imageGeneratorStore.js';

export abstract class ImageGenerator<
  PrevDataT extends JsonObject = JsonObject,
> implements EinkApplication {
  protected store: ImageGeneratorStore<PrevDataT>;
  constructor(sessionId: string) {
    this.store = new ImageGeneratorStore<PrevDataT>(sessionId, this.constructor.name);
  }
  abstract getContent(): Promise<{ stream: ReadableStream; contentType: string }>;
  abstract getInfo(): Promise<ContentInfo>;
}
