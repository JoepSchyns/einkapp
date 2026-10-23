import type { ContentInfo, JsonObject } from '../../types/index.js';
import { ImageGenerator } from '../ImageGenerator.js';

const API_URL = 'https://api.unsplash.com';
/** The most the API returns per page; a page is one request, and a demo key allows 50 per hour */
const PAGE_SIZE = 30;
const REQUEST_TIMEOUT_MS = 30_000;

/** Unsplash's own editorial topics; the random endpoint only filters on their id, not the slug */
const TOPICS = [
  { value: 'bo8jQKTaE0Y', label: 'Wallpapers' },
  { value: '6sMVjTLSkeQ', label: 'Nature' },
  { value: 'M8jVbLbTRws', label: 'Architecture & Interiors' },
  { value: 'iUIsnVtjB0Y', label: 'Textures & Patterns' },
  { value: 'qPYsDzvJOYc', label: 'Experimental' },
  { value: 'CDwuwXJAbEw', label: '3D Renders' },
  { value: 'Fzo3zuOHN6w', label: 'Travel' },
  { value: 'xHxYTMHLgOc', label: 'Street Photography' },
  { value: 'hmenvQhUmxM', label: 'Film' },
  { value: 'Jpg6Kidl-Hk', label: 'Animals' },
  { value: 'towJZFskpGg', label: 'People' },
  { value: 'S4MKLAsBB74', label: 'Fashion & Beauty' },
  { value: 'If65AuNOOxQ', label: 'Illustrations: Wallpapers' },
  { value: 'M4lsf7LQDRA', label: 'Illustrations: Nature' },
  { value: 'upmleWZC83Y', label: 'Illustrations: Patterns' },
  { value: 'crNmQgdzrGY', label: 'Illustrations: Award' },
];

interface UnsplashPhoto {
  urls: { full: string };
  description: string | null;
  alt_description: string | null;
  links: { html: string };
  user: { name: string };
  likes: number;
}

interface Photo extends JsonObject {
  imageUrl: string;
  title: string;
  sourceUrl: string;
  photographer: string;
}

interface UnsplashData extends JsonObject {
  filter: string;
  /** Most popular first: the next page to fetch and the photos left of the current one */
  page: number;
  photos: Photo[];
}

export default class UnsplashGenerator extends ImageGenerator<UnsplashData> {
  static label = 'Unsplash';
  static requiredEnv = ['UNSPLASH_ACCESS_KEY'];
  static params = [
    {
      key: 'topic',
      label: 'Topics',
      default: '',
      description: 'Collections picked by Unsplash editors. Without a topic the search query is used',
      options: TOPICS,
      multiple: true,
    },
    {
      key: 'query',
      label: 'Search query',
      default: 'art',
      description: 'Used when no topic is chosen',
    },
    {
      key: 'order',
      label: 'Order',
      default: 'random',
      description: 'Popularity is the number of likes. For a search there is no popularity, the best matches come first',
      options: [
        { value: 'random', label: 'Random' },
        { value: 'popular', label: 'Most popular first' },
      ],
    },
  ];

  /** The chosen topic ids, sorted; empty means the search query is used */
  private get topics(): string[] {
    const topics = [
      ...new Set(
        this.param('topic')
          .split(',')
          .map((t) => t.trim())
          .filter(Boolean)
      ),
    ].sort();
    const unknown = topics.filter((t) => !TOPICS.some((o) => o.value === t));
    if (unknown.length) {
      throw new Error(`Unknown Unsplash topics "${unknown.join(', ')}".`);
    }
    return topics;
  }

  private async api<T>(path: string, params: Record<string, string>): Promise<T> {
    const accessKey = process.env.UNSPLASH_ACCESS_KEY;
    if (!accessKey) {
      throw new Error('UNSPLASH_ACCESS_KEY must be set in environment variables.');
    }
    const response = await fetch(`${API_URL}${path}?${new URLSearchParams(params)}`, {
      headers: { Authorization: `Client-ID ${accessKey}`, 'Accept-Version': 'v1' },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new Error(`Unsplash returned ${response.status}: ${(await response.text()).slice(0, 200)}`);
    }
    return (await response.json()) as T;
  }

  private toPhoto(photo: UnsplashPhoto): Photo {
    return {
      imageUrl: `${photo.urls.full}&fm=jpg`,
      // Descriptions can run over several lines, e.g. with credits below the title
      title: (photo.description ?? photo.alt_description ?? `Photo by ${photo.user.name}`).split('\n')[0].trim(),
      sourceUrl: photo.links.html,
      photographer: photo.user.name,
    };
  }

  private async randomPhoto(): Promise<Photo> {
    const topics = this.topics;
    // A photo from any of the topics
    const params: Record<string, string> = topics.length
      ? { topics: topics.join(',') }
      : { query: this.param('query') };
    return this.toPhoto(await this.api<UnsplashPhoto>('/photos/random', params));
  }

  /**
   * The next page of photos, the first to show at the end; empty past the last page. With topics
   * it is that page of every topic, merged by likes; for a search the page by relevance.
   */
  private async fetchPage(page: number): Promise<Photo[]> {
    const paging = { page: String(page), per_page: String(PAGE_SIZE) };
    const topics = this.topics;
    if (!topics.length) {
      const { results } = await this.api<{ results: UnsplashPhoto[] }>('/search/photos', {
        ...paging,
        query: this.param('query'),
        order_by: 'relevant',
      });
      return results.map((p) => this.toPhoto(p)).reverse();
    }
    const pages = await Promise.all(
      topics.map((topic) =>
        this.api<UnsplashPhoto[]>(`/topics/${topic}/photos`, { ...paging, order_by: 'popular' })
      )
    );
    // A photo can be in more than one topic
    const unique = new Map(pages.flat().map((p) => [p.links.html, p]));
    return [...unique.values()]
      .sort((a, b) => a.likes - b.likes)
      .map((p) => this.toPhoto(p));
  }

  private async nextPhoto(data: UnsplashData): Promise<Photo> {
    if (this.param('order') !== 'popular') {
      return this.randomPhoto();
    }
    if (!data.photos.length) {
      data.photos = await this.fetchPage(data.page);
      data.page++;
      if (!data.photos.length) {
        // Past the last page: start over with the most popular
        data.photos = await this.fetchPage(1);
        data.page = 2;
      }
      if (!data.photos.length) {
        throw new Error(`No Unsplash photos found for "${this.param('query')}".`);
      }
    }
    return data.photos.pop()!;
  }

  async getContent(): Promise<{ stream: ReadableStream; contentType: string }> {
    const prevData = this.store.getPrevData();
    const filter = ['topic', 'query', 'order'].map((key) => this.param(key)).join('|');
    const keep = prevData?.filter === filter && Array.isArray(prevData.photos);
    const data: UnsplashData = {
      filter,
      page: keep ? prevData.page : 1,
      photos: keep ? prevData.photos : [],
    };

    let photo: Photo;
    try {
      photo = await this.nextPhoto(data);
    } finally {
      this.store.setPrevData(data);
    }

    const content = await this.downloadImage(photo.imageUrl);
    const topics = this.topics;
    const kind =
      topics.length === 1
        ? `${TOPICS.find((t) => t.value === topics[0])!.label} photo`
        : topics.length
          ? 'Photo'
          : `Photo for "${this.param('query')}"`;
    this.store.setInfo({
      title: photo.title,
      sourceUrl: photo.sourceUrl,
      description: `${kind} from Unsplash by ${photo.photographer}`,
    });
    return content;
  }

  getInfo(): Promise<ContentInfo> {
    return Promise.resolve(this.store.getInfo());
  }
}
