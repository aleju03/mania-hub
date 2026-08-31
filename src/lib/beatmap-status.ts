// The osu! leaderboard status of a beatmap, drawn the way osu! draws it.
//
// One definition, because the colors are the site's promise that a green chip
// means the same thing on the maps grid as it does on a profile's plays list.
// The words are message descriptors rather than strings so every surface
// resolves them through its own i18n instance.

import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";

export interface BeatmapStatusPill {
  label: MessageDescriptor;
  className: string;
}

/** Null for a status osu! has no chip for, and for an unknown one. */
export function beatmapStatusPill(status: string): BeatmapStatusPill | null {
  const normalized = status.toLowerCase();
  if (normalized === "ranked" || normalized === "approved") return { label: msg`ranked`, className: "bg-[#6cf27f] text-black" };
  if (normalized === "loved") return { label: msg`loved`, className: "bg-[#f26fa6] text-black" };
  if (normalized === "qualified") return { label: msg`qualified`, className: "bg-[#66ccff] text-black" };
  if (normalized === "graveyard") return { label: msg`graveyard`, className: "bg-[#4a4a52] text-white" };
  if (normalized === "pending" || normalized === "wip") return { label: msg`pending`, className: "bg-[#f2b56c] text-black" };
  return null;
}
