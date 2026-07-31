import { readConfig } from "../config.js";
import { createDb, migrate } from "../db.js";
import { compactMapsFarmedOverlay } from "./maps-farmed-compaction.js";

interface CompactOptions {
  batchSize: number;
  vacuum: boolean;
}

const options = readOptions(process.argv.slice(2));
const db = await createDb(readConfig());

await migrate(db);
const result = await compactMapsFarmedOverlay(db, options.batchSize);
console.log(`Compacted ${result.compacted} country_maps_farmed_scores rows (${result.failed} failed, ${result.scanned} scanned).`);

if (options.vacuum) {
  console.log("Running VACUUM. Keep the backend stopped until this finishes.");
  await db.execute("vacuum");
  console.log("VACUUM finished.");
}

db.close();

function readOptions(args: string[]): CompactOptions {
  const batchArg = args.find((arg) => arg.startsWith("--batch-size="));
  const batchSize = Math.max(1, Math.min(5_000, Number(batchArg?.slice("--batch-size=".length) ?? 500)));
  return {
    batchSize: Number.isFinite(batchSize) ? batchSize : 500,
    vacuum: args.includes("--vacuum"),
  };
}
