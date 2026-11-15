import type { I18n, MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";

/* The run used to be a page of stacked sections here. It is a game table now
   (RunTable.tsx): the songs, charms and score live on the table, the shop in
   its play area (RunShop.tsx) and everything secondary in Run info
   (RunInfo.tsx). What is left is the copy the shop and the table share for a
   shop action the server refused. */

const REFUSALS: Record<string, MessageDescriptor> = {
  no_shards: msg`Not enough shards.`,
  no_rerolls: msg`No rerolls left in this shop.`,
  no_slot: msg`Every charm slot is full. Sell one first.`,
  sold: msg`Already bought.`,
};

export function runRefusalMessage(reason: string, i18n: I18n, fallback: string): string {
  const copy = REFUSALS[reason];
  return copy ? i18n._(copy) : fallback;
}
