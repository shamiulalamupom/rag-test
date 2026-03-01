import "dotenv/config";
import { retrieveChunksHybrid } from "./query/retrieve";
import { rerank } from "./query/rerank";
import { buildPrompt } from "./query/prompt";
import { generateStructured } from "./ollama/client";
import {
  RagAnswerSchema,
  RagAnswerJsonSchema,
  type RagAnswer,
} from "./query/answerSchema";
import { pool } from "./db/pool";
import { logger } from "./utils/logger";

function createAbstainedAnswer(missingInfo: string): RagAnswer {
  return {
    abstained: true,
    answer: "",
    citations: [],
    missing_info: missingInfo,
    confidence: "low",
  };
}

function tryParseJSON(response: string): unknown {
  // First attempt: direct parse
  try {
    return JSON.parse(response);
  } catch {
    // Fallback: extract first {...} and try again
    const match = response.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        return JSON.parse(match[0]);
      } catch {
        return null;
      }
    }
    return null;
  }
}

async function main(): Promise<void> {
  const question = process.argv.slice(2).join(" ").trim();
  if (!question) throw new Error("Provide a question");

  const chunks = await retrieveChunksHybrid(question);

  logger.debug("Retrieved chunks:", {
    phase: "post_retrieve",
    counts: { chunks: chunks.length },
  });

  for (const c of chunks) {
    logger.debug(
      `- score=${c.score.toFixed(4)} doc=${c.documentId} page=${c.pageNumber} chunk=${c.chunkIndex}`,
    );
  }

  const reranked = await rerank(question, chunks);

  logger.debug("Reranked chunks:", {
    phase: "post_rerank",
    counts: { chunks: reranked.length },
  });

  // If no chunks retrieved, abstain immediately
  if (reranked.length === 0) {
    const abstainedAnswer = createAbstainedAnswer(
      "No relevant context found in the knowledge base.",
    );
    console.log(JSON.stringify(abstainedAnswer, null, 2));
    await pool.end();
    return;
  }

  const promptPair = buildPrompt(question, reranked);
  let answerJson: unknown;

  try {
    const response = await generateStructured({
      system: promptPair.system,
      prompt: promptPair.prompt,
      format: RagAnswerJsonSchema,
    });

    logger.debug(`Raw response: ${response}`);

    answerJson = tryParseJSON(response);
    if (!answerJson) {
      const abstainedAnswer = createAbstainedAnswer(
        "Failed to parse model response as JSON.",
      );
      console.log(JSON.stringify(abstainedAnswer, null, 2));
      await pool.end();
      return;
    }
  } catch (err) {
    const abstainedAnswer = createAbstainedAnswer(
      `LLM generation failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    console.log(JSON.stringify(abstainedAnswer, null, 2));
    await pool.end();
    return;
  }

  const parseResult = RagAnswerSchema.safeParse(answerJson);
  if (!parseResult.success) {
    const abstainedAnswer = createAbstainedAnswer(
      `Answer validation failed: ${parseResult.error.message}`,
    );
    console.log(JSON.stringify(abstainedAnswer, null, 2));
    await pool.end();
    return;
  }

  const answer = parseResult.data;

  // Grounding check: all citations must reference retrieved chunks
  if (!answer.abstained) {
    const allowedChunkIds = new Set(reranked.map((c) => c.chunkId));
    const invalidCitations = answer.citations.filter(
      (id) => !allowedChunkIds.has(id),
    );

    if (invalidCitations.length > 0) {
      logger.debug(
        `Invalid citations detected: ${invalidCitations.join(", ")}. Abstaining.`,
      );
      const abstainedAnswer = createAbstainedAnswer(
        `Model cited chunks not in retrieval set: ${invalidCitations.join(", ")}`,
      );
      console.log(JSON.stringify(abstainedAnswer, null, 2));
      await pool.end();
      return;
    }
  }

  console.log(JSON.stringify(answer, null, 2));

  await pool.end();
}

main().catch(async (err) => {
  console.error(err);
  try {
    await pool.end();
  } catch {}
  process.exit(1);
});
