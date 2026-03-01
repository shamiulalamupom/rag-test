# RAG System

A production-ready Retrieval-Augmented Generation (RAG) system built with TypeScript, PostgreSQL + pgvector, and Ollama.

## Architecture

### Phase 1: Foundation & Grounding

- Strict JSON schema validation using Zod
- Chunk-based citations (chunk UUIDs)
- Automatic abstention when context is insufficient
- Prompt injection resistance via critical rules

### Phase 2: Idempotent Ingestion

- Content hash-based deduplication
- Incremental re-ingestion (change detection)
- Normalized collection grouping

### Phase 3: Structure-Aware Chunking

- Markdown-aware tokenization (respects headings)
- Byte-offset tracking (start/end)
- Heading path preservation for context

### Phase 4: Hybrid Retrieval + Fusion

Combines multiple retrieval strategies:

1. **Vector Search**: Semantic similarity via embeddings
   - Top K candidates: 40 (configurable: `RETRIEVE_VEC_K`)
   - Uses HNSW index for efficiency

2. **Full-Text Search**: Lexical matching
   - Top K candidates: 40 (configurable: `RETRIEVE_FTS_K`)
   - Supports websearch and plain queries
   - Generated column with GIN index

3. **Reciprocal Rank Fusion (RRF)**: Score Fusion
   - Formula: `rrf_score = sum(1 / (RRF_K + rank_i))`
   - Default RRF_K: 60
   - Merges duplicate chunks by UUID and accumulates contributions

4. **Diversity Control**: Prevents redundancy
   - Max chunks per page: 2 (configurable: `MAX_CHUNKS_PER_PAGE`)
   - Max chunks per heading: 2 (configurable: `MAX_CHUNKS_PER_HEADING`)
   - Applied after RRF fusion, before final ranking

Result: 8-12 high-quality, diverse chunks for context.

### Phase 5: Reranking for Precision

- **LLM-based Relevance Scoring**: Uses Ollama to score each chunk (0-10)
- **Temperature=0**: Deterministic scoring
- **Threshold-based Abstention**: Abstains early if top score < 4/10
- **Caching**: Rerank scores cached per (question_hash, chunk_hash)
- **Configurable**:
  - `RERANK_ENABLED=true` (disable with `false`)
  - `RERANK_CANDIDATES=50` (how many to rerank)
  - `RERANK_TOP_K=12` (final output count)
  - `RERANK_THRESHOLD=4` (min score to include)

### Phase 6: Context Formatting + Prompt Discipline

- Chunk UUIDs in context blocks
- Source metadata (document, page, chunk index)
- Heading paths for navigation
- Critical rules remain: answer only from context, cite only retrieved chunks

### Phase 7: Evaluation Harness

- 15+ sample questions (from test.md)
- Metrics:
  - **Retrieval**: hit@k (expected_contains in retrieved context)
  - **Generation**: JSON validity, citation grounding, abstain rate
  - **Latency**: Average time per question
- CLI: `npm run eval`
- Pass threshold: 80% across all metrics

### Phase 8: Performance + Ops Hardening

- **Timeouts**: Configurable Ollama timeout (default 60s, `OLLAMA_TIMEOUT_MS`)
- **Retries**: Exponential backoff on transient failures (max 2, `OLLAMA_RETRIES`)
- **Embedding Cache**: In-memory cache (normalized query string)
- **Reranker Cache**: (question_hash, chunk_hash) → score
- **Structured Logging**: DEBUG_RAG=true → stderr only (stdout reserved for JSON)
- **Concurrency**: Embedding batching (4-item groups)

## Quick Start

### Setup

1. **Start PostgreSQL + Ollama**:

   ```bash
   docker-compose up -d
   ```

2. **Initialize database**:

   ```bash
   npx tsx src/db/init.ts  # runs all migrations in db/init/*.sql
   ```

3. **Ingest sample data**:
   ```bash
   npx tsx src/cli_ingest.ts data/
   ```

### Query

```bash
# With debug output
DEBUG_RAG=true npx tsx src/cli_query.ts "What is the Constitution?"

# Clean JSON output only
npx tsx src/cli_query.ts "What is the Constitution?"
```

### Evaluate

```bash
npm run eval
```

Runs all 15+ questions, outputs:

- Retrieval metrics (hit rate)
- Generation metrics (JSON validity, citation coverage)
- Latency stats
- Pass/fail verdict

## Configuration

All settings have sensible defaults. Customize via `.env`:

```bash
# Retrieval
RETRIEVE_VEC_K=40           # Vector search candidates
RETRIEVE_FTS_K=40           # FTS candidates
RETRIEVE_FINAL_K=12         # Final chunks after fusion
RRF_K=60                    # RRF constant

# Diversity
MAX_CHUNKS_PER_PAGE=2       # Prevent page redundancy
MAX_CHUNKS_PER_HEADING=2    # Prevent heading redundancy

# Reranking
RERANK_ENABLED=true         # Enable/disable
RERANK_CANDIDATES=50        # Rerank pool size
RERANK_TOP_K=12             # Final after rerank
RERANK_THRESHOLD=4          # Min relevance (0-10)

# Performance
OLLAMA_TIMEOUT_MS=60000     # Timeout per request
OLLAMA_RETRIES=2            # Retry attempts

# Debugging
DEBUG_RAG=true              # Verbose stderr logging
```

See `.env.example` for full reference.

## How Hybrid Retrieval Works

Example query: "What is the preamble?"

1. **Vector Search**: Find 40 chunks semantically similar to query
   - Uses embedding similarity (cosine distance)
   - Fast via HNSW index

2. **FTS Search**: Find 40 chunks with matching keywords
   - Uses PostgreSQL tsvector + GIN index
   - Fallback: plainto_tsquery if websearch_to_tsquery fails

3. **RRF Fusion**: Merge by score
   - Vector chunk ranked #5 (1/(60+4) = 0.0143)
   - FTS chunk ranked #3 (1/(60+2) = 0.0158)
   - Same chunk in both? Scores add: 0.0143 + 0.0158 = 0.0301
   - Re-sort by merged score

4. **Diversity Control**: Remove redundancy
   - Keep best chunk per page
   - Keep best chunk per heading
   - Example: drops 2nd mention of "Part I > Articles" heading

5. **Final Ranking**: Top 12 chunks → context

## How Reranking Works

After hybrid retrieval yields 12-50 candidates:

1. **Score Each**: Ollama rates (question, chunk) relevance 0-10
   - Batched for efficiency
   - Temperature=0 (deterministic)
   - Cached per process

2. **Filter by Threshold**: Drop scores < 4
   - If all drop: abstain early ("insufficient evidence")

3. **Re-rank**: Sort by reranker score, take top 12

4. **Generate**: Use reranked chunks in prompt

**Why reranking?**

- Hybrid retrieval is recall-focused (broad candidate pool)
- Reranking is precision-focused (keep only truly relevant)
- Combo: Best of both worlds

**Disabling reranking:**

```bash
RERANK_ENABLED=false npx tsx src/cli_query.ts "question"
```

## Evaluation & Metrics

### Running Eval

```bash
npm run eval
```

Processes all questions in `eval/questions.jsonl`, outputs:

```
Running eval on 15 questions...
✓ q1: 450ms (hit=true, json=true, citations=true)
✓ q2: 380ms (hit=true, json=true, citations=true)
✗ q3: 520ms (hit=false, json=true, citations=true)
...

================== EVALUATION REPORT ==================

RETRIEVAL METRICS
├─ hit@: 93.3% (14/15)

GENERATION METRICS
├─ valid_json: 100.0% (15/15)
├─ valid_citations: 100.0% (15/15)
└─ abstain_rate: 0.0% (0/15)

PERFORMANCE
└─ avg_latency: 450ms

OVERALL: ✓ PASS
======================================================
```

### Adding Custom Questions

Edit `eval/questions.jsonl`. Format (JSONL, one per line):

```json
{
  "id": "my_q1",
  "question": "Your question here?",
  "expected_contains": ["keyword1", "keyword2"],
  "category": "optional_label"
}
```

- **expected_contains**: Strings that should appear in retrieved context (for hit@k metric)
- **category**: Optional label for grouping (literal, factual, interpretation, etc.)

### Metrics Explained

- **hit@**: % of questions where retrieved context contains `expected_contains`
- **valid_json**: % of answers that parse as valid JSON
- **valid_citations**: % of answers where citations reference retrieved chunks only
- **abstain_rate**: % of questions where model abstained (expected for OOD queries)
- **avg_latency**: Average ms per question (embed + retrieve + rerank + generate)

## Internals

### Database Schema

- **documents**: Source files (id, source, title)
- **pages**: Document splits (id, document_id, page_number, text, embedding)
- **chunks**: Fine-grained pieces (id, document_id, page_number, chunk_index, text, embedding, **tsv**, start_offset, end_offset, heading_path)

Indexes:

- `pages_embedding_hnsw_idx`: HNSW (vector similarity)
- `chunks_embedding_hnsw_idx`: HNSW (vector similarity)
- `chunks_tsv_gin_idx`: GIN (FTS)

### Key Modules

- `src/query/retrieve.ts`: Hybrid retrieval (vector + FTS + RRF + diversity)
- `src/query/rerank.ts`: LLM-based reranking
- `src/query/prompt.ts`: Context formatting
- `src/ollama/client.ts`: Ollama integration (embed, generate, structured with retries/timeouts)
- `src/cache/embeddings.ts`: Query embedding cache
- `src/cache/rerank.ts`: Rerank score cache
- `src/utils/logger.ts`: Structured logging (DEBUG_RAG aware)

### Logging

When `DEBUG_RAG=true`:

- Stderr receives phase timings, candidate counts, scores
- Stdout reserved for final JSON answer (clean)

When `DEBUG_RAG=false`:

- Stderr is silent
- Stdout is final JSON answer only

Example debug output:

```
Vector search: 40 candidates [retrieve_vec]
FTS search: 35 candidates [retrieve_fts]
RRF fusion: 75 candidates [retrieve_rrf] (rrf_k=60)
Hybrid retrieval done: 12 final chunks [retrieve_done] (retrieval_ms=320)
Reranking 12 candidates [rerank_start] (threshold=4)
Reranked to 10/12 chunks [rerank_done] (rerank_ms=1200)
```

## Guarantees

1. **Phase 1 Grounding**: All citations are chunk UUIDs from retrieved set. Always validated.
2. **Phase 2 Idempotency**: Re-ingesting same content does not duplicate or diverge.
3. **Phase 4 Diversity**: No more than 2 chunks from same page; no more than 2 from same heading.
4. **Phase 5 Precision**: Reranking filters to top-K relevant chunks; abstains if threshold not met.
5. **Phase 8 Robustness**: Timeouts prevent hangs; retries handle transients; caches avoid redundancy.

## Development

- TypeScript, strict mode
- Zod runtime validation
- No external vector DBs (PostgreSQL only)
- No paid APIs (Ollama local-first)
- Minimal dependencies

## License

ISC
