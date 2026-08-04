import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { readConfig } from "../config.js";
import { createDb, exec, type Db } from "../db.js";
import { getFarmHelperSnapshot, type FarmHelperKeyMode, type FarmHelperView } from "../features/farm-helper.js";

// Exact-output guard for the Farm Helper. Dumps full snapshots for a fixed set
// of stored subjects across every keymode/view, so an optimization that is
// supposed to change only HOW the answer is computed can be proved not to
// change WHAT it answers.
//
//   npm run golden:farm-helper -- --out ./golden/before.json
//   ...make the change...
//   npm run golden:farm-helper -- --out ./golden/after.json --compare ./golden/before.json
//
// Read-only and osu!-free: subjects come from profile_snapshots, and the osu!
// client is a stub that throws, so an unstored subject fails loudly rather than
// making the comparison depend on live API data.
//
// `generatedAt` is stamped out of the dump (it is a clock read, not a result).
// Everything else - ids, ordering, benchmark pp, gains, reasons, peer counts,
// survival, feedback - is compared byte for byte.

interface Args {
  out: string | null;
  compare: string | null;
  subjects: number;
  limit: number;
  users: number[];
}

function parseArgs(argv: string[]): Args {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
  };
  const num = (flag: string, fallback: number): number => {
    const parsed = Number(get(flag));
    return Number.isFinite(parsed) ? parsed : fallback;
  };
  return {
    out: get("--out") ?? null,
    compare: get("--compare") ?? null,
    subjects: num("--subjects", 12),
    limit: num("--limit", 200),
    users: (get("--users") ?? "")
      .split(",")
      .map((raw) => Number(raw.trim()))
      .filter((id) => Number.isSafeInteger(id) && id > 0),
  };
}

const NO_OSU = new Proxy({}, {
  get: (_target, prop) => () => {
    throw new Error(`farm-helper golden: unexpected osu! call (${String(prop)}) - subject is not stored`);
  },
}) as never;

const KEY_MODES: FarmHelperKeyMode[] = ["any", "4k", "7k"];
const VIEWS: FarmHelperView[] = ["gain", "popular"];

// Deterministic: the top-pp stored players, so before/after runs cover the
// same subjects without needing a checked-in id list.
async function selectSubjects(db: Db, count: number): Promise<number[]> {
  const rows = (await exec(
    db,
    `select u.user_id from users u
     join profile_snapshots p on p.user_id = u.user_id and length(p.best_scores_json) > 100
     where u.is_active = 1 and u.pp > 2000
     order by u.pp desc, u.user_id asc limit ?`,
    [count],
  )).rows;
  return rows.map((row) => Number(row.user_id));
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const db = await createDb(readConfig());
  const subjects = args.users.length > 0 ? args.users : await selectSubjects(db, args.subjects);
  if (subjects.length === 0) {
    console.error("no stored subjects found (is this a synced production database?)");
    process.exitCode = 1;
    return;
  }

  const dump: Record<string, unknown> = {};
  for (const userId of subjects) {
    for (const keyMode of KEY_MODES) {
      for (const view of VIEWS) {
        const key = `${userId}:${keyMode}:${view}`;
        try {
          const snapshot = await getFarmHelperSnapshot(db, NO_OSU, String(userId), { keyMode, view, limit: args.limit });
          dump[key] = { ...snapshot, generatedAt: "<stamped>" };
        } catch (error) {
          dump[key] = { error: error instanceof Error ? error.message : String(error) };
        }
      }
    }
  }
  const recs = Object.values(dump).reduce<number>((sum, snap) => sum + ((snap as { recs?: unknown[] }).recs?.length ?? 0), 0);
  console.log(`${Object.keys(dump).length} snapshots, ${recs} recommendations, ${subjects.length} subjects`);

  if (args.out) {
    const slash = args.out.lastIndexOf("/");
    if (slash > 0) mkdirSync(args.out.slice(0, slash), { recursive: true });
    writeFileSync(args.out, JSON.stringify(dump, null, 1));
    console.log(`wrote ${args.out}`);
  }

  if (args.compare) {
    const other = JSON.parse(readFileSync(args.compare, "utf8")) as Record<string, unknown>;
    const keys = [...new Set([...Object.keys(other), ...Object.keys(dump)])].sort();
    let differing = 0;
    for (const key of keys) {
      const before = JSON.stringify(other[key]);
      const after = JSON.stringify(dump[key]);
      if (before === after) continue;
      differing += 1;
      if (differing <= 5) console.log(`DIFF ${key}\n  before: ${before?.slice(0, 400)}\n  after : ${after?.slice(0, 400)}`);
    }
    if (differing === 0) {
      console.log(`identical to ${args.compare} across ${keys.length} snapshots`);
    } else {
      console.error(`${differing}/${keys.length} snapshots differ from ${args.compare}`);
      process.exitCode = 1;
    }
  }
}

main().then(
  () => process.exit(process.exitCode ?? 0),
  (error) => {
    console.error(error);
    process.exit(1);
  },
);
