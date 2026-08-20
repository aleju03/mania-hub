/* The maintained half of the /packs/collections economy read.
 *
 * pack_collection_cards is millions of rows, and the two questions the
 * community page asks of it - what does each collector hold, and how many
 * collectors hold each card - are both full scans (measured at 3.6s and 5.9s
 * against production, plus a tier scan and a serials scan on top). Local libsql
 * runs every query synchronously on the calling thread, so paying that on a
 * timer meant the whole backend stopped for it.
 *
 * Nothing about those answers actually changes except where somebody pulled or
 * recycled a card. So the counts are kept in pack_community_*_stats, triggers
 * on the ownership table record which collector and which card a write touched,
 * and the reconciler recomputes only those, owner-scoped and card-scoped, off
 * the indexes that already exist. The page then reads a couple of thousand
 * summary rows.
 *
 * These tables are a cache with a durable home: every column is derivable from
 * pack_collection_cards, and losing them costs a rebuild, not data. That is
 * what makes the safety valves cheap - a generation mismatch, a missing
 * trigger, or a table that was never initialized all just send the page back to
 * the scans it used to do.
 */
import { exec, execBatch, type Db } from "../db.js";
import { errorContext, logInfo, logWarn } from "../logger.js";
import { HONORARY_USER_IDS } from "./pack-wallets.js";

const ROLLUP_META_KEY = "pack_community_rollups";

/* Bump when the meaning of any stored column changes (a different filter, a
   different definition of a duplicate). A mismatch rebuilds from scratch rather
   than serving numbers computed under the old rules. */
const ROLLUP_SCHEMA_VERSION = 1;

const DIRTY_TRIGGERS = ["pack_community_dirty_ins", "pack_community_dirty_upd", "pack_community_dirty_del"];

/* Ids inlined rather than bound, the way pack-community.ts does it: the roster
   is a code constant of validated integers, and the list is reused in every
   recompute. */
const HONORARY_ID_LIST = [...HONORARY_USER_IDS]
  .filter((id) => Number.isInteger(id) && id > 0)
  .sort((a, b) => a - b)
  .join(",") || "-1";

/* A collector's GOAT count is measured against the honorary roster, which is a
   hand-edited code constant rather than anything in the database. Editing it
   silently changes what every stored row should say, so it is part of the
   generation: adding a player to the roster rebuilds the table instead of
   leaving every collector who is not pulling cards on their old count. */
function honoraryFingerprint(): string {
  let hash = 0;
  for (const char of HONORARY_ID_LIST) hash = (Math.imul(hash, 31) + char.charCodeAt(0)) | 0;
  return (hash >>> 0).toString(36);
}

function rollupGeneration(): string {
  return `v${ROLLUP_SCHEMA_VERSION}-h${honoraryFingerprint()}`;
}

export interface PackCommunityOwnerRollup {
  ownerUserId: number;
  cards: number;
  players: number;
  copies: number;
  duplicates: number;
  recycled: number;
  goats: number;
  joinedAt: number;
  lastPulledAt: number;
}

export interface PackCommunityCardRollup {
  cardUserId: number;
  owners: number;
  copies: number;
}

export interface PackCommunityRollupState {
  generation: string | null;
  initializedAt: number | null;
  reconciledAt: number | null;
}

export interface PackCommunityRollupResult {
  ready: boolean;
  /* Why the roll-up is not usable, when it is not. Null on success. */
  blocked: "no_triggers" | "no_tables" | null;
  rebuilt: boolean;
  owners: number;
  cards: number;
  /* Dirty rows still queued when the pass gave up its budget. Above zero means
     the next read is slightly behind, never wrong for the rows it did do. */
  backlog: number;
  durationMs: number;
}

/* Recompute batches, sized by how long they take rather than by how many rows
 * they carry.
 *
 * A batch is one write transaction, so its length is how long the reconciler
 * holds the single SQLite writer against score ingest. What one costs depends
 * on who is in it: measured against production, 250 of the lightest collectors
 * recompute in 9ms and the 250 heaviest in 1.68s, because the work is per owned
 * row and the biggest shelves carry thousands of them. A fixed row count
 * therefore bounds nothing that matters, and one tuned on a dev machine would
 * be the wrong number on the VPS anyway.
 *
 * So the size follows the clock: a batch that overshoots the target halves the
 * next one, one that comes in well under it doubles, inside [BATCH_MIN, max].
 * An ordinary pull dirties a single collector and never approaches the ceiling;
 * a bulk grant or an import that dirties thousands settles wherever this
 * machine can finish a transaction in a quarter of a second.
 *
 * Short transactions are not on their own enough, because SQLite does not queue
 * writers fairly: a process that opens its next transaction the instant it
 * commits the last keeps winning the lock, and the loser's busy handler backs
 * off into longer and longer sleeps. Draining the 250 heaviest collectors
 * against the production database in ~170ms batches, back to back, still stalled
 * a competing writer for 1.53s. So a batch is followed by a pause as long as
 * itself: half the writer's time goes to whoever else wants it, and the same
 * drain then held that writer up for 229ms, one batch, instead. */
const BATCH_TARGET_MS = 250;
const BATCH_MIN = 10;
const OWNER_BATCH_MAX = 250;
const CARD_BATCH_MAX = 400;
/* Where a fresh process starts, before it has timed anything. Low, because the
   first batch is the one nothing has had the chance to correct yet, and it
   climbs in two doublings if the rows turn out to be cheap. */
let ownerBatch = 25;
let cardBatch = 100;

/* Grow only on a batch that was full: a short partial batch says nothing about
   what a full one would cost. Shrink on any overshoot, partial included. */
function nextBatchSize(current: number, elapsedMs: number, full: boolean, max: number): number {
  if (elapsedMs > BATCH_TARGET_MS) return Math.max(BATCH_MIN, Math.floor(current / 2));
  if (full && elapsedMs * 3 < BATCH_TARGET_MS) return Math.min(max, current * 2);
  return current;
}

/* The gap left between batches for anyone else waiting on the writer, as long
   as the batch that just ran and never longer than the target. */
function standAside(lastBatchMs: number): Promise<void> {
  const pause = Math.min(BATCH_TARGET_MS, Math.max(5, lastBatchMs));
  return new Promise((resolve) => setTimeout(resolve, pause));
}

/* The rebuild's inserts are plain writes with no scan behind them, so they are
   grouped for round-trip efficiency rather than for lock time. */
const REBUILD_WRITE_BATCH = 500;
/* How long one reconcile pass may spend draining before it hands back and lets
   the page build off what it has. The backlog survives in the dirty tables. */
const RECONCILE_BUDGET_MS = 20_000;

async function tablesExist(db: Db): Promise<boolean> {
  const rows = (await exec(
    db,
    `select name from sqlite_master where type = 'table' and name in
       ('pack_community_owner_stats', 'pack_community_owner_tier_stats',
        'pack_community_card_stats', 'pack_community_dirty_owners', 'pack_community_dirty_cards')`,
  )).rows;
  return rows.length === 5;
}

async function triggersExist(db: Db): Promise<boolean> {
  const rows = (await exec(
    db,
    `select name from sqlite_master where type = 'trigger' and name in (${DIRTY_TRIGGERS.map(() => "?").join(",")})`,
    DIRTY_TRIGGERS,
  )).rows;
  return rows.length === DIRTY_TRIGGERS.length;
}

/* Marking a row dirty, as a statement that cannot fail.
 *
 * `insert or ignore` is the obvious way to write this and it is the wrong one.
 * SQLite lets the statement that fired a trigger override the conflict policy
 * inside the trigger body, and the pack draw writes its ownership rows with an
 * upsert (`on conflict(owner_user_id, card_key) do update`). Under that, the
 * trigger's `or ignore` became `or abort`, and since one pack deals several
 * cards to the same collector, the second card aborted the draw:
 * "UNIQUE constraint failed: pack_community_dirty_owners.owner_user_id" out of
 * POST /api/packs/draw. Bookkeeping for a community page must not be able to
 * refuse somebody their cards, so no conflict is raised in the first place. */
function markDirtySql(table: string, column: string, value: string): string {
  return `insert into ${table}(${column})
      select ${value} where not exists (select 1 from ${table} where ${column} = ${value});`;
}

const DIRTY_TRIGGER_SQL: Record<string, string> = {
  pack_community_dirty_ins: `
    create trigger pack_community_dirty_ins
    after insert on pack_collection_cards begin
      ${markDirtySql("pack_community_dirty_owners", "owner_user_id", "new.owner_user_id")}
      ${markDirtySql("pack_community_dirty_cards", "card_user_id", "new.card_user_id")}
    end`,
  pack_community_dirty_upd: `
    create trigger pack_community_dirty_upd
    after update on pack_collection_cards begin
      ${markDirtySql("pack_community_dirty_owners", "owner_user_id", "new.owner_user_id")}
      ${markDirtySql("pack_community_dirty_owners", "owner_user_id", "old.owner_user_id")}
      ${markDirtySql("pack_community_dirty_cards", "card_user_id", "new.card_user_id")}
      ${markDirtySql("pack_community_dirty_cards", "card_user_id", "old.card_user_id")}
    end`,
  pack_community_dirty_del: `
    create trigger pack_community_dirty_del
    after delete on pack_collection_cards begin
      ${markDirtySql("pack_community_dirty_owners", "owner_user_id", "old.owner_user_id")}
      ${markDirtySql("pack_community_dirty_cards", "card_user_id", "old.card_user_id")}
    end`,
};

/* The triggers that make the roll-up maintainable: every write to an ownership
 * row records the collector and the card it touched.
 *
 * Deliberately created from the boot path rather than from the migration, and
 * unconditionally on every boot: two one-time rebuilds (the card_key rekey and
 * the catalog split) drop and rename pack_collection_cards, and a trigger on a
 * dropped table goes with it. Dropped and recreated rather than left alone if
 * present, so a boot carrying a corrected trigger body replaces the old one;
 * in one transaction, so there is no window where a write could slip past an
 * unarmed table.
 *
 * An update carries both the old and the new key on purpose. Neither moves in
 * practice - the primary key is (owner, card_key) - but a roll-up that silently
 * stopped matching its table would be worse than the scan it replaced. */
export async function ensurePackCommunityRollupTriggers(db: Db): Promise<void> {
  if (!(await tablesExist(db))) return;
  await execBatch(db, Object.entries(DIRTY_TRIGGER_SQL).flatMap(([name, sql]) => [
    { sql: `drop trigger if exists ${name}`, args: [] },
    { sql, args: [] },
  ]));
}

export async function readPackCommunityRollupState(db: Db): Promise<PackCommunityRollupState> {
  try {
    const row = (await exec(db, "select value_json from live_meta where key = ? limit 1", [ROLLUP_META_KEY])).rows[0];
    if (!row) return { generation: null, initializedAt: null, reconciledAt: null };
    const parsed = JSON.parse(String(row.value_json)) as Partial<PackCommunityRollupState>;
    return {
      generation: typeof parsed.generation === "string" ? parsed.generation : null,
      initializedAt: typeof parsed.initializedAt === "number" ? parsed.initializedAt : null,
      reconciledAt: typeof parsed.reconciledAt === "number" ? parsed.reconciledAt : null,
    };
  } catch {
    return { generation: null, initializedAt: null, reconciledAt: null };
  }
}

async function writeRollupState(db: Db, state: PackCommunityRollupState): Promise<void> {
  await exec(
    db,
    `insert into live_meta (key, value_json, updated_at) values (?, ?, ?)
     on conflict(key) do update set value_json = excluded.value_json, updated_at = excluded.updated_at`,
    [ROLLUP_META_KEY, JSON.stringify(state), new Date().toISOString()],
  );
}

/* Usable means initialized under the current generation *and* still armed: a
   table nothing is marking dirty any more would go quietly stale, which is the
   one failure mode worth a full scan to avoid. */
export async function packCommunityRollupsReady(db: Db): Promise<boolean> {
  const state = await readPackCommunityRollupState(db);
  if (state.initializedAt == null || state.generation !== rollupGeneration()) return false;
  return triggersExist(db);
}

const OWNER_SELECT = `
  select owner_user_id,
    count(*) as cards,
    count(distinct card_user_id) as players,
    coalesce(sum(copies), 0) as copies,
    coalesce(sum(case when copies > 1 then copies - 1 else 0 end), 0) as duplicates,
    coalesce(sum(recycled_copies), 0) as recycled,
    coalesce(sum(case when card_key like '%:goat' and card_user_id in (${HONORARY_ID_LIST}) then 1 else 0 end), 0) as goats,
    coalesce(min(case when first_pulled_at > 0 then first_pulled_at else null end), 0) as joined_at,
    coalesce(max(last_pulled_at), 0) as last_pulled_at
  from pack_collection_cards
  where copies > 0`;

const OWNER_TIER_SELECT = `
  select owner_user_id, coalesce(nullif(tier, ''), 'unrated') as tier, coalesce(sum(copies), 0) as copies
  from pack_collection_cards
  where copies > 0`;

const CARD_SELECT = `
  select card_user_id, count(distinct owner_user_id) as owners, coalesce(sum(copies), 0) as copies
  from pack_collection_cards
  where copies > 0`;

const OWNER_COLUMNS =
  "(owner_user_id, cards, players, copies, duplicates, recycled, goats, joined_at, last_pulled_at, updated_at)";

/* Ids inlined for the same reason the feature module inlines them: a batch runs
   to hundreds of entries and would trip the bound-parameter limit. Every id
   here came out of the database as an integer. */
function idList(ids: readonly number[]): string {
  const safe = ids.filter((id) => Number.isInteger(id) && id > 0);
  return safe.length > 0 ? safe.join(",") : "-1";
}

/* The first build of the tables, or a rebuild after a generation change.
 *
 * The scans run outside a transaction and the rows are written after, rather
 * than as one `insert ... select`, so the single SQLite writer is never held
 * for the length of a full scan while score ingest waits behind it. That leaves
 * a window where a pull lands between the read and the write - which is exactly
 * what the dirty tables are for. They are filled by the triggers throughout and
 * deliberately not cleared here, so the drain that follows corrects anything
 * this pass read too early. */
async function rebuild(db: Db, now: number): Promise<{ owners: number; cards: number }> {
  const started = Date.now();
  const ownerRows = (await exec(db, `${OWNER_SELECT} group by owner_user_id`)).rows;
  const tierRows = (await exec(db, `${OWNER_TIER_SELECT} group by owner_user_id, 2`)).rows;
  const cardRows = (await exec(db, `${CARD_SELECT} group by card_user_id`)).rows;

  await execBatch(db, [
    { sql: "delete from pack_community_owner_stats", args: [] },
    { sql: "delete from pack_community_owner_tier_stats", args: [] },
    { sql: "delete from pack_community_card_stats", args: [] },
  ]);

  for (let index = 0; index < ownerRows.length; index += REBUILD_WRITE_BATCH) {
    await execBatch(db, ownerRows.slice(index, index + REBUILD_WRITE_BATCH).map((row) => ({
      sql: `insert or replace into pack_community_owner_stats ${OWNER_COLUMNS} values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        Number(row.owner_user_id), Number(row.cards), Number(row.players), Number(row.copies),
        Number(row.duplicates), Number(row.recycled), Number(row.goats), Number(row.joined_at),
        Number(row.last_pulled_at), now,
      ],
    })));
  }
  for (let index = 0; index < tierRows.length; index += REBUILD_WRITE_BATCH) {
    await execBatch(db, tierRows.slice(index, index + REBUILD_WRITE_BATCH).map((row) => ({
      sql: "insert or replace into pack_community_owner_tier_stats (owner_user_id, tier, copies) values (?, ?, ?)",
      args: [Number(row.owner_user_id), String(row.tier), Number(row.copies)],
    })));
  }
  for (let index = 0; index < cardRows.length; index += REBUILD_WRITE_BATCH) {
    await execBatch(db, cardRows.slice(index, index + REBUILD_WRITE_BATCH).map((row) => ({
      sql: "insert or replace into pack_community_card_stats (card_user_id, owners, copies, updated_at) values (?, ?, ?, ?)",
      args: [Number(row.card_user_id), Number(row.owners), Number(row.copies), now],
    })));
  }

  logInfo("pack_community_rollup_rebuilt", {
    owners: ownerRows.length,
    cards: cardRows.length,
    duration_ms: Date.now() - started,
    detail: "rebuilt the community roll-up from the ownership table",
  });
  return { owners: ownerRows.length, cards: cardRows.length };
}

/* One batch of collectors, recomputed and un-marked in a single transaction:
   delete then re-insert, so a collector whose last copy was recycled loses
   their row rather than keeping a frozen one. Doing the read and the un-marking
   in the same transaction is what closes the gap where a pull landing mid-pass
   would have its dirty mark deleted without being counted. */
async function drainOwners(db: Db, ids: number[], now: number): Promise<void> {
  const list = idList(ids);
  await execBatch(db, [
    { sql: `delete from pack_community_owner_stats where owner_user_id in (${list})`, args: [] },
    { sql: `delete from pack_community_owner_tier_stats where owner_user_id in (${list})`, args: [] },
    {
      sql: `insert into pack_community_owner_stats ${OWNER_COLUMNS}
            select owner_user_id, cards, players, copies, duplicates, recycled, goats,
              joined_at, last_pulled_at, ${Math.floor(now)} from (
              ${OWNER_SELECT} and owner_user_id in (${list}) group by owner_user_id
            )`,
      args: [],
    },
    {
      sql: `insert into pack_community_owner_tier_stats (owner_user_id, tier, copies)
            ${OWNER_TIER_SELECT} and owner_user_id in (${list})
            group by owner_user_id, 2`,
      args: [],
    },
    { sql: `delete from pack_community_dirty_owners where owner_user_id in (${list})`, args: [] },
  ]);
}

async function drainCards(db: Db, ids: number[], now: number): Promise<void> {
  const list = idList(ids);
  await execBatch(db, [
    { sql: `delete from pack_community_card_stats where card_user_id in (${list})`, args: [] },
    {
      sql: `insert into pack_community_card_stats (card_user_id, owners, copies, updated_at)
            select card_user_id, owners, copies, ${Math.floor(now)} from (
              ${CARD_SELECT} and card_user_id in (${list}) group by card_user_id
            )`,
      args: [],
    },
    { sql: `delete from pack_community_dirty_cards where card_user_id in (${list})`, args: [] },
  ]);
}

/* One reconcile at a time, per process.
 *
 * A refresh tick asks for the collector snapshot and the card snapshot
 * together, and each brings the roll-up level before it builds. Run
 * concurrently, a cold boot starts two full rebuilds of the same tables, and an
 * ordinary tick has both passes reading the same dirty rows and recomputing the
 * same collectors. Chained rather than shared: the second caller still gets a
 * pass taken after it asked, it just finds the backlog already drained and
 * costs a millisecond.
 *
 * Chaining off the settled promise, so a pass that throws does not strand every
 * later one behind a rejection. */
let reconcileChain: Promise<unknown> = Promise.resolve();

/**
 * Brings the roll-up tables level with the ownership table, initializing them
 * first if this is a new or regenerated database. Safe to call from anywhere
 * that can write; in production this runs on the pack community snapshot
 * thread, immediately before a build, so the writes stay off both the serving
 * event loop and the ingest process's connection.
 */
export function reconcilePackCommunityRollups(
  db: Db,
  options: { now?: number; budgetMs?: number } = {},
): Promise<PackCommunityRollupResult> {
  const pass = reconcileChain.then(() => runReconcile(db, options), () => runReconcile(db, options));
  reconcileChain = pass.catch(() => undefined);
  return pass;
}

async function runReconcile(
  db: Db,
  options: { now?: number; budgetMs?: number },
): Promise<PackCommunityRollupResult> {
  const startedAt = Date.now();
  const now = options.now ?? startedAt;
  const budgetMs = options.budgetMs ?? RECONCILE_BUDGET_MS;
  const empty: PackCommunityRollupResult = {
    ready: false, blocked: null, rebuilt: false, owners: 0, cards: 0, backlog: 0, durationMs: 0,
  };
  if (!(await tablesExist(db))) return { ...empty, blocked: "no_tables", durationMs: Date.now() - startedAt };
  if (!(await triggersExist(db))) {
    // Nothing is marking rows dirty, so anything already stored is already
    // suspect. Loud, because the page silently going back to full scans is the
    // symptom this whole module exists to remove.
    logWarn("pack_community_rollup_untriggered", {
      detail: "the ownership table has no dirty-row triggers; the community page falls back to full scans",
    });
    return { ...empty, blocked: "no_triggers", durationMs: Date.now() - startedAt };
  }

  const state = await readPackCommunityRollupState(db);
  const generation = rollupGeneration();
  let rebuilt = false;
  let owners = 0;
  let cards = 0;
  if (state.initializedAt == null || state.generation !== generation) {
    const built = await rebuild(db, now);
    owners += built.owners;
    cards += built.cards;
    rebuilt = true;
    await writeRollupState(db, { generation, initializedAt: now, reconciledAt: now });
  }

  for (;;) {
    if (Date.now() - startedAt > budgetMs) break;
    const wanted = ownerBatch;
    const ids = (await exec(
      db,
      "select owner_user_id from pack_community_dirty_owners limit ?",
      [wanted],
    )).rows.map((row) => Number(row.owner_user_id));
    if (ids.length === 0) break;
    const batchStarted = Date.now();
    await drainOwners(db, ids, now);
    const elapsed = Date.now() - batchStarted;
    ownerBatch = nextBatchSize(wanted, elapsed, ids.length >= wanted, OWNER_BATCH_MAX);
    owners += ids.length;
    if (ids.length >= wanted) await standAside(elapsed);
  }
  for (;;) {
    if (Date.now() - startedAt > budgetMs) break;
    const wanted = cardBatch;
    const ids = (await exec(
      db,
      "select card_user_id from pack_community_dirty_cards limit ?",
      [wanted],
    )).rows.map((row) => Number(row.card_user_id));
    if (ids.length === 0) break;
    const batchStarted = Date.now();
    await drainCards(db, ids, now);
    const elapsed = Date.now() - batchStarted;
    cardBatch = nextBatchSize(wanted, elapsed, ids.length >= wanted, CARD_BATCH_MAX);
    cards += ids.length;
    if (ids.length >= wanted) await standAside(elapsed);
  }

  const backlog = Number(
    (await exec(
      db,
      `select (select count(*) from pack_community_dirty_owners)
            + (select count(*) from pack_community_dirty_cards) as backlog`,
    )).rows[0]?.backlog,
  ) || 0;
  if (!rebuilt && (owners > 0 || cards > 0)) await writeRollupState(db, { generation, initializedAt: state.initializedAt ?? now, reconciledAt: now });
  if (backlog > 0) {
    logWarn("pack_community_rollup_backlog", {
      backlog,
      duration_ms: Date.now() - startedAt,
      detail: "reconcile spent its budget with rows still queued; the next pass finishes them",
    });
  }
  return { ready: true, blocked: null, rebuilt, owners, cards, backlog, durationMs: Date.now() - startedAt };
}

function toOwnerRollup(row: Record<string, unknown>): PackCommunityOwnerRollup {
  return {
    ownerUserId: Number(row.owner_user_id),
    cards: Number(row.cards) || 0,
    players: Number(row.players) || 0,
    copies: Number(row.copies) || 0,
    duplicates: Number(row.duplicates) || 0,
    recycled: Number(row.recycled) || 0,
    goats: Number(row.goats) || 0,
    joinedAt: Number(row.joined_at) || 0,
    lastPulledAt: Number(row.last_pulled_at) || 0,
  };
}

/* The scans the roll-up replaced, kept as the fallback and expressed with the
   same SQL the reconciler stores from. One definition, two ways of paying for
   it: a database whose roll-up is missing, mid-rebuild or a generation behind
   still answers, it just answers the slow way. */
async function scanOwnerRollups(db: Db): Promise<PackCommunityOwnerRollup[]> {
  return (await exec(db, `${OWNER_SELECT} group by owner_user_id`)).rows.map(toOwnerRollup);
}

async function scanTierCopies(db: Db): Promise<Record<string, number>> {
  const rows = (await exec(db, `${OWNER_TIER_SELECT} group by 2`)).rows;
  const tierCopies: Record<string, number> = {};
  for (const row of rows) tierCopies[String(row.tier)] = Number(row.copies) || 0;
  return tierCopies;
}

async function scanCardRollups(db: Db): Promise<PackCommunityCardRollup[]> {
  return (await exec(db, `${CARD_SELECT} group by card_user_id`)).rows.map((row) => ({
    cardUserId: Number(row.card_user_id),
    owners: Number(row.owners) || 0,
    copies: Number(row.copies) || 0,
  }));
}

/** Where a set of counts came from, for the log line and the admin readout. */
export type PackCommunityRollupSource = "rollup" | "scan";

export async function readCollectorAggregates(db: Db): Promise<{
  owners: PackCommunityOwnerRollup[];
  tierCopies: Record<string, number>;
  source: PackCommunityRollupSource;
}> {
  if (await packCommunityRollupsReady(db)) {
    const [owners, tierCopies] = await Promise.all([readOwnerStats(db), readPackCommunityTierCopies(db)]);
    return { owners, tierCopies, source: "rollup" };
  }
  const [owners, tierCopies] = await Promise.all([scanOwnerRollups(db), scanTierCopies(db)]);
  return { owners, tierCopies, source: "scan" };
}

export async function readCardAggregates(db: Db): Promise<{
  cards: PackCommunityCardRollup[];
  source: PackCommunityRollupSource;
}> {
  if (await packCommunityRollupsReady(db)) return { cards: await readCardStats(db), source: "rollup" };
  return { cards: await scanCardRollups(db), source: "scan" };
}

/* The headline numbers of the whole economy, straight off the maintained
 * tables.
 *
 * This is the cheap half of the community page: every total the header prints
 * is a sum or a count over a couple of thousand collector rows and fourteen
 * thousand card rows, measured at under 5ms together, where the boards
 * underneath need the sorted snapshot. Reading it separately is what lets the
 * numbers people watch tick be minutes fresher than the boards they sit above.
 *
 * Null when the roll-up is not usable, because the alternative is the full
 * scans, and those are exactly what must not happen on a request. The caller
 * then keeps the totals its cached snapshot came with. */
export interface PackCommunityHeadlineCounts {
  collectors: number;
  cardsMinted: number;
  distinctHoldings: number;
  cardsRecycled: number;
  firstPullAt: number | null;
  playersCarded: number;
  oneOfAKind: number;
  tierCopies: Record<string, number>;
}

export async function readPackCommunityHeadlineCounts(db: Db): Promise<PackCommunityHeadlineCounts | null> {
  if (!(await packCommunityRollupsReady(db))) return null;
  const [ownerRow, cardRow, tierCopies] = await Promise.all([
    exec(
      db,
      `select count(*) as collectors, coalesce(sum(copies), 0) as copies, coalesce(sum(cards), 0) as holdings,
         coalesce(sum(recycled), 0) as recycled, coalesce(min(nullif(joined_at, 0)), 0) as first_pull_at
       from pack_community_owner_stats`,
    ),
    exec(
      db,
      `select count(*) as carded, coalesce(sum(case when owners = 1 then 1 else 0 end), 0) as one_of_a_kind
       from pack_community_card_stats`,
    ),
    readPackCommunityTierCopies(db),
  ]);
  const owners = ownerRow.rows[0];
  const cards = cardRow.rows[0];
  if (!owners || !cards) return null;
  const firstPullAt = Number(owners.first_pull_at) || 0;
  return {
    collectors: Number(owners.collectors) || 0,
    cardsMinted: Number(owners.copies) || 0,
    distinctHoldings: Number(owners.holdings) || 0,
    cardsRecycled: Number(owners.recycled) || 0,
    firstPullAt: firstPullAt > 0 ? firstPullAt : null,
    playersCarded: Number(cards.carded) || 0,
    oneOfAKind: Number(cards.one_of_a_kind) || 0,
    tierCopies,
  };
}

/* The stored side of the two readers above. */
async function readOwnerStats(db: Db): Promise<PackCommunityOwnerRollup[]> {
  const rows = (await exec(
    db,
    `select owner_user_id, cards, players, copies, duplicates, recycled, goats, joined_at, last_pulled_at
     from pack_community_owner_stats`,
  )).rows;
  return rows.map(toOwnerRollup);
}

async function readPackCommunityTierCopies(db: Db): Promise<Record<string, number>> {
  const rows = (await exec(
    db,
    "select tier, coalesce(sum(copies), 0) as copies from pack_community_owner_tier_stats group by tier",
  )).rows;
  const tierCopies: Record<string, number> = {};
  for (const row of rows) tierCopies[String(row.tier)] = Number(row.copies) || 0;
  return tierCopies;
}

async function readCardStats(db: Db): Promise<PackCommunityCardRollup[]> {
  const rows = (await exec(db, "select card_user_id, owners, copies from pack_community_card_stats")).rows;
  return rows.map((row) => ({
    cardUserId: Number(row.card_user_id),
    owners: Number(row.owners) || 0,
    copies: Number(row.copies) || 0,
  }));
}

/* Reconcile without letting a write problem take the page down with it: a
   roll-up that cannot be brought up to date is a slow page, not a broken one. */
export async function reconcilePackCommunityRollupsQuietly(db: Db, now: number): Promise<void> {
  try {
    await reconcilePackCommunityRollups(db, { now });
  } catch (error) {
    logWarn("pack_community_rollup_reconcile_failed", errorContext(error));
  }
}
