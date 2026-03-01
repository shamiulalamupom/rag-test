export interface EmbeddingCacheEntry {
  embedding: number[];
  timestamp: number;
}

const embeddingCache = new Map<string, EmbeddingCacheEntry>();

const normalize = (text: string): string => text.trim().toLowerCase();

export const embeddingCache_module = {
  get: (query: string): number[] | null => {
    const key = normalize(query);
    const entry = embeddingCache.get(key);
    return entry ? entry.embedding : null;
  },

  set: (query: string, embedding: number[]): void => {
    const key = normalize(query);
    embeddingCache.set(key, {
      embedding,
      timestamp: Date.now(),
    });
  },

  clear: (): void => {
    embeddingCache.clear();
  },

  size: (): number => embeddingCache.size,
};
