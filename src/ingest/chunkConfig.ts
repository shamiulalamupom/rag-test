/**
 * Chunk configuration with environment overrides.
 * Controls token-based budgeting for the Markdown chunker.
 */

export const CHUNK_CONFIG = {
  /**
   * Maximum tokens per chunk (default: 450).
   * Configurable via CHUNK_MAX_TOKENS env var.
   * Tokens estimated as: Math.ceil(text.length / 4)
   */
  maxTokens: Number(process.env.CHUNK_MAX_TOKENS ?? "450"),

  /**
   * Target overlap tokens between consecutive chunks (default: 60).
   * Configurable via CHUNK_OVERLAP_TOKENS env var.
   * Overlap is applied by whole blocks only (never splits blocks mid-way).
   */
  overlapTokens: Number(process.env.CHUNK_OVERLAP_TOKENS ?? "60"),
};
