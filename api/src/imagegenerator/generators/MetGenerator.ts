import type { ContentInfo, JsonObject } from '../../types/index.js';
import { ImageGenerator } from '../ImageGenerator.js';

const MET_API_URL = 'https://collectionapi.metmuseum.org/public/collection';
const PAGE_SIZE = 100;
const MAX_ATTEMPTS = 15;
/** The Met doesn't say how long a block lasts unless it sends Retry-After */
const DEFAULT_RATE_LIMIT_PAUSE_MS = 10 * 60 * 1000;

interface MetSearchResponse {
  total: number;
  objectIDs: number[] | null;
}

interface MetObject {
  objectID: number;
  title: string;
  artistDisplayName: string;
  classification: string;
  objectName: string;
  primaryImage: string;
  primaryImageSmall: string;
  objectURL: string;
}

interface DepartmentState extends JsonObject {
  ids: number[];
  offset: number;
  total: number | null;
}

interface MetData extends JsonObject {
  filter: string;
  departments: { [departmentId: string]: DepartmentState };
  nextDepartment: number;
}

/** Extra search filters per selection, the API has no sorting on popularity */
const SELECTIONS: Record<string, Record<string, string>> = {
  highlights: { isHighlight: 'true' },
  'on view': { isOnView: 'true' },
  'highlights on view': { isHighlight: 'true', isOnView: 'true' },
  all: {},
};

function shuffle<T>(items: T[]): T[] {
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [items[i], items[j]] = [items[j], items[i]];
  }
  return items;
}

let knownDepartmentIds: Promise<Set<string>> | undefined;
/** Blocks are per IP, so the pause is shared by all sessions */
let rateLimitedUntil = 0;

class MetRateLimitError extends Error {
  constructor(status: number) {
    super(
      `Rate limited by The Met API (HTTP ${status}), retrying after ${new Date(rateLimitedUntil).toLocaleTimeString()} (${formatWait(rateLimitedUntil - Date.now())} from now)`
    );
  }
}

function formatWait(ms: number): string {
  const minutes = Math.ceil(ms / 60000);
  return minutes <= 1 ? 'about a minute' : `about ${minutes} minutes`;
}

function retryAfterMs(response: Response): number {
  const header = response.headers.get('Retry-After');
  if (header) {
    const seconds = Number(header);
    if (Number.isFinite(seconds)) {
      return seconds * 1000;
    }
    const date = Date.parse(header);
    if (!Number.isNaN(date)) {
      return Math.max(date - Date.now(), 0);
    }
  }
  return DEFAULT_RATE_LIMIT_PAUSE_MS;
}

function assertNotRateLimited(): void {
  if (Date.now() < rateLimitedUntil) {
    throw new MetRateLimitError(403);
  }
}

async function fetchJson<T>(url: string): Promise<T> {
  assertNotRateLimited();
  const response = await fetch(url);
  // The Met's firewall (Imperva) answers with 403 when it blocks an IP
  if (response.status === 403 || response.status === 429) {
    rateLimitedUntil = Date.now() + retryAfterMs(response);
    throw new MetRateLimitError(response.status);
  }
  if (!response.ok) {
    throw new Error(`The Met API returned ${response.status} for ${url}`);
  }
  return (await response.json()) as T;
}

/** Unknown department IDs make the search return the whole collection, so they are filtered out. */
function getKnownDepartmentIds(): Promise<Set<string>> {
  knownDepartmentIds ??= fetchJson<{ departments: { departmentId: number }[] }>(
    `${MET_API_URL}/v1/departments`
  )
    .then(({ departments }) => new Set(departments.map((d) => String(d.departmentId))))
    .catch((error) => {
      knownDepartmentIds = undefined;
      throw error;
    });
  return knownDepartmentIds;
}

export default class MetGenerator extends ImageGenerator<MetData> {
  static label = 'The Metropolitan Museum of Art';
  static params = [
    {
      key: 'departmentIds',
      label: 'Departments',
      default: '11,21,19,6,15',
      description: 'Taking turns per image',
      // From https://collectionapi.metmuseum.org/public/collection/v1/departments
      options: [
        { value: '11', label: 'European Paintings' },
        { value: '21', label: 'Modern Art' },
        { value: '19', label: 'Photographs' },
        { value: '6', label: 'Asian Art' },
        { value: '15', label: 'The Robert Lehman Collection' },
        { value: '9', label: 'Drawings and Prints' },
        { value: '14', label: 'Islamic Art' },
        { value: '1', label: 'American Decorative Arts' },
        { value: '3', label: 'Ancient West Asian Art' },
        { value: '4', label: 'Arms and Armor' },
        { value: '5', label: 'Arts of Africa, Oceania, and the Americas' },
        { value: '7', label: 'The Cloisters' },
        { value: '8', label: 'The Costume Institute' },
        { value: '10', label: 'Egyptian Art' },
        { value: '12', label: 'European Sculpture and Decorative Arts' },
        { value: '13', label: 'Greek and Roman Art' },
        { value: '16', label: 'The Libraries' },
        { value: '17', label: 'Medieval Art' },
        { value: '18', label: 'Musical Instruments' },
      ],
      multiple: true,
    },
    {
      key: 'selection',
      label: 'Selection',
      default: 'highlights',
      options: [
        { value: 'highlights', label: "Highlights: the Met's own picks of its most important works" },
        { value: 'on view', label: 'On view: works currently in the galleries' },
        { value: 'highlights on view', label: 'Highlights that are on view' },
        { value: 'all', label: 'All works' },
      ],
    },
    {
      key: 'objectTypes',
      label: 'Object types',
      default: 'painting,photograph,thangka,scroll',
      description: "Matched against the Met's classification and object name of each work",
      // Terms, a work matches when its classification or object name contains one of them
      options: [
        { value: 'painting', label: 'Paintings' },
        { value: 'photograph', label: 'Photographs' },
        { value: 'drawing', label: 'Drawings' },
        { value: 'print', label: 'Prints' },
        { value: 'scroll', label: 'Scrolls' },
        { value: 'thangka', label: 'Thangkas' },
        { value: 'sculpture', label: 'Sculpture' },
        { value: 'textile', label: 'Textiles' },
        { value: 'ceramic', label: 'Ceramics' },
        { value: 'glass', label: 'Glass' },
        { value: 'metal', label: 'Metalwork' },
        { value: 'furniture', label: 'Furniture' },
      ],
      multiple: true,
    },
    {
      key: 'query',
      label: 'Search query',
      default: '*',
      description: 'Free text search term, * matches everything',
    },
  ];

  private async getDepartmentIds(): Promise<string[]> {
    const known = await getKnownDepartmentIds();
    const departmentIds = this.param('departmentIds')
      .split(',')
      .map((id) => id.trim())
      .filter((id) => known.has(id));
    if (!departmentIds.length) {
      throw new Error('No valid Met department IDs configured.');
    }
    return departmentIds;
  }

  private get objectTypes(): string[] {
    return this.param('objectTypes')
      .split(',')
      .map((type) => type.trim().toLowerCase())
      .filter(Boolean);
  }

  /** The search can't filter on this, and classification is often empty, so objectName is checked too */
  private isWantedType(object: MetObject): boolean {
    const kind = `${object.classification} ${object.objectName}`.toLowerCase();
    return this.objectTypes.some((type) => kind.includes(type));
  }

  private get selectionFilters(): Record<string, string> {
    const selection = this.param('selection').toLowerCase();
    const filters = SELECTIONS[selection];
    if (!filters) {
      throw new Error(
        `Unknown Met selection "${selection}", use one of: ${Object.keys(SELECTIONS).join(', ')}`
      );
    }
    return filters;
  }

  private async search(departmentId: string, offset: number): Promise<MetSearchResponse> {
    const params = new URLSearchParams({
      hasImages: 'true',
      isPublicDomain: 'true',
      ...this.selectionFilters,
      departmentId,
      q: this.param('query'),
      offset: String(offset),
      limit: String(PAGE_SIZE),
    });
    return fetchJson<MetSearchResponse>(`${MET_API_URL}/v1.1/search?${params}`);
  }

  /** The search only filters on a single department, so each one is paged through separately. */
  private async fetchNextIds(departmentId: string, state: DepartmentState): Promise<void> {
    if (state.total !== null && state.offset >= state.total) {
      state.offset = 0;
    }
    let { total, objectIDs } = await this.search(departmentId, state.offset);
    if (!objectIDs?.length && state.offset > 0) {
      // Ran past the end of the results, start over
      state.offset = 0;
      ({ total, objectIDs } = await this.search(departmentId, state.offset));
    }
    if (!objectIDs?.length) {
      throw new Error(`No artworks found at The Met in department ${departmentId} for the configured selection and query.`);
    }
    // Neighbouring IDs are often the same artist or series, so shuffle to spread them out
    state.ids = shuffle(objectIDs);
    state.offset += PAGE_SIZE;
    state.total = total;
  }

  private async fetchNextObject(data: MetData): Promise<MetObject> {
    const departmentIds = await this.getDepartmentIds();
    let lastError: unknown;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const departmentId = departmentIds[data.nextDepartment % departmentIds.length];
      data.nextDepartment = (data.nextDepartment + 1) % departmentIds.length;
      const state = (data.departments[departmentId] ??= { ids: [], offset: 0, total: null });
      try {
        if (!state.ids.length) {
          await this.fetchNextIds(departmentId, state);
        }
        const object = await fetchJson<MetObject>(`${MET_API_URL}/v1/objects/${state.ids.pop()}`);
        if ((object.primaryImage || object.primaryImageSmall) && this.isWantedType(object)) {
          return object;
        }
      } catch (error) {
        if (error instanceof MetRateLimitError) {
          // Retrying now would only extend the block
          throw error;
        }
        // Skip this department or object and try the next one
        lastError = error;
      }
    }
    const reason = lastError instanceof Error ? ` Last error: ${lastError.message}` : '';
    throw new Error(
      `Could not find a Met artwork with an image of a wanted object type in ${MAX_ATTEMPTS} tries.${reason}`,
      { cause: lastError }
    );
  }

  /** The original is full resolution; the small one is only ~600px, so it's just a fallback */
  private async fetchObjectImage(
    object: MetObject
  ): Promise<{ stream: ReadableStream; contentType: string }> {
    const urls = [object.primaryImage, object.primaryImageSmall].filter(Boolean);
    let lastError: unknown;
    for (const url of urls) {
      try {
        return await this.downloadImage(url);
      } catch (error) {
        lastError = error;
      }
    }
    throw new Error('Could not get image from The Met.', { cause: lastError });
  }

  async getContent(): Promise<{ stream: ReadableStream; contentType: string }> {
    assertNotRateLimited();
    const prevData = this.store.getPrevData();
    const filter = `${this.param('selection')}|${this.param('query')}`;
    const data: MetData = {
      filter,
      // Saved offsets only apply to the search they were made for
      departments: prevData?.filter === filter ? prevData.departments : {},
      nextDepartment: prevData?.nextDepartment ?? 0,
    };

    let object: MetObject;
    try {
      object = await this.fetchNextObject(data);
    } finally {
      // Keep the rotation moving even when this attempt failed
      this.store.setPrevData(data);
    }

    const content = await this.fetchObjectImage(object);
    this.store.setInfo({
      title: object.title,
      sourceUrl: object.objectURL,
      description: `Artwork by ${object.artistDisplayName || 'unknown artist'} from The Metropolitan Museum of Art`,
    });
    return content;
  }

  getInfo(): Promise<ContentInfo> {
    return Promise.resolve(this.store.getInfo());
  }
}
