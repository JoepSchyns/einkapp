import type { ImageGenerator } from '../imagegenerator/ImageGenerator.js';
import { getSessionSourceSettings, ServiceUnavailableError, type ContentInfo } from '../types/index.js';
import { getGeneratorClasses, getUsableGeneratorNames } from '../imagegenerator/GeneratorRegistry.js';
import { getSourceSettings } from '../settings/settings.js';
import { StatsStore } from '../stats/StatsStore.js';
import { SessionStore } from './SessionStore.js';

export interface ImageData {
  buffer: Buffer;
  contentType: string;
}

export interface GeneratedImage extends ImageData {
  generatorName: string;
  /** Title/source of this image, taken from the generator that made it */
  info: ContentInfo;
}

const statsStore = new StatsStore();

export class Session {
  private store: SessionStore;
  private imageGenerators: ImageGenerator[] = [];
  private imageGeneratorsLoaded = false;

  constructor(readonly id: string = crypto.randomUUID()) {
    this.store = new SessionStore(id);
  }

  private async loadImageGenerators() {
    if (!this.imageGeneratorsLoaded) {
      const classes = await getGeneratorClasses();
      this.imageGenerators = classes.map((Gen) => new Gen(this.id));
      this.imageGeneratorsLoaded = true;
      // Prune against every discovered generator so disabling a source keeps its history
      this.store.pruneGeneratorData(classes.map((g) => g.name));
    }
  }

  /** Generators this session may currently pick from, with their global weight */
  private async getCandidates(): Promise<{ generator: ImageGenerator; weight: number }[]> {
    await this.loadImageGenerators();
    const usable = new Set(await getUsableGeneratorNames());
    const settings = this.store.getSettings();
    return this.imageGenerators
      .map((generator) => {
        const name = generator.constructor.name;
        const session = getSessionSourceSettings(settings, name);
        const weight = session.weight ?? getSourceSettings(name).weight;
        return { generator, weight, use: usable.has(name) && session.enabled && weight > 0 };
      })
      .filter((c) => c.use)
      .map(({ generator, weight }) => ({ generator, weight }));
  }

  private static pickWeighted<T extends { weight: number }>(candidates: T[]): T {
    const total = candidates.reduce((sum, c) => sum + c.weight, 0);
    let roll = Math.random() * total;
    for (const candidate of candidates) {
      roll -= candidate.weight;
      if (roll < 0) return candidate;
    }
    return candidates[candidates.length - 1];
  }

  /**
   * Generates a new image from a weighted random source. When a source fails the next one is tried,
   * so one broken source doesn't break the display. `transform` (e.g. resizing) runs as part of each
   * attempt, so an image that can't be processed also falls back to the next source.
   */
  async getContent(
    deviceKey: string | null = null,
    transform?: (image: ImageData) => Promise<ImageData>
  ): Promise<GeneratedImage> {
    const candidates = await this.getCandidates();
    if (candidates.length === 0) {
      throw new ServiceUnavailableError('No image sources are enabled for this session.');
    }

    const errors: string[] = [];
    while (candidates.length > 0) {
      const candidate = Session.pickWeighted(candidates);
      candidates.splice(candidates.indexOf(candidate), 1);
      const generatorName = candidate.generator.constructor.name;
      const start = performance.now();
      try {
        candidate.generator.resetParams();
        const { stream, contentType } = await candidate.generator.getContent();
        // Read the info right away: it belongs to this image, not to whatever another display gets next
        const info = await candidate.generator.getInfo();
        const original = { buffer: Buffer.from(await new Response(stream).arrayBuffer()), contentType };
        const output = transform ? await transform(original) : original;
        statsStore.logImageEvent({
          sessionId: this.id,
          deviceKey,
          generatorName,
          success: true,
          durationMs: performance.now() - start,
        });
        this.store.setLastAccessedImageGeneratorName(generatorName);
        return { ...output, generatorName, info };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[session ${this.id}] ${generatorName} failed:`, err);
        statsStore.logImageEvent({
          sessionId: this.id,
          deviceKey,
          generatorName,
          success: false,
          durationMs: performance.now() - start,
          error: message,
        });
        errors.push(`${generatorName}: ${message}`);
      }
    }
    throw new Error(`All image sources failed. ${errors.join('; ')}`);
  }

  async getInfo(): Promise<ContentInfo> {
    const generatorName = this.store.getLastAccessedImageGeneratorName();
    if (!generatorName) {
      console.warn('No last accessed image generator found for session', this.id);
      return null;
    }
    await this.loadImageGenerators();
    const generator = this.imageGenerators.find((g) => g.constructor.name === generatorName);
    if (!generator) {
      console.warn(
        `Last accessed image generator ${generatorName} not found for session ${this.id}`
      );
      return null;
    }
    return generator.getInfo();
  }
}
