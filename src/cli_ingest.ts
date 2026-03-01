import "dotenv/config";
import { ingestTextDir } from "./ingest/ingestTextDir";
import { pool } from "./db/pool";

async function main(): Promise<void> {
  // Parse CLI arguments: dirPath, --prune, --collection <name>
  let dirPath = "data";
  let shouldPrune = false;
  let collectionOverride: string | undefined;

  const args = process.argv.slice(2);
  if (args.length > 0) {
    dirPath = args[0];
  }

  // Parse flags
  for (let i = 1; i < args.length; i++) {
    if (args[i] === "--prune") {
      shouldPrune = true;
    } else if (args[i] === "--collection" && i + 1 < args.length) {
      collectionOverride = args[i + 1];
      i++; // Skip next arg
    }
  }

  // Run ingestion
  const stats = await ingestTextDir(dirPath, collectionOverride, shouldPrune);

  // Display results
  const docs = await pool.query("SELECT COUNT(*)::int AS n FROM documents");
  const pages = await pool.query("SELECT COUNT(*)::int AS n FROM pages");
  const chunks = await pool.query("SELECT COUNT(*)::int AS n FROM chunks");
  const bangla = await pool.query(
    "SELECT COUNT(*)::int AS n FROM chunks WHERE text ILIKE '%Bangla%'",
  );

  console.log("");
  console.log("=== INGEST RESULTS ===");
  console.log(`Documents created:  ${stats.documentsCreated}`);
  console.log(`Documents updated:  ${stats.documentsUpdated}`);
  console.log(`Embeddings called:  ${stats.embeddingsCalled}`);
  console.log(`Documents pruned:   ${stats.documentsPruned}`);
  console.log("");
  console.log("=== FINAL COUNTS ===");
  console.log(
    `documents=${docs.rows[0].n} pages=${pages.rows[0].n} chunks=${chunks.rows[0].n} chunks_with_bangla=${bangla.rows[0].n}`,
  );

  await pool.end();
}

main().catch(async (err) => {
  console.error(err);
  try {
    await pool.end();
  } catch {}
  process.exit(1);
});
