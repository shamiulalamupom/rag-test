import "dotenv/config";
import * as fs from "fs";
import * as path from "path";
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

interface EvalQuestion {
  id: string;
  question: string;
  expected_contains?: string[];
  category?: string;
}

interface EvalMetrics {
  retrieval_hit_count: number;
  retrieval_hit_rate: number;
  citation_valid_count: number;
  citation_valid_rate: number;
  json_valid_count: number;
  json_valid_rate: number;
  abstain_count: number;
  abstain_rate: number;
  avg_latency_ms: number;
  total_questions: number;
}

function tryParseJSON(response: string): unknown {
  try {
    return JSON.parse(response);
  } catch {
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

function loadQuestions(filePath: string): EvalQuestion[] {
  const content = fs.readFileSync(filePath, "utf-8");
  const lines = content.trim().split("\n");
  return lines.map((line) => JSON.parse(line));
}

function checkHit(retrieved: string, expected: string[]): boolean {
  const lowerRetreived = retrieved.toLowerCase();
  return expected.some((exp) => lowerRetreived.includes(exp.toLowerCase()));
}

async function evalQuestion(question: EvalQuestion): Promise<{
  hit: boolean;
  validJson: boolean;
  validCitations: boolean;
  abstained: boolean;
  latencyMs: number;
}> {
  const startTime = Date.now();

  try {
    const chunks = await retrieveChunksHybrid(question.question);
    const reranked = await rerank(question.question, chunks);

    if (reranked.length === 0) {
      return {
        hit: false,
        validJson: true,
        validCitations: true,
        abstained: true,
        latencyMs: Date.now() - startTime,
      };
    }

    const retrievedText = reranked.map((c) => c.text).join(" ");
    const hit = question.expected_contains
      ? checkHit(retrievedText, question.expected_contains)
      : false;

    const promptPair = buildPrompt(question.question, reranked);

    let answerJson: unknown;
    try {
      const response = await generateStructured({
        system: promptPair.system,
        prompt: promptPair.prompt,
        format: RagAnswerJsonSchema,
      });

      answerJson = tryParseJSON(response);
      if (!answerJson) {
        return {
          hit,
          validJson: false,
          validCitations: false,
          abstained: false,
          latencyMs: Date.now() - startTime,
        };
      }
    } catch (err) {
      return {
        hit,
        validJson: false,
        validCitations: false,
        abstained: false,
        latencyMs: Date.now() - startTime,
      };
    }

    const parseResult = RagAnswerSchema.safeParse(answerJson);
    if (!parseResult.success) {
      return {
        hit,
        validJson: false,
        validCitations: false,
        abstained: false,
        latencyMs: Date.now() - startTime,
      };
    }

    const answer = parseResult.data;

    let validCitations = true;
    if (!answer.abstained) {
      const allowedIds = new Set(reranked.map((c) => c.chunkId));
      validCitations = answer.citations.every((id) => allowedIds.has(id));
    }

    return {
      hit,
      validJson: true,
      validCitations,
      abstained: answer.abstained,
      latencyMs: Date.now() - startTime,
    };
  } catch (err) {
    return {
      hit: false,
      validJson: false,
      validCitations: false,
      abstained: false,
      latencyMs: Date.now() - startTime,
    };
  }
}

async function main(): Promise<void> {
  const questionsFile = path.join(__dirname, "../eval/questions.jsonl");

  if (!fs.existsSync(questionsFile)) {
    console.error(`Questions file not found: ${questionsFile}`);
    process.exit(1);
  }

  const questions = loadQuestions(questionsFile);
  const results = [];
  let hitCount = 0;
  let validJsonCount = 0;
  let validCitationsCount = 0;
  let abstainCount = 0;
  let totalLatency = 0;

  console.error(`Running eval on ${questions.length} questions...`);

  for (const q of questions) {
    const result = await evalQuestion(q);
    results.push(result);

    if (result.hit) hitCount++;
    if (result.validJson) validJsonCount++;
    if (result.validCitations) validCitationsCount++;
    if (result.abstained) abstainCount++;
    totalLatency += result.latencyMs;

    const status = result.hit ? "✓" : "✗";
    console.error(
      `${status} ${q.id}: ${result.latencyMs}ms (hit=${result.hit}, json=${result.validJson}, citations=${result.validCitations})`,
    );
  }

  const metrics: EvalMetrics = {
    retrieval_hit_count: hitCount,
    retrieval_hit_rate: hitCount / questions.length,
    citation_valid_count: validCitationsCount,
    citation_valid_rate: validCitationsCount / questions.length,
    json_valid_count: validJsonCount,
    json_valid_rate: validJsonCount / questions.length,
    abstain_count: abstainCount,
    abstain_rate: abstainCount / questions.length,
    avg_latency_ms: Math.round(totalLatency / questions.length),
    total_questions: questions.length,
  };

  console.error("\n================== EVALUATION REPORT ==================");
  console.error("\nRETRIEVAL METRICS");
  console.error(
    `├─ hit@: ${(metrics.retrieval_hit_rate * 100).toFixed(1)}% (${metrics.retrieval_hit_count}/${metrics.total_questions})`,
  );

  console.error("\nGENERATION METRICS");
  console.error(
    `├─ valid_json: ${(metrics.json_valid_rate * 100).toFixed(1)}% (${metrics.json_valid_count}/${metrics.total_questions})`,
  );
  console.error(
    `├─ valid_citations: ${(metrics.citation_valid_rate * 100).toFixed(1)}% (${metrics.citation_valid_count}/${metrics.total_questions})`,
  );
  console.error(
    `└─ abstain_rate: ${(metrics.abstain_rate * 100).toFixed(1)}% (${metrics.abstain_count}/${metrics.total_questions})`,
  );

  console.error("\nPERFORMANCE");
  console.error(`└─ avg_latency: ${metrics.avg_latency_ms}ms`);

  const threshold = 0.8;
  const allPass =
    metrics.retrieval_hit_rate >= threshold &&
    metrics.json_valid_rate >= threshold &&
    metrics.citation_valid_rate >= threshold;

  console.error("\nOVERALL:", allPass ? "✓ PASS" : "✗ FAIL");
  console.error("======================================================\n");

  await pool.end();
  process.exit(allPass ? 0 : 1);
}

main().catch(async (err) => {
  console.error(err);
  try {
    await pool.end();
  } catch {}
  process.exit(1);
});
