import { createHash } from "node:crypto";

/**
 * Compute SHA256 hash of text content.
 * Normalizes line endings (\r\n → \n) for consistent hashing across platforms.
 */
export function hashContent(text: string): string {
  const normalized = text.replace(/\r\n/g, "\n");
  return createHash("sha256").update(normalized, "utf8").digest("hex");
}

/**
 * Normalize directory path to a collection name.
 * Examples:
 *   "./data" → "data"
 *   "/absolute/path/to/documents" → "documents"
 *   "data" → "data"
 *   "" → "default"
 */
export function normalizeCollection(dirPath: string): string {
  // Remove leading "./"
  const cleaned = dirPath.replace(/^\.\//, "");
  // Split by path separators and get the last segment
  const segments = cleaned.split(/[/\\]/);
  const last = segments[segments.length - 1]?.trim();
  return last || "default";
}
