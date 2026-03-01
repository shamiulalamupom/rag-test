import crypto from "crypto";

export interface RerankerCacheEntry {
  score: number;
  timestamp: number;
}

const rerankerCache = new Map<string, RerankerCacheEntry>();

const hashKey = (questionHash: string, chunkHash: string): string =>
  `${questionHash}:${chunkHash}`;

const hash = (text: string): string =>
  crypto.createHash("sha256").update(text).digest("hex");

export const rerankerCache_module = {
  get: (question: string, chunkText: string): number | null => {
    const qHash = hash(question);
    const cHash = hash(chunkText);
    const entry = rerankerCache.get(hashKey(qHash, cHash));
    return entry ? entry.score : null;
  },

  set: (question: string, chunkText: string, score: number): void => {
    const qHash = hash(question);
    const cHash = hash(chunkText);
    rerankerCache.set(hashKey(qHash, cHash), {
      score,
      timestamp: Date.now(),
    });
  },

  clear: (): void => {
    rerankerCache.clear();
  },

  size: (): number => rerankerCache.size,
};
