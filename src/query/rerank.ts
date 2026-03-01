import { z } from "zod";
import { generateStructured } from "../ollama/client";
import { rerankerCache_module } from "../cache/rerank";
import { logger } from "../utils/logger";
import type { RetrievedChunk } from "./retrieve";

const RerankerResponseSchema = z.array(
  z.object({
    chunkId: z.string().uuid(),
    score: z.number().min(0).max(10),
  }),
);

export interface RerankerOptions {
  enabled?: boolean;
  candidates?: number;
  topK?: number;
  threshold?: number;
}

export async function rerank(
  question: string,
  chunks: RetrievedChunk[],
  options?: RerankerOptions,
): Promise<RetrievedChunk[]> {
  const enabled = options?.enabled ?? process.env.RERANK_ENABLED !== "false";
  if (!enabled) return chunks;

  const topK = options?.topK ?? Number(process.env.RERANK_TOP_K ?? "12");
  const threshold =
    options?.threshold ?? Number(process.env.RERANK_THRESHOLD ?? "4");

  const startTime = Date.now();
  const scores: Record<string, number> = {};

  const toScore = chunks.slice(0, options?.candidates ?? 50);
  logger.debug(`Reranking ${toScore.length} candidates`, {
    phase: "rerank_start",
    counts: { candidates: toScore.length, threshold },
  });

  for (const chunk of toScore) {
    const cached = rerankerCache_module.get(question, chunk.text);
    if (cached !== null) {
      scores[chunk.chunkId] = cached;
      continue;
    }

    const prompt = `Given the question and context chunk, rate the relevance on a scale of 0-10.

Question: ${question}

Chunk:
${chunk.text}

Respond with ONLY a JSON object: {"chunkId": "${chunk.chunkId}", "score": <number 0-10>}`;

    try {
      const response = await generateStructured({
        system:
          "You are a relevance rater. Rate chunk relevance to the question (0-10). Respond with only JSON.",
        prompt,
        format: {
          type: "object",
          properties: {
            chunkId: { type: "string" },
            score: { type: "number" },
          },
          required: ["chunkId", "score"],
        },
        temperature: 0,
      });

      const parsed = RerankerResponseSchema.parse(JSON.parse(response));
      if (parsed.length > 0) {
        const score = parsed[0].score;
        scores[chunk.chunkId] = score;
        rerankerCache_module.set(question, chunk.text, score);
      }
    } catch (err) {
      logger.debug(
        `Rerank error for chunk ${chunk.chunkId.slice(0, 8)}: ${err}`,
      );
      scores[chunk.chunkId] = 0;
    }
  }

  const reranked = chunks
    .map((c) => ({
      ...c,
      score: scores[c.chunkId] ?? 0,
    }))
    .filter((c) => c.score >= threshold)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);

  const elapsed = Date.now() - startTime;
  logger.debug(`Reranked to ${reranked.length}/${chunks.length} chunks`, {
    phase: "rerank_done",
    timings: { rerank_ms: elapsed },
    counts: {
      final: reranked.length,
      below_threshold: chunks.length - reranked.length,
    },
  });

  return reranked;
}
