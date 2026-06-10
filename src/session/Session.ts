import type { ImageGenerator } from '../imagegenerator/ImageGenerator.js';
import type { EinkApplication, ContentInfo } from '../types/index.js';
import fs from 'fs/promises';
import { SessionStore } from './SessionStore.js';

export class Session implements EinkApplication {
  private store: SessionStore;
  private imageGenerators: ImageGenerator[] = [];
  private imageGeneratorsLoaded = false;

  constructor(readonly id: string = crypto.randomUUID()) {
    this.store = new SessionStore(id);
  }

  private async loadImageGenerators() {
    if (!this.imageGeneratorsLoaded) {
      const availableGenerators = await fs.readdir(
        new URL('../imagegenerator/generators', import.meta.url)
      );
      const ImageGeneratorConstructors: Array<new (sessionId: string) => ImageGenerator> = [];
      for (const file of availableGenerators) {
        if (file.endsWith('.js') || file.endsWith('.ts')) {
          const module = await import(`../imagegenerator/generators/${file}`);
          if (module.default) {
            ImageGeneratorConstructors.push(module.default);
          }
        }
      }
      if (ImageGeneratorConstructors.length === 0) {
        throw new Error('No image generators found.');
      }

      this.imageGenerators = ImageGeneratorConstructors.map((Gen) => new Gen(this.id));
      this.imageGeneratorsLoaded = true;
      this.store.pruneGeneratorData(this.imageGenerators.map((g) => g.constructor.name));
    }
  }

  private async getRandomImageGenerator(): Promise<ImageGenerator> {
    if (!this.imageGeneratorsLoaded) {
      await this.loadImageGenerators();
    }
    const randomIndex = Math.floor(Math.random() * this.imageGenerators.length);
    return this.imageGenerators[randomIndex];
  }

  async getContent(): Promise<{ stream: ReadableStream; contentType: string }> {
    const generator = await this.getRandomImageGenerator();
    await this.store.setLastAccessedImageGeneratorName(generator.constructor.name);
    return generator.getContent();
  }
  async getInfo(): Promise<ContentInfo> {
    const generatorName = await this.store.getLastAccessedImageGeneratorName();
    if (!generatorName) {
      console.warn('No last accessed image generator found for session', this.id);
      return null;
    }
    if (!this.imageGeneratorsLoaded) {
      await this.loadImageGenerators();
    }
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
