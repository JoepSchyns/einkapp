import type { ContentInfo, JsonObject } from '../../types/index.js';
import { ImageGenerator } from '../ImageGenerator.js';

interface RedditPost extends JsonObject {
  data: {
    id: string;
    title: string;
    subreddit: string;
    permalink: string;
    preview: {
      images: {
        source: {
          url: string;
          width: number;
          height: number;
        };
      }[];
    };
  };
}

interface RedditData extends JsonObject {
  previousPostIds: RedditPost['data']['id'][];
}
export default class RedditGenerator extends ImageGenerator<RedditData> {
  static label = 'Reddit';
  static requiredEnv = ['REDDIT_CLIENT_ID', 'REDDIT_CLIENT_SECRET'];
  static params = [
    {
      key: 'subreddits',
      label: 'Subreddits',
      default: 'art, photographs',
      description: 'Comma separated, e.g. art, photographs',
    },
    {
      key: 'sort',
      label: 'Sort',
      default: 'hot',
      options: [
        { value: 'hot', label: 'Hot' },
        { value: 'new', label: 'New' },
        { value: 'rising', label: 'Rising' },
        { value: 'top-hour', label: 'Top of the hour' },
        { value: 'top-day', label: 'Top of the day' },
        { value: 'top-week', label: 'Top of the week' },
        { value: 'top-month', label: 'Top of the month' },
        { value: 'top-year', label: 'Top of the year' },
        { value: 'top-all', label: 'Top of all time' },
      ],
    },
  ];

  /** Subreddits combined into a multireddit path, e.g. `art+photographs` */
  get subreddit(): string {
    return this.param('subreddits')
      .split(',')
      .map((name) => name.trim().replace(/^\/?r\//, ''))
      .filter(Boolean)
      .join('+');
  }

  /** Listing path and query for the configured sort, e.g. `top` + `t=week` */
  get sort(): { listing: string; query: string } {
    const value = this.param('sort').toLowerCase();
    const [listing, period] = value.split('-');
    if (['hot', 'new', 'rising'].includes(listing) && !period) {
      return { listing, query: '' };
    }
    if (
      listing === 'top' &&
      ['hour', 'day', 'week', 'month', 'year', 'all', undefined].includes(period)
    ) {
      return { listing, query: `&t=${period ?? 'day'}` };
    }
    throw new Error(`Unknown Reddit sort "${value}"`);
  }

  async redditAuthFetch(after?: string): Promise<Response> {
    const client_id = process.env.REDDIT_CLIENT_ID;
    const client_secret = process.env.REDDIT_CLIENT_SECRET;
    if (!client_id || !client_secret) {
      throw new Error('Reddit client ID and secret must be set in environment variables.');
    }
    const tokenResponse = await fetch('https://www.reddit.com/api/v1/access_token', {
      method: 'POST',
      headers: {
        Authorization: `Basic ${btoa(`${client_id}:${client_secret}`)}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: 'grant_type=client_credentials',
    });

    const { access_token } = (await tokenResponse.json()) as { access_token: string };

    const subreddits = this.subreddit.split('+').map(encodeURIComponent).join('+');
    const { listing, query } = this.sort;
    return fetch(
      `https://oauth.reddit.com/r/${subreddits}/${listing}.json?after=${after ?? ''}${query}`,
      {
        headers: { Authorization: `Bearer ${access_token}` },
      }
    );
  }
  private isPostGoodImage(post: RedditPost): boolean {
    if (!post.data.preview || !post.data.preview.images || post.data.preview.images.length === 0) {
      return false;
    }
    const {
      images: [
        {
          source: { url: imgUrl },
        },
      ],
    } = post.data.preview;
    return Boolean(imgUrl.match(/\.(jpg|jpeg|png)/i));
  }
  async getContent(after?: string): Promise<{ stream: ReadableStream; contentType: string }> {
    const redditData = await this.redditAuthFetch(after);

    const rawBody = await redditData.text();
    let newAfter: string | undefined;
    let children: RedditPost[] = [];
    try {
      const parsedData = JSON.parse(rawBody) as {
        data: {
          after: string;
          children: RedditPost[];
        };
      };
      newAfter = parsedData.data.after;
      children = parsedData.data.children;
    } catch (error) {
      console.error('Failed to parse JSON response:', error, 'Raw content received:');
      console.error(rawBody);
    }

    if (!children || children.length === 0) {
      throw new Error(`No posts found in subreddit ${this.subreddit}`);
    }
    const imagePosts = children.filter(this.isPostGoodImage);
    if (imagePosts.length === 0) {
      throw new Error(`No good image posts found in subreddit ${this.subreddit}`);
    }
    const prevData = this.store.getPrevData();
    const newImages = imagePosts.filter((img) => !prevData?.previousPostIds?.includes(img.data.id));
    if (newImages.length === 0) {
      console.log(`Current page of r/${this.subreddit} has no new images. Fetching next page...`);
      return this.getContent(newAfter);
    }
    const [firstPost] = newImages;
    const imageUrl = firstPost.data.preview.images[0].source.url.replace(/&amp;/g, '&');

    const content = await this.downloadImage(imageUrl);
    this.store.setInfo({
      title: firstPost.data.title,
      sourceUrl: `https://reddit.com${firstPost.data.permalink}`,
      description: `Image post from subreddit r/${firstPost.data.subreddit}`,
    });
    const newData = { previousPostIds: [...(prevData?.previousPostIds ?? []), firstPost.data.id] };
    // Keep only the last 1000 post IDs to prevent unbounded growth
    newData.previousPostIds = newData.previousPostIds.slice(-1000);

    this.store.setPrevData(newData);
    return content;
  }
  getInfo(): Promise<ContentInfo> {
    return Promise.resolve(this.store.getInfo());
  }
}
