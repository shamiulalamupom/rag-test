import { pool } from "../db/pool";
import { embed } from "../ollama/client";
import { toPgVectorLiteral } from "../db/vector";
import { logger } from "../utils/logger";

export type RetrievedPage = {
  documentId: string;
  pageNumber: number;
  pageId: string;
  text: string;
  score: number;
};

export type RetrievedChunk = {
  documentId: string;
  pageNumber: number;
  chunkId: string;
  chunkIndex: number;
  text: string;
  score: number;
  startOffset?: number;
  endOffset?: number;
  headingPath?: string;
};

export interface HybridRetrievalOptions {
  vectorK?: number;
  ftsK?: number;
  finalK?: number;
  rrf_k?: number;
  maxPerPage?: number;
  maxPerHeading?: number;
}

export async function retrievePages(
  query: string,
  topN: number,
): Promise<RetrievedPage[]> {
  const qVec = await embed(query);
  const qLit = toPgVectorLiteral(qVec);

  const res = await pool.query(
    `
    SELECT
      p.id AS page_id,
      p.document_id,
      p.page_number,
      p.text,
      1 - (p.embedding <=> $1::vector) AS score
    FROM pages p
    WHERE p.embedding IS NOT NULL
    ORDER BY p.embedding <=> $1::vector
    LIMIT $2
    `,
    [qLit, topN],
  );

  return res.rows.map((r) => ({
    pageId: r.page_id,
    documentId: r.document_id,
    pageNumber: r.page_number,
    text: r.text,
    score: Number(r.score),
  }));
}

export async function retrieveChunksWithinPages(
  query: string,
  pages: { documentId: string; pageNumber: number }[],
  topK: number,
): Promise<RetrievedChunk[]> {
  if (pages.length === 0) return [];

  const qVec = await embed(query);
  const qLit = toPgVectorLiteral(qVec);

  const res = await pool.query(
    `
    WITH selected(document_id, page_number) AS (
      SELECT * FROM unnest($2::uuid[], $3::int[])
    )
    SELECT
      c.id AS chunk_id,
      c.document_id,
      c.page_number,
      c.chunk_index,
      c.text,
      1 - (c.embedding <=> $1::vector) AS score,
      c.start_offset,
      c.end_offset,
      c.heading_path
    FROM chunks c
    JOIN selected s
      ON c.document_id = s.document_id
     AND c.page_number = s.page_number
    WHERE c.embedding IS NOT NULL
    ORDER BY c.embedding <=> $1::vector
    LIMIT $4
    `,
    [
      qLit,
      pages.map((p) => p.documentId),
      pages.map((p) => p.pageNumber),
      topK,
    ],
  );

  return res.rows.map((r) => ({
    chunkId: r.chunk_id,
    documentId: r.document_id,
    pageNumber: r.page_number,
    chunkIndex: r.chunk_index,
    text: r.text,
    score: Number(r.score),
    startOffset: r.start_offset ? Number(r.start_offset) : undefined,
    endOffset: r.end_offset ? Number(r.end_offset) : undefined,
    headingPath: r.heading_path || undefined,
  }));
}

async function vectorChunks(
  embedding: number[],
  topK: number,
): Promise<RetrievedChunk[]> {
  const qLit = toPgVectorLiteral(embedding);

  const res = await pool.query(
    `
    SELECT
      c.id AS chunk_id,
      c.document_id,
      c.page_number,
      c.chunk_index,
      c.text,
      1 - (c.embedding <=> $1::vector) AS score,
      c.start_offset,
      c.end_offset,
      c.heading_path
    FROM chunks c
    WHERE c.embedding IS NOT NULL
    ORDER BY c.embedding <=> $1::vector
    LIMIT $2
    `,
    [qLit, topK],
  );

  return res.rows.map((r) => ({
    chunkId: r.chunk_id,
    documentId: r.document_id,
    pageNumber: r.page_number,
    chunkIndex: r.chunk_index,
    text: r.text,
    score: Number(r.score),
    startOffset: r.start_offset ? Number(r.start_offset) : undefined,
    endOffset: r.end_offset ? Number(r.end_offset) : undefined,
    headingPath: r.heading_path || undefined,
  }));
}

async function ftsChunks(
  query: string,
  topK: number,
): Promise<RetrievedChunk[]> {
  const res = await pool.query(
    `
    SELECT
      c.id AS chunk_id,
      c.document_id,
      c.page_number,
      c.chunk_index,
      c.text,
      ts_rank_cd(c.tsv, websearch_to_tsquery('simple', $1), 32) AS score,
      c.start_offset,
      c.end_offset,
      c.heading_path
    FROM chunks c
    WHERE c.tsv @@ websearch_to_tsquery('simple', $1)
    ORDER BY score DESC
    LIMIT $2
    `,
    [query, topK],
  );

  if (res.rows.length === 0) {
    const res2 = await pool.query(
      `
      SELECT
        c.id AS chunk_id,
        c.document_id,
        c.page_number,
        c.chunk_index,
        c.text,
        ts_rank_cd(c.tsv, plainto_tsquery('simple', $1), 32) AS score,
        c.start_offset,
        c.end_offset,
        c.heading_path
      FROM chunks c
      WHERE c.tsv @@ plainto_tsquery('simple', $1)
      ORDER BY score DESC
      LIMIT $2
      `,
      [query, topK],
    );
    return res2.rows.map((r) => ({
      chunkId: r.chunk_id,
      documentId: r.document_id,
      pageNumber: r.page_number,
      chunkIndex: r.chunk_index,
      text: r.text,
      score: Number(r.score),
      startOffset: r.start_offset ? Number(r.start_offset) : undefined,
      endOffset: r.end_offset ? Number(r.end_offset) : undefined,
      headingPath: r.heading_path || undefined,
    }));
  }

  return res.rows.map((r) => ({
    chunkId: r.chunk_id,
    documentId: r.document_id,
    pageNumber: r.page_number,
    chunkIndex: r.chunk_index,
    text: r.text,
    score: Number(r.score),
    startOffset: r.start_offset ? Number(r.start_offset) : undefined,
    endOffset: r.end_offset ? Number(r.end_offset) : undefined,
    headingPath: r.heading_path || undefined,
  }));
}

function reciprocalRankFusion(
  sources: RetrievedChunk[][],
  rrf_k: number,
): RetrievedChunk[] {
  const scores = new Map<
    string,
    { chunk: RetrievedChunk; rrf_score: number }
  >();

  for (const source of sources) {
    for (let rank = 0; rank < source.length; rank++) {
      const chunk = source[rank];
      const rrf = 1 / (rrf_k + rank);

      if (scores.has(chunk.chunkId)) {
        const existing = scores.get(chunk.chunkId)!;
        existing.rrf_score += rrf;
      } else {
        scores.set(chunk.chunkId, {
          chunk,
          rrf_score: rrf,
        });
      }
    }
  }

  return Array.from(scores.values())
    .map((entry) => ({
      ...entry.chunk,
      score: entry.rrf_score,
    }))
    .sort((a, b) => b.score - a.score);
}

function applyDiversityControl(
  chunks: RetrievedChunk[],
  maxPerPage: number,
  maxPerHeading: number,
): RetrievedChunk[] {
  const pageCount = new Map<string, number>();
  const headingCount = new Map<string, number>();
  const result: RetrievedChunk[] = [];

  for (const chunk of chunks) {
    const pageKey = `${chunk.documentId}:${chunk.pageNumber}`;
    const headingKey = chunk.headingPath || "__no_heading__";

    const pageCnt = pageCount.get(pageKey) ?? 0;
    const headingCnt = headingCount.get(headingKey) ?? 0;

    if (pageCnt < maxPerPage && headingCnt < maxPerHeading) {
      result.push(chunk);
      pageCount.set(pageKey, pageCnt + 1);
      headingCount.set(headingKey, headingCnt + 1);
    }
  }

  return result;
}

export async function retrieveChunksHybrid(
  question: string,
  opts?: HybridRetrievalOptions,
): Promise<RetrievedChunk[]> {
  const vectorK = opts?.vectorK ?? Number(process.env.RETRIEVE_VEC_K ?? "40");
  const ftsK = opts?.ftsK ?? Number(process.env.RETRIEVE_FTS_K ?? "40");
  const finalK = opts?.finalK ?? Number(process.env.RETRIEVE_FINAL_K ?? "12");
  const rrf_k = opts?.rrf_k ?? Number(process.env.RRF_K ?? "60");
  const maxPerPage =
    opts?.maxPerPage ?? Number(process.env.MAX_CHUNKS_PER_PAGE ?? "2");
  const maxPerHeading =
    opts?.maxPerHeading ?? Number(process.env.MAX_CHUNKS_PER_HEADING ?? "2");

  const startTime = Date.now();

  const embedding = await embed(question);

  const vecChunks = await vectorChunks(embedding, vectorK);
  logger.debug(`Vector search: ${vecChunks.length} candidates`, {
    phase: "retrieve_vec",
    counts: { candidates: vecChunks.length },
  });

  const ftsChunksList = await ftsChunks(question, ftsK);
  logger.debug(`FTS search: ${ftsChunksList.length} candidates`, {
    phase: "retrieve_fts",
    counts: { candidates: ftsChunksList.length },
  });

  const fused = reciprocalRankFusion([vecChunks, ftsChunksList], rrf_k);
  logger.debug(`RRF fusion: ${fused.length} candidates`, {
    phase: "retrieve_rrf",
    counts: { candidates: fused.length, rrf_k },
  });

  const diversified = applyDiversityControl(fused, maxPerPage, maxPerHeading);
  const final = diversified.slice(0, finalK);

  const elapsed = Date.now() - startTime;
  logger.debug(
    `Hybrid retrieval done: ${final.length} final chunks from ${vecChunks.length} vec + ${ftsChunksList.length} fts`,
    {
      phase: "retrieve_done",
      timings: { retrieval_ms: elapsed },
      counts: {
        final: final.length,
        vec: vecChunks.length,
        fts: ftsChunksList.length,
      },
    },
  );

  return final;
}
