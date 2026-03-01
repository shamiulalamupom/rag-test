ALTER TABLE pages
  ALTER COLUMN embedding TYPE VECTOR(1536);

ALTER TABLE chunks
  ALTER COLUMN embedding TYPE VECTOR(1536);

DROP INDEX IF EXISTS pages_embedding_hnsw_idx;
DROP INDEX IF EXISTS chunks_embedding_hnsw_idx;

CREATE INDEX pages_embedding_hnsw_idx
  ON pages USING hnsw (embedding vector_cosine_ops);

CREATE INDEX chunks_embedding_hnsw_idx
  ON chunks USING hnsw (embedding vector_cosine_ops);