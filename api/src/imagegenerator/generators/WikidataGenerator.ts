import type { ContentInfo, JsonObject } from '../../types/index.js';
import { ImageGenerator } from '../ImageGenerator.js';
import { ListCache } from '../ListCache.js';

/**
 * QLever answers in seconds; the official query.wikidata.org endpoint needs about a minute for these
 * queries because it has to count the sitelinks of every artwork, which hits its 60 second limit.
 */
const SPARQL_URL = 'https://qlever.dev/api/wikidata';
const COMMONS_API_URL = 'https://commons.wikimedia.org/w/api.php';
const REQUEST_TIMEOUT_MS = 60_000;
/** Lists are expensive to fetch and change slowly; shared by all sessions, refreshed daily in the background */
const LIST_TTL_MS = 24 * 60 * 60 * 1000;
/** Part of the cache key; change it when the Artwork fields change, so old lists are fetched again */
const CACHE_VERSION = 1;
const ORDERS = [
  { value: 'weighted', label: 'Random, famous works more often' },
  { value: 'random', label: 'Random, every work equally often' },
  { value: 'popular', label: 'Most famous first' },
];
const OBJECT_TYPES = [
  { value: 'Q3305213', label: 'Paintings' },
  { value: 'Q860861', label: 'Sculptures' },
  { value: 'Q125191', label: 'Photographs' },
  { value: 'Q93184', label: 'Drawings' },
  { value: 'Q11060274', label: 'Prints' },
];
/** Wikimedia asks for a descriptive User-Agent with contact information */
const USER_AGENT = 'eink wall art tool (eink@boterham.men)';
/** A standard Wikimedia thumbnail width, other widths are rendered on demand and may be throttled */
const IMAGE_WIDTH = 1920;
const MAX_ATTEMPTS = 5;
const NUDE_GENRE = 'Q40446';
/**
 * Famous enough: a Wikipedia article in at least this many languages. That's about 2200 paintings
 * and 450 sculptures, but only a few dozen drawings, prints or photographs.
 */
const MIN_SITELINKS = 8;
/** Sharp enough for large e-ink panels, leaves out about 14% of the artworks */
const MIN_SHORT_SIDE_PX = 1000;
/** SVGs on Commons are drawings of an artwork, not reproductions of it */
const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/tiff'];
/** Guards against an object type that matches far more than artworks, e.g. Q5 (human) */
const MAX_ARTWORKS = 20_000;
/** The Commons API takes at most 50 titles per request */
const TITLES_PER_REQUEST = 50;

interface Artwork {
  id: string;
  title: string;
  creator: string | null;
  /** Commons file page title, e.g. "File:Mona Lisa.jpg" */
  fileTitle: string;
  imageUrl: string;
  sourceUrl: string;
  sitelinks: number;
}

interface SparqlResponse {
  results: {
    bindings: Partial<
      Record<'item' | 'links' | 'image' | 'label' | 'creator' | 'article', { value: string }>
    >[];
  };
}

interface ImageInfoResponse {
  query: {
    normalized?: { from: string; to: string }[];
    pages: { title: string; imageinfo?: { width: number; height: number; mime: string }[] }[];
  };
}

interface WikidataData extends JsonObject {
  filter: string;
  /** Ids still to show, in random order */
  queue: string[];
}

function shuffle<T>(items: T[]): T[] {
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [items[i], items[j]] = [items[j], items[i]];
  }
  return items;
}

/** Commons file titles whose image is large enough and of a usable type, ~55 requests per 2700 */
async function fetchUsableFiles(fileTitles: string[]): Promise<Set<string>> {
  const usable = new Set<string>();
  for (let i = 0; i < fileTitles.length; i += TITLES_PER_REQUEST) {
    const response = await fetch(COMMONS_API_URL, {
      method: 'POST',
      body: new URLSearchParams({
        action: 'query',
        prop: 'imageinfo',
        iiprop: 'size|mime',
        titles: fileTitles.slice(i, i + TITLES_PER_REQUEST).join('|'),
        format: 'json',
        formatversion: '2',
      }),
      headers: { 'User-Agent': USER_AGENT },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new Error(`Wikimedia Commons returned ${response.status}`);
    }
    const { query } = (await response.json()) as ImageInfoResponse;
    // Pages come back under their normalized title, map them back
    const originalTitle = new Map(query.normalized?.map(({ from, to }) => [to, from]));
    for (const page of query.pages) {
      const info = page.imageinfo?.[0];
      if (
        info &&
        Math.min(info.width, info.height) >= MIN_SHORT_SIDE_PX &&
        IMAGE_TYPES.includes(info.mime)
      ) {
        usable.add(originalTitle.get(page.title) ?? page.title);
      }
    }
  }
  return usable;
}

export default class WikidataGenerator extends ImageGenerator<WikidataData> {
  static label = 'Famous artworks (Wikidata)';
  static params = [
    {
      key: 'objectTypes',
      label: 'Object types',
      default: 'Q3305213',
      description: 'Mixed into one list. Only paintings and sculptures have many famous works',
      options: OBJECT_TYPES,
      multiple: true,
    },
    {
      key: 'order',
      label: 'Order',
      default: 'random',
      description: 'Fame is the number of Wikipedia languages with an article about the work',
      options: ORDERS,
    },
    {
      key: 'hideNudes',
      label: 'Hide nudes',
      default: 'yes',
      description: 'Leaves out artworks in the nude genre',
      options: [
        { value: 'yes', label: 'Yes' },
        { value: 'no', label: 'No' },
      ],
    },
  ];

  private get objectTypes(): string[] {
    const objectTypes = this.param('objectTypes')
      .split(',')
      .map((type) => type.trim())
      .filter(Boolean);
    // The ids end up in the query, so only known ones are accepted
    if (!objectTypes.length || objectTypes.some((type) => !OBJECT_TYPES.some((o) => o.value === type))) {
      throw new Error(`Unknown Wikidata object types "${this.param('objectTypes')}".`);
    }
    return [...new Set(objectTypes)].sort();
  }

  private get hideNudes(): boolean {
    return this.param('hideNudes').toLowerCase() !== 'no';
  }

  private get order(): string {
    const order = this.param('order');
    if (!ORDERS.some((o) => o.value === order)) {
      throw new Error(`Unknown order "${order}" for the famous artworks generator.`);
    }
    return order;
  }

  /** All ids in showing order, the first to show at the end */
  private buildQueue(artworks: Map<string, Artwork>): string[] {
    const list = shuffle([...artworks.values()]);
    if (this.order === 'random') {
      return list.map((a) => a.id);
    }
    // Weighted random order (Efraimidis-Spirakis): a work with twice the weight tends to come up
    // twice as early
    const sortKey =
      this.order === 'popular'
        ? (a: Artwork) => a.sitelinks
        : (a: Artwork) => Math.random() ** (1 / Math.max(1, a.sitelinks));
    const keys = new Map(list.map((a) => [a.id, sortKey(a)]));
    // Stable sort, so works of equal fame stay shuffled
    return list.map((a) => a.id).sort((a, b) => keys.get(a)! - keys.get(b)!);
  }

  /** Identifies the list a queue was made for, so a settings change starts a new queue */
  private get filter(): string {
    return `${this.objectTypes.join(',')}|${this.hideNudes}`;
  }

  private buildQuery(): string {
    const types = this.objectTypes.map((type) => `wd:${type}`).join(' ');
    const nudeFilter = this.hideNudes
      ? `FILTER NOT EXISTS { ?item wdt:P136 wd:${NUDE_GENRE} }`
      : '';
    return `PREFIX wd: <http://www.wikidata.org/entity/>
PREFIX wdt: <http://www.wikidata.org/prop/direct/>
PREFIX wikibase: <http://wikiba.se/ontology#>
PREFIX schema: <http://schema.org/>
PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
SELECT ?item (MAX(?l) AS ?links) (SAMPLE(?img) AS ?image) (SAMPLE(?lbl) AS ?label)
       (SAMPLE(?cl) AS ?creator) (SAMPLE(?a) AS ?article) WHERE {
  VALUES ?type { ${types} }
  ?item wdt:P31 ?type; wdt:P18 ?img; wikibase:sitelinks ?l.
  FILTER(?l >= ${MIN_SITELINKS})
  ${nudeFilter}
  OPTIONAL { ?item rdfs:label ?lbl FILTER(LANG(?lbl) = "en") }
  OPTIONAL { ?item wdt:P170 ?c. ?c rdfs:label ?cl FILTER(LANG(?cl) = "en") }
  OPTIONAL { ?a schema:about ?item; schema:isPartOf <https://en.wikipedia.org/> }
}
GROUP BY ?item LIMIT ${MAX_ARTWORKS}`;
  }

  /** One list for all object types together, so each artwork has the same chance */
  private async fetchArtworks(): Promise<Artwork[]> {
    const response = await fetch(`${SPARQL_URL}?query=${encodeURIComponent(this.buildQuery())}`, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/sparql-results+json' },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new Error(
        `Wikidata query returned ${response.status}: ${(await response.text()).slice(0, 200)}`
      );
    }
    const { results } = (await response.json()) as SparqlResponse;
    const candidates: Artwork[] = [];
    for (const row of results.bindings) {
      if (!row.item || !row.image) continue;
      const id = row.item.value.split('/').pop()!;
      candidates.push({
        id,
        title: row.label?.value ?? 'Untitled',
        creator: row.creator?.value ?? null,
        fileTitle: `File:${decodeURIComponent(row.image.value.split('/Special:FilePath/')[1])}`,
        // Special:FilePath redirects to a thumbnail of the requested width
        imageUrl: `${row.image.value.replace(/^http:/, 'https:')}?width=${IMAGE_WIDTH}`,
        sourceUrl: row.article?.value ?? `https://www.wikidata.org/wiki/${id}`,
        sitelinks: Number(row.links?.value ?? 0),
      });
    }

    const usable = await fetchUsableFiles(candidates.map((a) => a.fileTitle));
    const artworks = candidates.filter((a) => usable.has(a.fileTitle));
    if (!artworks.length) {
      throw new Error(
        `No artworks found on Wikidata for object types ${this.objectTypes.join(', ')} with Wikipedia articles in ${MIN_SITELINKS}+ languages and an image of at least ${MIN_SHORT_SIDE_PX}px.`
      );
    }
    return artworks;
  }

  private async getArtworks(): Promise<Map<string, Artwork>> {
    const key = `WikidataGenerator|v${CACHE_VERSION}|${this.filter}`;
    const artworks = await ListCache.get(key, LIST_TTL_MS, () => this.fetchArtworks());
    return new Map(artworks.map((a) => [a.id, a]));
  }

  private async nextArtwork(
    data: WikidataData
  ): Promise<{ artwork: Artwork; image: { stream: ReadableStream; contentType: string } }> {
    const artworks = await this.getArtworks();
    let lastError: unknown;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; ) {
      if (!data.queue.length) {
        data.queue = this.buildQueue(artworks);
      }
      // Ids may have dropped out of the list since it was refreshed
      const artwork = artworks.get(data.queue.pop()!);
      if (!artwork) continue;
      attempt++;
      try {
        const image = await this.downloadImage(artwork.imageUrl, {
          headers: { 'User-Agent': USER_AGENT },
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
        return { artwork, image };
      } catch (error) {
        lastError = error;
      }
    }
    throw new Error(`Could not download a Wikidata artwork image in ${MAX_ATTEMPTS} tries.`, {
      cause: lastError,
    });
  }

  async getContent(): Promise<{ stream: ReadableStream; contentType: string }> {
    const prevData = this.store.getPrevData();
    // The order is part of the filter, so changing it rebuilds the queue; the cached list stays
    const filter = `${this.filter}|${this.order}`;
    const data: WikidataData = {
      filter,
      // Saved data of an earlier version of this generator can have the same filter but no queue
      queue: prevData?.filter === filter && Array.isArray(prevData.queue) ? prevData.queue : [],
    };

    let result: Awaited<ReturnType<typeof this.nextArtwork>>;
    try {
      result = await this.nextArtwork(data);
    } finally {
      // Also when failing, so broken images aren't retried on every request
      this.store.setPrevData(data);
    }

    const { artwork, image } = result;
    const by = artwork.creator ? ` by ${artwork.creator}` : '';
    this.store.setInfo({
      title: artwork.title,
      sourceUrl: artwork.sourceUrl,
      description: `Artwork${by} (Wikipedia articles in ${artwork.sitelinks} languages)`,
    });
    return image;
  }

  getInfo(): Promise<ContentInfo> {
    return Promise.resolve(this.store.getInfo());
  }
}
