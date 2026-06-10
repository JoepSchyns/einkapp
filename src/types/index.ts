export type JsonPrimitive = string | number | boolean | null;
export type JsonArray = JsonType[];
export type JsonObject = { [key: string]: JsonType };
export type JsonType = JsonPrimitive | JsonArray | JsonObject;

export function isJsonObject(value: JsonType): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export type ContentInfo = {
  title: string;
  description: string;
  sourceUrl: string;
} | null;

export interface EinkApplication {
  getContent(...args: unknown[]): Promise<{ stream: ReadableStream; contentType: string }>;
  getInfo(...args: unknown[]): Promise<ContentInfo>;
}
