import type { ContentInfo, JsonObject } from '../../types/index.js';
import { ImageGenerator } from '../ImageGenerator.js';

const INITIAL_RIJKS_SEARCH_URL =
  'https://data.rijksmuseum.nl/search/collection?type=painting&imageAvailable=true';

interface RijksSearchResponse {
  orderedItems: { id: string }[];
  next: { id: string };
  partOf: { last: { id: string } };
}

interface RijksData extends JsonObject {
  currentPageURL: string;
  lastPageURL: string | null;
  currentItems: string[];
}

export default class RijksGenerator extends ImageGenerator<RijksData> {
  private async fetchNextItems(data: RijksData): Promise<void> {
    if (data.lastPageURL && data.lastPageURL === data.currentPageURL) {
      data.currentPageURL = INITIAL_RIJKS_SEARCH_URL;
    }
    const { orderedItems, next, partOf } = (await fetch(data.currentPageURL).then((r) =>
      r.json()
    )) as RijksSearchResponse;
    data.currentItems = orderedItems.map((i) => i.id).reverse();
    data.currentPageURL = next.id;
    data.lastPageURL = partOf.last.id;
  }

  async getContent(): Promise<{ stream: ReadableStream; contentType: string }> {
    const prevData = this.store.getPrevData();
    const data: RijksData = {
      currentPageURL: prevData?.currentPageURL ?? INITIAL_RIJKS_SEARCH_URL,
      lastPageURL: prevData?.lastPageURL ?? null,
      currentItems: prevData?.currentItems ?? [],
    };

    if (!data.currentItems.length) {
      await this.fetchNextItems(data);
    }

    const itemUrl = data.currentItems.pop()!;
    this.store.setPrevData(data);

    const { shows } = (await fetch(itemUrl).then((r) => r.json())) as {
      shows: { id: string }[];
      subject_of: { type: string; content?: string }[];
    };
    const { digitally_shown_by } = (await fetch(shows[0].id).then((r) => r.json())) as {
      digitally_shown_by: { id: string }[];
    };
    const { access_point } = (await fetch(digitally_shown_by[0].id).then((r) => r.json())) as {
      access_point: { id: string }[];
    };
    const imageResponse = await fetch(access_point[0].id);
    const stream = imageResponse.body;
    if (!stream) {
      throw new Error('Could not get image stream from Rijksmuseum.');
    }
    const contentType = imageResponse.headers.get('Content-Type');
    if (!contentType) {
      throw new Error('Could not determine content type of the image.');
    }

    this.store.setInfo({
      title: 'Rijksmuseum',
      sourceUrl: itemUrl,
      description: 'Painting from the Rijksmuseum collection',
    });
    return { stream, contentType };
  }

  getInfo(): Promise<ContentInfo> {
    return Promise.resolve(this.store.getInfo());
  }
}
