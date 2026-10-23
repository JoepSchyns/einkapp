import type { ContentInfo, JsonObject } from '../../types/index.js';
import { ImageGenerator } from '../ImageGenerator.js';
import { ListCache } from '../ListCache.js';

const SEARCH_URL = 'https://api.artic.edu/api/v1/artworks/search';
/** The AIC asks for a User-Agent with contact information in this header */
const HEADERS = { 'AIC-User-Agent': 'wall art tool (eink@boterham.men)' };
const REQUEST_TIMEOUT_MS = 30_000;
/** Lists are shared by all sessions and refreshed daily, in the background */
const LIST_TTL_MS = 24 * 60 * 60 * 1000;
/** Part of the cache key; change it when the Artwork fields change, so old lists are fetched again */
const CACHE_VERSION = 1;
/** The search returns at most 1000 results, in pages of at most 100 */
const PAGE_SIZE = 100;
const MAX_RESULTS = 1000;
/** A bit above the highest artwork id (~288000), to start "all works" batches at a random place */
const MAX_ID = 300_000;
/**
 * The image server refuses full size images. Public domain works can be fetched up to 1686px wide,
 * others only at 843px.
 */
const PUBLIC_DOMAIN_WIDTH = 1686;
const OTHER_WIDTH = 843;
const MAX_ATTEMPTS = 5;

/** Extra search filters per selection; null is the whole collection */
const SELECTIONS: Record<string, object[] | null> = {
  highlights: [{ term: { is_boosted: true } }],
  'on-view': [{ term: { is_on_view: true } }],
  'highlights-on-view': [{ term: { is_boosted: true } }, { term: { is_on_view: true } }],
  all: null,
};

interface ArticSearchResponse {
  data: {
    id: number;
    title: string;
    artist_display: string | null;
    image_id: string | null;
    is_public_domain: boolean;
    boost_rank: number | null;
  }[];
  config: { iiif_url: string };
}

interface Artwork extends JsonObject {
  id: number;
  title: string;
  artist: string | null;
  imageUrl: string;
  /** The museum's own popularity rank of its highlights, 1 is the most famous */
  rank: number | null;
}

interface ArticData extends JsonObject {
  filter: string;
  /** Highlights and on view: ids still to show, the next one at the end */
  queue: number[];
  /** All works: the current batch, the next one at the end */
  batch: Artwork[];
}

function shuffle<T>(items: T[]): T[] {
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [items[i], items[j]] = [items[j], items[i]];
  }
  return items;
}

export default class ArticGenerator extends ImageGenerator<ArticData> {
  static label = 'Art Institute of Chicago';
  static params = [
    {
      key: 'artworkTypeIds',
      label: 'Artwork types',
      default: '1,18,15,14,32,30,13,2',
      // From https://api.artic.edu/api/v1/artwork-types, the ones that make sense on a wall
      options: [
        { value: '1', label: 'Painting' },
        { value: '30', label: 'Miniature Painting' },
        { value: '14', label: 'Drawing and Watercolor' },
        { value: '34', label: 'Architectural Drawing' },
        { value: '18', label: 'Print' },
        { value: '2', label: 'Photograph' },
        { value: '15', label: 'Mixed Media' },
        { value: '32', label: 'Graphic Design' },
        { value: '13', label: 'Digital Arts' },
        { value: '31', label: 'Design' },
        { value: '3', label: 'Sculpture' },
        { value: '4', label: 'Icon' },
        { value: '7', label: 'Mask' },
        { value: '5', label: 'Textile' },
        { value: '36', label: 'Ceramics' },
        { value: '8', label: 'Decorative Arts' },
      ],
      multiple: true,
    },
    {
      key: 'selection',
      label: 'Selection',
      default: 'highlights',
      options: [
        { value: 'highlights', label: "Highlights: the museum's most famous works" },
        { value: 'on-view', label: 'On view: works currently in the galleries' },
        { value: 'highlights-on-view', label: 'Highlights that are on view' },
        { value: 'all', label: 'All works' },
      ],
    },
    {
      key: 'order',
      label: 'Order',
      default: 'random',
      description:
        "Fame is the museum's own ranking of its highlights, other works follow in random order. All works are always random",
      options: [
        { value: 'random', label: 'Random' },
        { value: 'popular', label: 'Most famous first' },
      ],
    },
  ];

  private get artworkTypeIds(): number[] {
    return this.param('artworkTypeIds')
      .split(',')
      .map((id) => Number(id.trim()))
      .filter((id) => Number.isInteger(id))
      .sort((a, b) => a - b);
  }

  private get selection(): string {
    const selection = this.param('selection');
    if (!(selection in SELECTIONS)) {
      throw new Error(`Unknown Art Institute of Chicago selection "${selection}".`);
    }
    return selection;
  }

  /** Identifies the list a queue was made for, so a settings change starts a new queue */
  private get listKey(): string {
    return `${this.selection}|${this.artworkTypeIds.join(',')}`;
  }

  private async search(filters: object[], extra: object): Promise<Artwork[]> {
    const response = await fetch(SEARCH_URL, {
      method: 'POST',
      headers: { ...HEADERS, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        fields: ['id', 'title', 'artist_display', 'image_id', 'is_public_domain', 'boost_rank'],
        query: {
          bool: {
            filter: [
              { exists: { field: 'image_id' } },
              { terms: { artwork_type_id: this.artworkTypeIds } },
              ...filters,
            ],
          },
        },
        ...extra,
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new Error(
        `Art Institute of Chicago search returned ${response.status}: ${(await response.text()).slice(0, 200)}`
      );
    }
    const { data, config } = (await response.json()) as ArticSearchResponse;
    return data
      .filter((a) => a.image_id)
      .map((a) => ({
        id: a.id,
        title: a.title,
        // e.g. "Vincent van Gogh\nDutch, 1853-1890"
        artist: a.artist_display?.split('\n')[0] ?? null,
        imageUrl: `${config.iiif_url}/${a.image_id}/full/${a.is_public_domain ? PUBLIC_DOMAIN_WIDTH : OTHER_WIDTH},/0/default.jpg`,
        rank: a.boost_rank,
      }));
  }

  /** Highlights and on view are small enough to fetch whole, which allows ordering by fame */
  private async fetchList(filters: object[]): Promise<Artwork[]> {
    const artworks: Artwork[] = [];
    for (let page = 1; page * PAGE_SIZE <= MAX_RESULTS; page++) {
      const batch = await this.search(filters, { limit: PAGE_SIZE, page });
      artworks.push(...batch);
      if (batch.length < PAGE_SIZE) break;
    }
    if (!artworks.length) {
      throw new Error('No Art Institute of Chicago artworks found for the chosen types and selection.');
    }
    return artworks;
  }

  /** All works are too many to list, so each batch starts at a random id */
  private async fetchBatch(): Promise<Artwork[]> {
    const from = Math.floor(Math.random() * MAX_ID);
    const extra = { limit: PAGE_SIZE, sort: [{ id: 'asc' }] };
    let batch = await this.search([{ range: { id: { gte: from } } }], extra);
    if (!batch.length) {
      // Past the highest id: start at the beginning
      batch = await this.search([], extra);
    }
    if (!batch.length) {
      throw new Error('No Art Institute of Chicago artworks found for the chosen types.');
    }
    return shuffle(batch);
  }

  /** All ids in showing order, the first to show at the end */
  private buildQueue(artworks: Artwork[]): number[] {
    const list = shuffle([...artworks]);
    if (this.param('order') === 'popular') {
      // Stable sort, so works without a rank stay shuffled, after the ranked ones
      list.sort((a, b) => (a.rank ?? Infinity) - (b.rank ?? Infinity));
    }
    return list.map((a) => a.id).reverse();
  }

  private async nextArtwork(data: ArticData): Promise<Artwork> {
    const filters = SELECTIONS[this.selection];
    if (!filters) {
      if (!data.batch.length) {
        data.batch = await this.fetchBatch();
      }
      return data.batch.pop()!;
    }
    const key = `ArticGenerator|v${CACHE_VERSION}|${this.listKey}`;
    const artworks = await ListCache.get(key, LIST_TTL_MS, () => this.fetchList(filters));
    const byId = new Map(artworks.map((a) => [a.id, a]));
    for (;;) {
      if (!data.queue.length) {
        data.queue = this.buildQueue(artworks);
      }
      // Ids may have dropped out of the list since it was refreshed
      const artwork = byId.get(data.queue.pop()!);
      if (artwork) return artwork;
    }
  }

  async getContent(): Promise<{ stream: ReadableStream; contentType: string }> {
    const prevData = this.store.getPrevData();
    // The order is part of the filter, so changing it rebuilds the queue
    const filter = `${this.listKey}|${this.param('order')}`;
    const keep = prevData?.filter === filter;
    const data: ArticData = {
      filter,
      queue: keep && Array.isArray(prevData.queue) ? prevData.queue : [],
      batch: keep && Array.isArray(prevData.batch) ? prevData.batch : [],
    };

    let lastError: unknown;
    try {
      for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
        const artwork = await this.nextArtwork(data);
        try {
          const content = await this.downloadImage(artwork.imageUrl, {
            headers: HEADERS,
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
          });
          const by = artwork.artist ? ` by ${artwork.artist}` : '';
          this.store.setInfo({
            title: artwork.title,
            sourceUrl: `https://www.artic.edu/artworks/${artwork.id}`,
            description: `Artwork${by} from the Art Institute of Chicago`,
          });
          return content;
        } catch (error) {
          lastError = error;
        }
      }
    } finally {
      // Also when failing, so broken images aren't retried on every request
      this.store.setPrevData(data);
    }
    throw new Error(`Could not download an Art Institute of Chicago image in ${MAX_ATTEMPTS} tries.`, {
      cause: lastError,
    });
  }

  getInfo(): Promise<ContentInfo> {
    return Promise.resolve(this.store.getInfo());
  }
}
