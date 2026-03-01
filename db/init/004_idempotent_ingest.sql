-- Phase 2: Idempotent Incremental Ingestion
-- Adds content hashing, update tracking, and collection management

-- Add collection column for documents (for grouping by ingest run)
ALTER TABLE documents
ADD COLUMN IF NOT EXISTS collection TEXT NOT NULL DEFAULT 'default';

-- Add content_hash column for documents (for detecting unchanged files)
ALTER TABLE documents
ADD COLUMN IF NOT EXISTS content_hash TEXT NOT NULL DEFAULT '';

-- Add updated_at column for documents (for tracking last update)
ALTER TABLE documents
ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

-- Add content_hash column for pages (for detecting unchanged pages)
ALTER TABLE pages
ADD COLUMN IF NOT EXISTS content_hash TEXT NOT NULL DEFAULT '';

-- Add updated_at column for pages (for tracking last update)
ALTER TABLE pages
ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

-- Add content_hash column for chunks (for detecting unchanged chunks)
ALTER TABLE chunks
ADD COLUMN IF NOT EXISTS content_hash TEXT NOT NULL DEFAULT '';

-- Add updated_at column for chunks (for tracking last update)
ALTER TABLE chunks
ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

-- Add unique constraint: (collection, source) to allow same filename in different collections
-- First drop old unique constraint on source if it exists
ALTER TABLE documents
DROP CONSTRAINT IF EXISTS documents_source_key;

-- Add new composite unique constraint
ALTER TABLE documents
ADD CONSTRAINT documents_collection_source_key UNIQUE (collection, source);
