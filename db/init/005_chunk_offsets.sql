-- Phase 3: Structure-Aware Chunking with Offsets and Versioning
-- Adds traceable byte offsets, heading paths, and chunker versioning to chunks

-- Add start_offset: character offset (inclusive) into original page text
ALTER TABLE chunks
ADD COLUMN IF NOT EXISTS start_offset INT NOT NULL DEFAULT 0;

-- Add end_offset: character offset (exclusive) into original page text
ALTER TABLE chunks
ADD COLUMN IF NOT EXISTS end_offset INT NOT NULL DEFAULT 0;

-- Add heading_path: breadcrumb trail of headings (e.g., "Title > Section > Subsection")
ALTER TABLE chunks
ADD COLUMN IF NOT EXISTS heading_path TEXT NOT NULL DEFAULT '';

-- Add chunker_version: tracks which chunking algorithm produced this chunk
-- Allows forced rebuilds when chunking algorithm changes
ALTER TABLE chunks
ADD COLUMN IF NOT EXISTS chunker_version TEXT NOT NULL DEFAULT 'md_v1';
