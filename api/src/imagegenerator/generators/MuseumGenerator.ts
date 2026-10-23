import type { ContentInfo, JsonObject } from '../../types/index.js';
import { ImageGenerator } from '../ImageGenerator.js';
import { ListCache } from '../ListCache.js';

/** Queries for a single collection are small enough for the official endpoint (~10s for 5000 works) */
const SPARQL_URL = 'https://query.wikidata.org/sparql';
const COMMONS_API_URL = 'https://commons.wikimedia.org/w/api.php';
const REQUEST_TIMEOUT_MS = 60_000;
/** Lists are shared by all sessions and refreshed daily, in the background */
const LIST_TTL_MS = 24 * 60 * 60 * 1000;
/** Part of the cache key; change it when the Artwork fields change, so old lists are fetched again */
const CACHE_VERSION = 1;
/** Wikimedia asks for a descriptive User-Agent with contact information */
const USER_AGENT = 'eink wall art tool (eink@boterham.men)';
/** A standard Wikimedia thumbnail width, other widths are rendered on demand and may be throttled */
const IMAGE_WIDTH = 1920;
const MAX_ATTEMPTS = 5;
const NUDE_GENRE = 'Q40446';
/** Sharp enough for large e-ink panels */
const MIN_SHORT_SIDE_PX = 1000;
/** SVGs on Commons are drawings of an artwork, not reproductions of it */
const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/tiff'];
/** Per museum, the most popular works are kept */
const MAX_ARTWORKS = 10_000;
/** Wikidata queries running at the same time; the endpoint allows 5 per client */
const PARALLEL_QUERIES = 3;
const SPARQL_ATTEMPTS = 2;
const SPARQL_RETRY_DELAY_MS = 2_000;
/** The Commons API takes at most 50 titles per request */
const TITLES_PER_REQUEST = 50;

/** Dutch museums with the most artworks that have an image on Wikidata */
const MUSEUMS = [
  { value: 'Q190804', label: 'Rijksmuseum' },
  { value: 'Q221092', label: 'Mauritshuis' },
  { value: 'Q224124', label: 'Van Gogh Museum' },
  { value: 'Q574961', label: 'Frans Hals Museum' },
  { value: 'Q679527', label: 'Museum Boijmans Van Beuningen' },
  { value: 'Q1051928', label: 'Kröller-Müller Museum' },
  { value: 'Q1499958', label: 'Kunstmuseum Den Haag' },
  { value: 'Q1820897', label: 'Amsterdam Museum' },
  { value: 'Q924335', label: 'Stedelijk Museum Amsterdam' },
  { value: 'Q260913', label: 'Centraal Museum' },
  { value: 'Q2874177', label: 'Dordrechts Museum' },
  { value: 'Q848313', label: 'Fries Museum' },
  { value: 'Q1542668', label: 'Groninger Museum' },
  { value: 'Q1505892', label: 'Rijksmuseum Twenthe' },
  { value: 'Q892727', label: 'Bonnefanten' },
  { value: 'Q2098586', label: 'Museum De Lakenhal' },
  { value: 'Q255409', label: 'The Mesdag Collection' },
  { value: 'Q1616123', label: 'Het Scheepvaartmuseum' },
  { value: 'Q4360916', label: 'Museum Gouda' },
  { value: 'Q4623539', label: 'Stedelijk Museum Alkmaar' },
  { value: 'Q1954426', label: 'Museum Catharijneconvent' },
  { value: 'Q12013217', label: 'Noordbrabants Museum' },
  { value: 'Q281903', label: 'Prinsenhof Delft' },
];

const OBJECT_TYPES = [
  { value: 'Q3305213', label: 'Paintings' },
  { value: 'Q93184', label: 'Drawings' },
  { value: 'Q11060274', label: 'Prints' },
  { value: 'Q860861', label: 'Sculptures' },
];

const ORDERS = [
  { value: 'weighted', label: 'Random, famous works more often' },
  { value: 'random', label: 'Random, every work equally often' },
  { value: 'popular', label: 'Most famous first' },
];

interface Artwork {
  id: string;
  title: string;
  creator: string | null;
  /** Commons file page title, e.g. "File:Mona Lisa.jpg" */
  fileTitle: string;
  imageUrl: string;
  sourceUrl: string;
  /** Number of Wikipedia languages with an article about the work, the popularity measure */
  sitelinks: number;
  /** Name of the chosen museum the work is in */
  museum: string;
}

interface SparqlResponse {
  results: {
    bindings: Partial<
      Record<
        'item' | 'links' | 'image' | 'labelEn' | 'labelNl' | 'creator' | 'article',
        { value: string }
      >
    >[];
  };
}

interface ImageInfoResponse {
  query: {
    normalized?: { from: string; to: string }[];
    pages: { title: string; imageinfo?: { width: number; height: number; mime: string }[] }[];
  };
}

interface MuseumData extends JsonObject {
  filter: string;
  /** Ids still to show; the next one is at the end */
  queue: string[];
}

function shuffle<T>(items: T[]): T[] {
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [items[i], items[j]] = [items[j], items[i]];
  }
  return items;
}

/** Runs at most `limit` tasks at a time, the others wait in order */
function createLimiter(limit: number) {
  let running = 0;
  const waiting: (() => void)[] = [];
  return async <T>(task: () => Promise<T>): Promise<T> => {
    if (running < limit) {
      running++;
    } else {
      // The finishing task hands its slot over, so `running` stays the same
      await new Promise<void>((resolve) => waiting.push(resolve));
    }
    try {
      return await task();
    } finally {
      const next = waiting.shift();
      if (next) next();
      else running--;
    }
  };
}

/** Shared by all sessions, so background refreshes of many museums don't flood Wikidata */
const limitQueries = createLimiter(PARALLEL_QUERIES);

/** Per Commons file title: whether the image is large enough and of a usable type */
const usableFiles = new Map<string, boolean>();

/**
 * Checks up to TITLES_PER_REQUEST files in one request. Checking all works of a few museums up
 * front takes hundreds of requests, which Commons answers with 429s, so only the works next in line
 * are checked.
 */
async function checkFiles(fileTitles: string[]): Promise<void> {
  const response = await fetch(COMMONS_API_URL, {
    method: 'POST',
    body: new URLSearchParams({
      action: 'query',
      prop: 'imageinfo',
      iiprop: 'size|mime',
      titles: fileTitles.join('|'),
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
  const usable = new Set<string>();
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
  // Missing files count as unusable too
  for (const title of fileTitles) {
    usableFiles.set(title, usable.has(title));
  }
}

export default class MuseumGenerator extends ImageGenerator<MuseumData> {
  static label = 'Dutch museums (Wikidata)';
  static params = [
    {
      key: 'museum',
      label: 'Museums',
      default: 'Q190804',
      description: 'The collections the artworks are currently in, mixed into one list',
      options: MUSEUMS,
      multiple: true,
    },
    {
      key: 'objectType',
      label: 'Object types',
      default: 'Q3305213',
      description: 'Few museums have many drawings, prints or sculptures with an image on Wikidata',
      options: OBJECT_TYPES,
      multiple: true,
    },
    {
      key: 'order',
      label: 'Order',
      default: 'weighted',
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

  private get museums(): string[] {
    return this.options('museum', MUSEUMS);
  }

  private get objectTypes(): string[] {
    return this.options('objectType', OBJECT_TYPES);
  }

  private get order(): string {
    return this.options('order', ORDERS)[0];
  }

  private get hideNudes(): boolean {
    return this.param('hideNudes').toLowerCase() !== 'no';
  }

  /** The chosen values, sorted; they end up in the query, so only known ones are accepted */
  private options(key: string, options: { value: string }[]): string[] {
    const values = [
      ...new Set(
        this.param(key)
          .split(',')
          .map((v) => v.trim())
          .filter(Boolean)
      ),
    ].sort();
    const unknown = values.filter((v) => !options.some((o) => o.value === v));
    if (!values.length || unknown.length) {
      throw new Error(`Unknown ${key} "${this.param(key)}" for the museum generator.`);
    }
    return values;
  }

  /** Identifies the list a queue was made for, so a settings change starts a new queue */
  private get listKey(): string {
    return `${this.museums.join(',')}|${this.objectTypes.join(',')}|${this.hideNudes}`;
  }

  private buildQuery(museum: string): string {
    const nudeFilter = this.hideNudes
      ? `FILTER NOT EXISTS { ?item wdt:P136 wd:${NUDE_GENRE} }`
      : '';
    // Collection statements with an end time are works that have since left the museum
    return `PREFIX wd: <http://www.wikidata.org/entity/>
PREFIX wdt: <http://www.wikidata.org/prop/direct/>
PREFIX p: <http://www.wikidata.org/prop/>
PREFIX ps: <http://www.wikidata.org/prop/statement/>
PREFIX pq: <http://www.wikidata.org/prop/qualifier/>
PREFIX wikibase: <http://wikiba.se/ontology#>
PREFIX schema: <http://schema.org/>
PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
SELECT ?item (MAX(?l) AS ?links) (SAMPLE(?img) AS ?image) (SAMPLE(?en) AS ?labelEn)
       (SAMPLE(?nl) AS ?labelNl) (SAMPLE(?cl) AS ?creator) (SAMPLE(?a) AS ?article) WHERE {
  VALUES ?type { ${this.objectTypes.map((t) => `wd:${t}`).join(' ')} }
  ?item p:P195 ?collection. ?collection ps:P195 wd:${museum}.
  FILTER NOT EXISTS { ?collection pq:P582 [] }
  ?item wdt:P31 ?type; wdt:P18 ?img; wikibase:sitelinks ?l.
  ${nudeFilter}
  OPTIONAL { ?item rdfs:label ?en FILTER(LANG(?en) = "en") }
  OPTIONAL { ?item rdfs:label ?nl FILTER(LANG(?nl) = "nl") }
  OPTIONAL { ?item wdt:P170 ?c. ?c rdfs:label ?cl FILTER(LANG(?cl) = "en") }
  OPTIONAL { ?a schema:about ?item; schema:isPartOf <https://en.wikipedia.org/> }
}
GROUP BY ?item ORDER BY DESC(?links) LIMIT ${MAX_ARTWORKS}`;
  }

  private async query(museum: string): Promise<SparqlResponse> {
    for (let attempt = 1; ; attempt++) {
      const response = await fetch(SPARQL_URL, {
        method: 'POST',
        body: new URLSearchParams({ query: this.buildQuery(museum) }),
        headers: { 'User-Agent': USER_AGENT, Accept: 'application/sparql-results+json' },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (response.ok) {
        return (await response.json()) as SparqlResponse;
      }
      // The endpoint now and then answers with a 502 or 503 that is gone a moment later
      if (response.status < 500 || attempt === SPARQL_ATTEMPTS) {
        throw new Error(
          `Wikidata query returned ${response.status}: ${(await response.text()).slice(0, 200)}`
        );
      }
      await response.body?.cancel();
      await new Promise((resolve) => setTimeout(resolve, SPARQL_RETRY_DELAY_MS));
    }
  }

  /** The works of one museum; may be empty, e.g. a museum without sculptures */
  private async fetchArtworks(museum: string): Promise<Artwork[]> {
    const museumName = MUSEUMS.find((m) => m.value === museum)!.label;
    const { results } = await limitQueries(() => this.query(museum));
    const candidates: Artwork[] = [];
    for (const row of results.bindings) {
      if (!row.item || !row.image) continue;
      const id = row.item.value.split('/').pop()!;
      candidates.push({
        id,
        title: row.labelEn?.value ?? row.labelNl?.value ?? 'Untitled',
        creator: row.creator?.value ?? null,
        fileTitle: `File:${decodeURIComponent(row.image.value.split('/Special:FilePath/')[1])}`,
        // Special:FilePath redirects to a thumbnail of the requested width
        imageUrl: `${row.image.value.replace(/^http:/, 'https:')}?width=${IMAGE_WIDTH}`,
        sourceUrl: row.article?.value ?? `https://www.wikidata.org/wiki/${id}`,
        sitelinks: Number(row.links?.value ?? 0),
        museum: museumName,
      });
    }

    return candidates;
  }

  /** Lists are cached per museum, so choosing another set of museums reuses the ones fetched before */
  private getMuseumArtworks(museum: string): Promise<Artwork[]> {
    const key = `MuseumGenerator|v${CACHE_VERSION}|${museum}|${this.objectTypes.join(',')}|${this.hideNudes}`;
    return ListCache.get(key, LIST_TTL_MS, () => this.fetchArtworks(museum));
  }

  private async getArtworks(): Promise<Map<string, Artwork>> {
    const errors: unknown[] = [];
    const lists = await Promise.all(
      this.museums.map((museum) =>
        this.getMuseumArtworks(museum).catch((error: unknown) => {
          // The other museums still give images; this one is tried again for the next image
          console.error(`[Museum] Failed to fetch ${museum}, leaving it out for now:`, error);
          errors.push(error);
          return [];
        })
      )
    );
    if (errors.length === this.museums.length) {
      throw errors[0];
    }
    // A work in two of the chosen museums (e.g. on loan) is listed once, naming both
    const artworks = new Map<string, Artwork>();
    for (const list of lists) {
      for (const artwork of list) {
        const id = artwork.id;
        const seen = artworks.get(id);
        artworks.set(id, seen ? { ...seen, museum: `${seen.museum} / ${artwork.museum}` } : artwork);
      }
    }
    if (!artworks.size) {
      throw new Error(`No ${this.describeSelection()} found on Wikidata with an image.`);
    }
    return artworks;
  }

  /** E.g. "paintings, drawings of Rijksmuseum, Mauritshuis", for error messages */
  private describeSelection(): string {
    const label = (options: { value: string; label: string }[], values: string[]) =>
      values.map((v) => options.find((o) => o.value === v)!.label).join(', ');
    return `${label(OBJECT_TYPES, this.objectTypes).toLowerCase()} of ${label(MUSEUMS, this.museums)}`;
  }

  /** All ids in showing order, the first to show at the end */
  private buildQueue(artworks: Map<string, Artwork>): string[] {
    const list = shuffle([...artworks.values()]);
    if (this.order === 'random') {
      return list.map((a) => a.id);
    }
    // Weighted random order (Efraimidis-Spirakis): a work with twice the weight tends to come up
    // twice as early. Most works have no or one article, so +1 keeps them in the mix.
    const sortKey =
      this.order === 'popular'
        ? (a: Artwork) => a.sitelinks
        : (a: Artwork) => Math.random() ** (1 / (a.sitelinks + 1));
    const keys = new Map(list.map((a) => [a.id, sortKey(a)]));
    // Stable sort, so works of equal fame stay shuffled
    return list.map((a) => a.id).sort((a, b) => keys.get(a)! - keys.get(b)!);
  }

  private async nextArtwork(
    data: MuseumData
  ): Promise<{ artwork: Artwork; image: { stream: ReadableStream; contentType: string } }> {
    const artworks = await this.getArtworks();
    let lastError: unknown;
    let skipped = 0;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; ) {
      if (!data.queue.length) {
        data.queue = this.buildQueue(artworks);
      }
      // Image sizes are checked a batch of works ahead, so about one request per 50 images
      const next = artworks.get(data.queue.at(-1)!);
      if (next && !usableFiles.has(next.fileTitle)) {
        const unchecked = data.queue
          .slice(-TITLES_PER_REQUEST)
          .map((id) => artworks.get(id)?.fileTitle)
          .filter((title): title is string => !!title && !usableFiles.has(title));
        await checkFiles([...new Set(unchecked)]);
      }
      // Ids may have dropped out of the list since it was refreshed
      const artwork = artworks.get(data.queue.pop()!);
      if (!artwork || !usableFiles.get(artwork.fileTitle)) {
        if (++skipped > artworks.size) {
          throw new Error(
            `None of the ${this.describeSelection()} has an image of at least ${MIN_SHORT_SIDE_PX}px.`
          );
        }
        continue;
      }
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
    throw new Error(`Could not download a museum artwork image in ${MAX_ATTEMPTS} tries.`, {
      cause: lastError,
    });
  }

  async getContent(): Promise<{ stream: ReadableStream; contentType: string }> {
    const prevData = this.store.getPrevData();
    // The order is part of the filter, so changing it rebuilds the queue
    const filter = `${this.listKey}|${this.order}`;
    const data: MuseumData = {
      filter,
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
      description: `Artwork${by}, ${artwork.museum}`,
    });
    return image;
  }

  getInfo(): Promise<ContentInfo> {
    return Promise.resolve(this.store.getInfo());
  }
}
