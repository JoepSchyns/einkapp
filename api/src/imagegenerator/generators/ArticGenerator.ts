import type { ContentInfo, JsonObject } from '../../types/index.js';
import { ImageGenerator } from '../ImageGenerator.js';

const INITIAL_ARTIC_SEARCH_URL =
  'https://api.artic.edu/api/v1/artworks?fields=id,image_id,artwork_type_id,title,artist_display';
const ARTWORK_TYPE_IDS = [1, 18, 15, 14, 32, 30, 13, 2];

interface ArticSearchResponse {
  data: {
    id: number;
    image_id: string | null;
    artwork_type_id: number;
    title: string;
    artist_display: string;
  }[];
  config: { iiif_url: string };
  pagination: { next_url: string | null };
}

interface ArticData extends JsonObject {
  images: (ArticSearchResponse['data'][number] & { imageUrl: string })[];
  nextUrl: string | null;
}

export default class ArticGenerator extends ImageGenerator<ArticData> {
  private async fetchNextImages(data: ArticData): Promise<void> {
    const url = data.nextUrl ?? INITIAL_ARTIC_SEARCH_URL;
    const {
      data: artworks,
      config,
      pagination,
    } = (await fetch(url).then((r) => r.json())) as ArticSearchResponse;
    data.images = artworks
      .filter((a) => a.image_id && ARTWORK_TYPE_IDS.includes(a.artwork_type_id))
      .map((a) => ({ ...a, imageUrl: `${config.iiif_url}/${a.image_id}/full/full/0/default.jpg` }));
    data.nextUrl = pagination.next_url;
  }

  async getContent(): Promise<{ stream: ReadableStream; contentType: string }> {
    const prevData = this.store.getPrevData();
    const data: ArticData = {
      images: prevData?.images ?? [],
      nextUrl: prevData?.nextUrl ?? INITIAL_ARTIC_SEARCH_URL,
    };

    if (!data.images.length) {
      await this.fetchNextImages(data);
    }
    const image = data.images.pop()!;
    this.store.setPrevData(data);

    const imageResponse = await fetch(image.imageUrl, {
      headers: { 'AIC-User-Agent': 'wall art tool (eink@boterham.men)' },
    });
    const stream = imageResponse.body;
    if (!stream) {
      throw new Error('Could not get image stream from Artic.');
    }
    const contentType = imageResponse.headers.get('Content-Type');
    if (!contentType) {
      throw new Error('Could not determine content type of the image.');
    }
    this.store.setInfo({
      title: image.title,
      sourceUrl: 'https://artic.edu/artworks/' + image.id,
      description: `Artwork by ${image.artist_display} from the Art Institute of Chicago`,
    });
    return { stream, contentType };
  }

  getInfo(): Promise<ContentInfo> {
    return Promise.resolve(this.store.getInfo());
  }
}
