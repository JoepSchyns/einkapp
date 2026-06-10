import type { ContentInfo, JsonObject } from '../types/index.js';
import { ImageGenerator } from './ImageGenerator.js';

interface RedditPost extends JsonObject {
  data: {
    id: string;
    title: string;
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
export abstract class RedditGenerator extends ImageGenerator<RedditData> {
  abstract subreddit: string;

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

    const { access_token } = await tokenResponse.json();

    return fetch(`https://oauth.reddit.com/r/${this.subreddit}.json?after=${after ?? ''}`, {
      headers: { Authorization: `Bearer ${access_token}` },
    });
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
    const {
      data: { after: newAfter, children },
    } = (await redditData.json()) as { data: { after: string; children: RedditPost[] } };
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

    const response = await fetch(imageUrl);
    const stream = response.body;
    if (!stream) {
      throw new Error('Could not get image stream from Reddit.');
    }
    const contentType = response.headers.get('Content-Type');
    if (!contentType) {
      throw new Error('Could not determine content type of the image.');
    }
    this.store.setInfo({
      title: firstPost.data.title,
      sourceUrl: `https://reddit.com${firstPost.data.permalink}`,
      description: `Image post from subreddit r/${this.subreddit}`,
    });
    const newData = { previousPostIds: [...(prevData?.previousPostIds ?? []), firstPost.data.id] };
    // Keep only the last 1000 post IDs to prevent unbounded growth
    newData.previousPostIds = newData.previousPostIds.slice(-1000);

    this.store.setPrevData(newData);
    return { stream, contentType };
  }
  getInfo(): Promise<ContentInfo> {
    return Promise.resolve(this.store.getInfo());
  }
}
