import type { ContentInfo, JsonObject } from '../../types/index.js';
import { ImageGenerator } from '../ImageGenerator.js';

interface UnsplashPhoto {
  urls: { full: string };
  description: string | null;
  links: { html: string };
  user: { name: string };
}

export default class UnsplashGenerator extends ImageGenerator<JsonObject> {
  async getContent(): Promise<{ stream: ReadableStream; contentType: string }> {
    const accessKey = process.env.UNSPLASH_ACCESS_KEY;
    if (!accessKey) {
      throw new Error('UNSPLASH_ACCESS_KEY must be set in environment variables.');
    }

    const photo = (await fetch(
      `https://api.unsplash.com/photos/random?client_id=${accessKey}&query=art`
    ).then((r) => r.json())) as UnsplashPhoto;

    const imageResponse = await fetch(`${photo.urls.full}&fm=jpg`);
    if (!imageResponse.ok) {
      throw new Error(`Failed to fetch image from Unsplash: ${imageResponse.statusText}`);
    }
    const stream = imageResponse.body;
    if (!stream) {
      throw new Error('Could not get image stream from Unsplash.');
    }
    const contentType = imageResponse.headers.get('Content-Type');
    if (!contentType) {
      throw new Error('Could not determine content type of the image.');
    }
    this.store.setInfo({
      title: photo.description ?? `Photo by ${photo.user.name}`,
      sourceUrl: photo.links.html,
      description: `Random art photo from Unsplash by ${photo.user.name}`,
    });
    return { stream, contentType };
  }

  getInfo(): Promise<ContentInfo> {
    return Promise.resolve(this.store.getInfo());
  }
}
