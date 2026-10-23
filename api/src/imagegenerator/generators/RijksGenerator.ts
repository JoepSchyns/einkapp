import type { ContentInfo, JsonObject } from '../../types/index.js';
import { ImageGenerator } from '../ImageGenerator.js';


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
  static label = 'Rijksmuseum';
  static params = [
    {
      key: 'type',
      label: 'Object type',
      default: 'painting',
      options: [
        { value: 'painting', label: 'Painting' },
        { value: 'drawing', label: 'Drawing' },
        { value: 'print', label: 'Print' },
        { value: 'photograph', label: 'Photograph' },
        { value: 'sculpture', label: 'Sculpture' },
        { value: 'furniture', label: 'Furniture' },
        { value: 'textile', label: 'Textile' },
      ],
    },
  ];

  private get initialSearchUrl(): string {
    return `https://data.rijksmuseum.nl/search/collection?type=${encodeURIComponent(this.param('type'))}&imageAvailable=true`;
  }

  private static readonly ID_PREFIX = 'https://id.rijksmuseum.nl/';

  private static encodeToken(id: string): string {
    return Buffer.from(JSON.stringify({ token: RijksGenerator.ID_PREFIX + id })).toString('base64url');
  }

  private static decodeToken(url: string): string | null {
    const token = new URL(url).searchParams.get('pageToken');
    if (!token) return null;
    const parsed = JSON.parse(Buffer.from(token, 'base64url').toString()) as { token: string };
    return parsed.token.replace(RijksGenerator.ID_PREFIX, '');
  }

  // The search API pages through results with a cursor on the object id, sorted as a string.
  // Pick a random id between the first result and the last page's cursor to start somewhere random.
  private async randomSearchUrl(): Promise<string> {
    const { orderedItems, partOf } = (await fetch(this.initialSearchUrl).then((r) =>
      r.json()
    )) as RijksSearchResponse;
    const first = orderedItems[0]?.id.replace(RijksGenerator.ID_PREFIX, '');
    const last = RijksGenerator.decodeToken(partOf.last.id);
    if (!first || !last) return this.initialSearchUrl;

    let i = 0;
    while (i < first.length && i < last.length && first[i] === last[i]) i++;
    const lo = Math.min(Number(first[i] ?? '0'), Number(last[i] ?? '9'));
    const hi = Math.max(Number(first[i] ?? '0'), Number(last[i] ?? '9'));
    let id = first.slice(0, i) + String(lo + Math.floor(Math.random() * (hi - lo + 1)));
    for (let n = id.length; n < first.length; n++) id += String(Math.floor(Math.random() * 10));

    const url = new URL(this.initialSearchUrl);
    url.searchParams.set('pageToken', RijksGenerator.encodeToken(id));
    return url.toString();
  }

  private async fetchNextItems(data: RijksData): Promise<void> {
    if (data.lastPageURL && data.lastPageURL === data.currentPageURL) {
      data.currentPageURL = this.initialSearchUrl;
    }
    let { orderedItems, next, partOf } = (await fetch(data.currentPageURL).then((r) =>
      r.json()
    )) as RijksSearchResponse;
    if (!orderedItems?.length) {
      // Random cursor landed past the end; fall back to the start
      data.currentPageURL = this.initialSearchUrl;
      ({ orderedItems, next, partOf } = (await fetch(data.currentPageURL).then((r) =>
        r.json()
      )) as RijksSearchResponse);
    }
    data.currentItems = orderedItems
      .map((i) => i.id)
      .sort(() => Math.random() - 0.5);
    data.currentPageURL = next.id;
    data.lastPageURL = partOf.last.id;
  }

  async getContent(): Promise<{ stream: ReadableStream; contentType: string }> {
    const prevData = this.store.getPrevData();
    const data: RijksData = {
      currentPageURL: prevData?.currentPageURL ?? (await this.randomSearchUrl()),
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
    const content = await this.downloadImage(access_point[0].id);

    this.store.setInfo({
      title: 'Rijksmuseum',
      sourceUrl: itemUrl,
      description: `${this.param('type')} from the Rijksmuseum collection`,
    });
    return content;
  }

  getInfo(): Promise<ContentInfo> {
    return Promise.resolve(this.store.getInfo());
  }
}
