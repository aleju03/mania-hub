import type { DbStatement } from "../db.js";

/* Mint order belongs to the holding, not to the best-effort community pull
   report that follows a server draw. Every path that creates a holding uses
   this statement in the same write batch as the ownership row, so closing the
   browser between the draw and its report can no longer leave the card
   unserialled.

   A server draw sets pullReportPending because its community event still
   arrives from the browser once the card's client-computed tier is known.
   Imports and admin grants have no corresponding event and leave it settled.
   Existing serials also migrate as settled. */
export function mintPackCardSerialStatement(
  cardKey: string,
  cardUserId: number,
  ownerUserId: number,
  mintedAt: number,
  options: { pullReportPending?: boolean } = {},
): DbStatement {
  return {
    sql: `insert or ignore into pack_card_serials (
            card_key, card_user_id, owner_user_id, serial, minted_at, pull_report_pending
          )
          select ?, ?, ?, coalesce((select max(serial) from pack_card_serials where card_key = ?), 0) + 1, ?, ?`,
    args: [cardKey, cardUserId, ownerUserId, cardKey, mintedAt, options.pullReportPending ? 1 : 0],
  };
}

/* The event and this settlement travel in one batch. A failed or rejected
   report therefore leaves the bit pending so a later honest report can still
   be the card's first public pull; a committed one can never become "first"
   again after event retention removes its old log row. */
export function settlePackCardPullReportStatement(cardKey: string, ownerUserId: number): DbStatement {
  return {
    sql: `update pack_card_serials set pull_report_pending = 0
          where card_key = ? and owner_user_id = ? and pull_report_pending != 0`,
    args: [cardKey, ownerUserId],
  };
}
