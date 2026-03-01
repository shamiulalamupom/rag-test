import { z } from "zod";
import { logger } from "../utils/logger";
import { embeddingCache_module } from "../cache/embeddings";

const OllamaEmbedResponse = z.object({
  embedding: z.array(z.number()),
});

const OllamaGenerateResponse = z.object({
  response: z.string(),
});

interface GenerateStructuredParams {
  system: string;
  prompt: string;
  format: Record<string, unknown>;
  temperature?: number;
}

function expectedEmbedDim(): number | null {
  const v = process.env.EMBED_DIM;
  if (!v) return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0)
    throw new Error("EMBED_DIM must be a positive number");
  return n;
}

function getTimeoutMs(): number {
  const v = process.env.OLLAMA_TIMEOUT_MS;
  return v ? Number(v) : 60000;
}

function getMaxRetries(): number {
  const v = process.env.OLLAMA_RETRIES;
  return v ? Number(v) : 2;
}

async function fetchWithRetry<T>(
  fn: () => Promise<T>,
  maxRetries: number,
): Promise<T> {
  let lastError: Error | null = null;
  for (let i = 0; i <= maxRetries; i++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (i < maxRetries) {
        const delayMs = Math.pow(2, i) * 1000;
        logger.debug(`Retry ${i + 1}/${maxRetries} after ${delayMs}ms`, {
          phase: "ollama_retry",
        });
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
  }
  throw lastError;
}

async function fetchWithTimeout(
  url: string,
  options: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeoutId);
  }
}

export async function embed(text: string): Promise<number[]> {
  const cached = embeddingCache_module.get(text);
  if (cached) return cached;

  const baseUrl = process.env.OLLAMA_URL;
  const model = process.env.EMBED_MODEL;
  if (!baseUrl) throw new Error("OLLAMA_URL is required");
  if (!model) throw new Error("EMBED_MODEL is required");

  const timeoutMs = getTimeoutMs();
  const maxRetries = getMaxRetries();

  const res = await fetchWithRetry(
    async () =>
      fetchWithTimeout(
        `${baseUrl}/api/embeddings`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ model, prompt: text }),
        },
        timeoutMs,
      ),
    maxRetries,
  );

  if (!res.ok)
    throw new Error(
      `Ollama embeddings failed: ${res.status} ${await res.text()}`,
    );

  const json = OllamaEmbedResponse.parse(await res.json());
  const exp = expectedEmbedDim();
  if (exp !== null && json.embedding.length !== exp) {
    throw new Error(
      `Expected ${exp}-dim embedding, got ${json.embedding.length}`,
    );
  }

  embeddingCache_module.set(text, json.embedding);
  return json.embedding;
}

export async function generate(prompt: string): Promise<string> {
  const baseUrl = process.env.OLLAMA_URL;
  const model = process.env.CHAT_MODEL;
  if (!baseUrl) throw new Error("OLLAMA_URL is required");
  if (!model) throw new Error("CHAT_MODEL is required");

  const timeoutMs = getTimeoutMs();
  const maxRetries = getMaxRetries();

  const res = await fetchWithRetry(
    async () =>
      fetchWithTimeout(
        `${baseUrl}/api/generate`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ model, prompt, stream: false }),
        },
        timeoutMs,
      ),
    maxRetries,
  );

  if (!res.ok)
    throw new Error(
      `Ollama generate failed: ${res.status} ${await res.text()}`,
    );

  const json = OllamaGenerateResponse.parse(await res.json());
  return json.response;
}

export async function generateStructured(
  params: GenerateStructuredParams,
): Promise<string> {
  const baseUrl = process.env.OLLAMA_URL;
  const model = process.env.CHAT_MODEL;
  if (!baseUrl) throw new Error("OLLAMA_URL is required");
  if (!model) throw new Error("CHAT_MODEL is required");

  const temperature = params.temperature ?? 0;
  const timeoutMs = getTimeoutMs();
  const maxRetries = getMaxRetries();

  const res = await fetchWithRetry(
    async () =>
      fetchWithTimeout(
        `${baseUrl}/api/generate`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            model,
            prompt: params.prompt,
            system: params.system,
            format: params.format,
            stream: false,
            temperature,
          }),
        },
        timeoutMs,
      ),
    maxRetries,
  );

  if (!res.ok)
    throw new Error(
      `Ollama generate failed: ${res.status} ${await res.text()}`,
    );

  const json = OllamaGenerateResponse.parse(await res.json());
  return json.response;
}
