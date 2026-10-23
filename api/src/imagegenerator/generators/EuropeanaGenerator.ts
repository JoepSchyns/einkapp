import { get } from 'node:https';
import { Readable } from 'node:stream';
import type { ContentInfo, JsonObject } from '../../types/index.js';
import { ImageGenerator } from '../ImageGenerator.js';

const BATCH_SIZE = 50;
const MAX_IMAGE_BYTES = 15 * 1024 * 1024;
const MAX_FULL_IMAGE_ATTEMPTS = 3;
const SEARCH_TIMEOUT_MS = 15_000;
/** A slow provider should quickly make way for the next item */
const HEADERS_TIMEOUT_MS = 15_000;
const DOWNLOAD_TIMEOUT_MS = 60_000;
/** Formats the image processing handles well; TIFF scans and SVGs are left out */
const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const MAX_REDIRECTS = 3;
/** Cloudflare refuses requests without a User-Agent */
const USER_AGENT = 'eink wall art tool (eink@boterham.men)';

interface EuropeanaSearchResponse {
  success: boolean;
  error?: string;
  items?: {
    id: string;
    title?: string[];
    dcCreator?: string[];
    dataProvider?: string[];
    edmIsShownBy?: string[];
    edmPreview?: string[];
  }[];
}

interface EuropeanaItem extends JsonObject {
  id: string;
  title: string;
  creator: string | null;
  provider: string | null;
  imageUrl: string | null;
  previewUrl: string | null;
}

interface EuropeanaData extends JsonObject {
  filter: string;
  items: EuropeanaItem[];
}

/** Quotes a value for the Solr query; quotes and backslashes inside it would break the syntax */
function quote(value: string): string {
  return `"${value.replace(/["\\]/g, '')}"`;
}

/** Errors the stream once it exceeds the limit, for responses without a Content-Length */
function limitBytes(stream: ReadableStream<Uint8Array>, max: number): ReadableStream<Uint8Array> {
  let total = 0;
  return stream.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        total += chunk.byteLength;
        if (total > max) {
          controller.error(new Error(`Europeana image is larger than ${max} bytes.`));
        } else {
          controller.enqueue(chunk);
        }
      },
    })
  );
}

/**
 * Some providers (e.g. the Mauritshuis, behind Cloudflare) answer Node's fetch with a 403 but serve
 * the same image to a plain https request.
 */
function plainGet(url: string, signal: AbortSignal, redirects = MAX_REDIRECTS): Promise<Response> {
  return new Promise((resolve, reject) => {
    const request = get(
      url,
      { signal, headers: { 'User-Agent': USER_AGENT, Accept: '*/*' } },
      (res) => {
        const status = res.statusCode ?? 500;
        const location = res.headers.location;
        if (status >= 300 && status < 400 && location && redirects > 0) {
          res.resume();
          const next = new URL(location, url).toString();
          resolve(plainGet(next, signal, redirects - 1));
          return;
        }
        const headers = new Headers();
        for (const [name, value] of Object.entries(res.headers)) {
          if (typeof value === 'string') headers.set(name, value);
        }
        resolve(new Response(Readable.toWeb(res) as ReadableStream, { status, headers }));
      }
    );
    request.on('error', reject);
  });
}

export default class EuropeanaGenerator extends ImageGenerator<EuropeanaData> {
  static label = 'Europeana';
  static requiredEnv = ['EUROPEANA_API_KEY'];
  static params = [
    {
      key: 'objectType',
      label: 'Object type',
      default: 'painting',
      description: 'What the museum catalogued the object as',
      options: [
        { value: 'painting', label: 'Painting' },
        { value: 'drawing', label: 'Drawing' },
        { value: 'print', label: 'Print' },
        { value: 'photograph', label: 'Photograph' },
        { value: 'sculpture', label: 'Sculpture' },
        { value: 'any', label: 'Any' },
      ],
    },
    {
      key: 'museums',
      label: 'Museums',
      default: 'Rijksmuseum,Mauritshuis,National Gallery of Denmark,Brukenthal National Museum',
      description:
        'Art museums with many large, openly licensed images. The Finnish National Gallery and Belvedere are left out, they block downloading their full size images',
      // Europeana data provider names, which the search filters on
      options: [
        ...[
          'Rijksmuseum',
          'Mauritshuis',
          'National Gallery of Denmark',
          'Brukenthal National Museum',
          'National Museum of Art of Romania',
          'Slovak national gallery',
          'ASTRA National Museum Complex',
          'Metropolitan Organisation of Museums of Visual Arts of Thessaloniki – MOMus',
          'Athens School of Fine Arts',
          'B&M Theocharakis Foundation for the Fine Arts and Music',
          'State Association of Fine Arts Saxony eV',
          'Art Collection of the University Göttingen',
          'Constanța Art Museum',
          'Järvenpää Art Museum',
        ].map((name) => ({ value: name, label: name })),
      ],
      multiple: true,
    },
    {
      key: 'query',
      label: 'Search query',
      default: '*:*',
      description:
        'Narrows the artworks down, e.g. landscape, landscape OR seascape OR "still life", who:"Rembrandt". *:* for everything',
    },
    {
      key: 'aspectRatio',
      label: 'Aspect ratio',
      default: 'any',
      options: [
        { value: 'any', label: 'Any' },
        { value: 'landscape', label: 'Landscape' },
        { value: 'portrait', label: 'Portrait' },
      ],
    },
  ];

  /** Identifies the search a batch was made for, so a settings change discards the old batch */
  private get filter(): string {
    return ['objectType', 'museums', 'query', 'aspectRatio']
      .map((key) => this.param(key))
      .join('|');
  }

  private async fetchNextItems(data: EuropeanaData): Promise<void> {
    const apiKey = process.env.EUROPEANA_API_KEY;
    if (!apiKey) {
      throw new Error('EUROPEANA_API_KEY must be set in environment variables.');
    }

    const queryParts: string[] = [];
    const objectType = this.param('objectType');
    if (objectType.toLowerCase() !== 'any') {
      // `what` also matches types catalogued in other languages, unlike proxy_dc_type.en
      queryParts.push(`what:${quote(objectType)}`);
    }
    const query = this.param('query');
    if (query !== '*:*') {
      queryParts.push(`(${query})`);
    }

    const params = new URLSearchParams({
      wskey: apiKey,
      query: queryParts.join(' AND ') || '*:*',
      // Europeana has no popularity ranking. Its curated art collection, the highest content tier
      // and a selection of museums come closest: wall-worthy paintings instead of pottery and snapshots.
      theme: 'art',
      media: 'true',
      reusability: 'open',
      profile: 'minimal',
      rows: String(BATCH_SIZE),
      // A new random seed per batch gives a fresh random selection without paging
      sort: `random_${Math.floor(Math.random() * 1_000_000)} asc`,
    });
    params.append('qf', 'TYPE:IMAGE');
    params.append('qf', 'contentTier:4');
    // Repeated filters on the same field are OR'ed. Only jpeg/png of at least 1 megapixel:
    // sharp enough for any display, while skipping the huge TIFF scans.
    for (const filter of [
      'MIME_TYPE:image/jpeg',
      'MIME_TYPE:image/png',
      'IMAGE_SIZE:large',
      'IMAGE_SIZE:extra_large',
    ]) {
      params.append('qf', filter);
    }
    const museums = this.param('museums');
    for (const museum of museums.split(',')) {
      if (museum.trim()) {
        params.append('qf', `DATA_PROVIDER:${quote(museum.trim())}`);
      }
    }
    const aspectRatio = this.param('aspectRatio').toLowerCase();
    if (aspectRatio === 'landscape' || aspectRatio === 'portrait') {
      params.append('qf', `IMAGE_ASPECTRATIO:${aspectRatio}`);
    }

    const response = await fetch(`https://api.europeana.eu/record/v2/search.json?${params}`, {
      signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
    });
    // Errors such as an invalid key come with a JSON body, outages with an html page
    const body = (await response.json().catch(() => null)) as EuropeanaSearchResponse | null;
    if (!response.ok || !body?.success) {
      throw new Error(
        `Europeana search failed (HTTP ${response.status}): ${body?.error ?? response.statusText}`
      );
    }

    data.items = (body.items ?? [])
      .filter((i) => i.edmIsShownBy?.length || i.edmPreview?.length)
      .map((i) => ({
        id: i.id,
        title: i.title?.[0] ?? 'Untitled',
        creator: i.dcCreator?.[0] ?? null,
        provider: i.dataProvider?.[0] ?? null,
        imageUrl: i.edmIsShownBy?.[0] ?? null,
        previewUrl: i.edmPreview?.[0] ?? null,
      }));
    if (!data.items.length) {
      throw new Error(
        `No Europeana images found for object type "${objectType}", museums "${museums}", query "${query}" and aspect ratio "${aspectRatio}".`
      );
    }
  }

  /** The image, or null when it isn't a usable image */
  private async fetchImage(
    url: string | null
  ): Promise<{ stream: ReadableStream; contentType: string } | null> {
    if (!url) return null;
    const headersTimeout = new AbortController();
    const timer = setTimeout(() => headersTimeout.abort(), HEADERS_TIMEOUT_MS);
    try {
      // The overall timeout keeps applying while the body streams
      const signal = AbortSignal.any([
        headersTimeout.signal,
        AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
      ]);
      let response = await fetch(url, { signal });
      if (response.status === 403 && url.startsWith('https:')) {
        await response.body?.cancel();
        response = await plainGet(url, signal);
      }
      const contentType = response.headers.get('Content-Type');
      const size = Number(response.headers.get('Content-Length') ?? 0);
      if (
        response.ok &&
        response.body &&
        IMAGE_TYPES.some((type) => contentType?.startsWith(type)) &&
        size <= MAX_IMAGE_BYTES
      ) {
        return { stream: limitBytes(response.body, MAX_IMAGE_BYTES), contentType: contentType! };
      }
      await response.body?.cancel();
    } catch {
      // unreachable, treated as unusable
    } finally {
      clearTimeout(timer);
    }
    return null;
  }

  /**
   * Full images are hosted by the providers, and roughly a third of them are blocked or link to
   * an html viewer. Rather than settle for Europeana's small (400px) thumbnail, try the next items
   * in the batch first and only use a thumbnail as a last resort.
   */
  private async nextImage(data: EuropeanaData): Promise<{
    item: EuropeanaItem;
    image: { stream: ReadableStream; contentType: string };
  }> {
    const tried: EuropeanaItem[] = [];
    for (let attempt = 0; attempt < MAX_FULL_IMAGE_ATTEMPTS; attempt++) {
      if (!data.items.length) {
        await this.fetchNextItems(data);
      }
      const item = data.items.pop()!;
      tried.push(item);
      const image = await this.fetchImage(item.imageUrl);
      if (image) {
        return { item, image };
      }
    }
    for (const item of tried) {
      const image = await this.fetchImage(item.previewUrl);
      if (image) {
        return { item, image };
      }
    }
    throw new Error(
      `Could not fetch an image for Europeana items ${tried.map((i) => i.id).join(', ')}.`
    );
  }

  async getContent(): Promise<{ stream: ReadableStream; contentType: string }> {
    const prevData = this.store.getPrevData();
    const filter = this.filter;
    const data: EuropeanaData = {
      filter,
      // A batch only applies to the search it was made for
      items: prevData?.filter === filter && Array.isArray(prevData.items) ? prevData.items : [],
    };

    let result: Awaited<ReturnType<typeof this.nextImage>>;
    try {
      result = await this.nextImage(data);
    } finally {
      // Also when failing, so broken items aren't retried on every request
      this.store.setPrevData(data);
    }

    const { item, image } = result;
    const by = item.creator ? ` by ${item.creator}` : '';
    const from = item.provider ? ` from ${item.provider}` : '';
    this.store.setInfo({
      title: item.title,
      // Built from the id; the API's guid link contains the API key
      sourceUrl: `https://www.europeana.eu/item${item.id}`,
      description: `Image${by}${from} via Europeana`,
    });
    return image;
  }

  getInfo(): Promise<ContentInfo> {
    return Promise.resolve(this.store.getInfo());
  }
}
