import { readdir, readFile } from "node:fs/promises";
import { join, extname, basename } from "node:path";
import { pool } from "../db/pool";
import { embed } from "../ollama/client";
import { chunkPageToChunks, CHUNKER_VERSION } from "./chunking";
import { toPgVectorLiteral } from "../db/vector";
import { hashContent, normalizeCollection } from "./hash";

function splitIntoPages(text: string): string[] {
  const parts = text
    .split(/\n\s*---\s*\n/g)
    .map((x) => x.trim())
    .filter(Boolean);
  return parts.length ? parts : [text.trim()];
}

export interface IngestStats {
  documentsCreated: number;
  documentsUpdated: number;
  embeddingsCalled: number;
  documentsPruned: number;
}

export async function ingestTextDir(
  dirPath: string,
  collection?: string,
  shouldPrune?: boolean,
): Promise<IngestStats> {
  // Determine collection name
  const finalCollection = collection ?? normalizeCollection(dirPath);

  // Discover all .md and .txt files in directory
  const files = await readdir(dirPath);
  const targets = files.filter((f) => {
    const e = extname(f).toLowerCase();
    return e === ".md" || e === ".txt";
  });

  // Map targets to full source paths
  const discoveredSources = targets.map((f) => join(dirPath, f));

  let embeddingsCalled = 0;
  let documentsCreated = 0;
  let documentsUpdated = 0;

  // Process each file
  for (const file of targets) {
    const full = join(dirPath, file);
    const raw = await readFile(full, "utf8");
    const title = basename(file);
    const docHash = hashContent(raw);

    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      // Check if document exists
      const existingDocRes = await client.query(
        "SELECT id, content_hash FROM documents WHERE collection = $1 AND source = $2",
        [finalCollection, full],
      );

      let documentId: string;
      let isNewDocument = false;

      if (existingDocRes.rows.length > 0) {
        documentId = existingDocRes.rows[0].id;
        const existingHash = existingDocRes.rows[0].content_hash;

        // If document hash unchanged, short-circuit
        if (existingHash === docHash) {
          console.log(`[INGEST] Skipped (unchanged): ${title}`);
          await client.query("COMMIT");
          continue;
        }

        // Document hash changed, mark as updated
        documentsUpdated++;
      } else {
        // New document
        const docRes = await client.query(
          "INSERT INTO documents (collection, source, title, content_hash, updated_at) VALUES ($1, $2, $3, $4, now()) RETURNING id",
          [finalCollection, full, title, docHash],
        );
        documentId = docRes.rows[0].id;
        documentsCreated++;
        isNewDocument = true;
      }

      // Update document hash and timestamp if existing document changed
      if (!isNewDocument) {
        await client.query(
          "UPDATE documents SET content_hash = $1, updated_at = now() WHERE id = $2",
          [docHash, documentId],
        );
      }

      // Split into pages
      const pages = splitIntoPages(raw);
      const processedPageNumbers = new Set<number>();

      // Process each page
      for (let p = 0; p < pages.length; p++) {
        const pageNumber = p + 1;
        const pageText = pages[p];
        const pageHash = hashContent(pageText);
        processedPageNumbers.add(pageNumber);

        // Check if page exists and unchanged
        const existingPageRes = await client.query(
          "SELECT id, content_hash FROM pages WHERE document_id = $1 AND page_number = $2",
          [documentId, pageNumber],
        );

        let pageChanged = true;
        if (existingPageRes.rows.length > 0) {
          const existingPageHash = existingPageRes.rows[0].content_hash;
          if (existingPageHash === pageHash) {
            // Also check if chunker version matches
            const existingChunkerRes = await client.query(
              "SELECT chunker_version FROM chunks WHERE document_id = $1 AND page_number = $2 LIMIT 1",
              [documentId, pageNumber],
            );

            // If chunker_version is missing or doesn't match, rebuild chunks
            if (
              existingChunkerRes.rows.length === 0 ||
              existingChunkerRes.rows[0]?.chunker_version !== CHUNKER_VERSION
            ) {
              // Chunker version mismatch → rebuild even though hash matches
              pageChanged = true;
            } else {
              // Both hash and chunker version match → skip
              pageChanged = false;
            }
          }
        }

        if (!pageChanged) {
          continue;
        }

        // Page is new or changed: embed it
        const pageVec = await embed(pageText);
        embeddingsCalled++;
        const pageVecLit = toPgVectorLiteral(pageVec);

        // UPSERT page
        await client.query(
          `INSERT INTO pages (document_id, page_number, text, embedding, content_hash, updated_at)
           VALUES ($1, $2, $3, $4::vector, $5, now())
           ON CONFLICT (document_id, page_number) DO UPDATE
           SET text = $3, embedding = $4::vector, content_hash = $5, updated_at = now()`,
          [documentId, pageNumber, pageText, pageVecLit, pageHash],
        );

        // Delete existing chunks for this page (rebuild from scratch)
        await client.query(
          "DELETE FROM chunks WHERE document_id = $1 AND page_number = $2",
          [documentId, pageNumber],
        );

        // Process chunks for this page using structure-aware chunker
        const structuredChunks = chunkPageToChunks(pageText);
        for (let c = 0; c < structuredChunks.length; c++) {
          const chunk = structuredChunks[c];
          const chunkStr = chunk.text;
          const chunkHash = hashContent(chunkStr);

          // Embed chunk
          const chunkVec = await embed(chunkStr);
          embeddingsCalled++;
          const chunkVecLit = toPgVectorLiteral(chunkVec);

          // Insert chunk with Phase 3 fields
          await client.query(
            `INSERT INTO chunks (
              document_id, page_number, chunk_index, text, embedding,
              content_hash, start_offset, end_offset, heading_path, chunker_version, updated_at
            ) VALUES ($1, $2, $3, $4, $5::vector, $6, $7, $8, $9, $10, now())`,
            [
              documentId,
              pageNumber,
              c,  // chunk_index (0-based in Phase 3, was 1-based in Phase 2)
              chunkStr,
              chunkVecLit,
              chunkHash,
              chunk.startOffset,
              chunk.endOffset,
              chunk.headingPath,
              CHUNKER_VERSION,
            ],
          );
        }
      }

      // Delete pages that no longer exist (page count shrunk)
      if (pages.length > 0) {
        await client.query(
          "DELETE FROM pages WHERE document_id = $1 AND page_number > $2",
          [documentId, pages.length],
        );
      }

      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  }

  // Prune orphaned documents (only if --prune flag is set)
  let documentsPruned = 0;
  if (shouldPrune) {
    documentsPruned = await pruneOrphanedDocuments(
      finalCollection,
      discoveredSources,
    );
  }

  return {
    documentsCreated,
    documentsUpdated,
    embeddingsCalled,
    documentsPruned,
  };
}

async function pruneOrphanedDocuments(
  collection: string,
  discoveredSources: string[],
): Promise<number> {
  const sourceSet = new Set(discoveredSources);
  const allDocsRes = await pool.query(
    "SELECT id, source FROM documents WHERE collection = $1",
    [collection],
  );

  let prunedCount = 0;
  for (const doc of allDocsRes.rows) {
    if (!sourceSet.has(doc.source)) {
      await pool.query("DELETE FROM documents WHERE id = $1", [doc.id]);
      prunedCount++;
      console.log(`[INGEST] Pruned: ${doc.source}`);
    }
  }

  return prunedCount;
}
