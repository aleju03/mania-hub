import type { AdminCardGrantInput } from "./admin-collections";
import type { ManiaCardTier, ManiaSkills } from "./maniacard";

/* The pure half of the grant form on /admin/collections: the shape the inputs
   hold, and how it becomes a grant.

   Separate from the page because the rules here are the ones with teeth. The
   form doubles as an edit of a card the collector already holds, so a blank box
   has to mean "leave that field as it is" rather than "write zero" - and the
   skills snapshot in particular is frozen at the pull that minted it, so a
   grant of one extra copy silently clearing it would destroy something that
   cannot be recovered. */

export const TIER_ORDER: ManiaCardTier[] = [
  "common", "rare", "elite", "superRare", "ultraRare",
  "legendary", "mythic", "ascendant", "worldClass", "goat",
];

/* Every number a maniacard front draws, in the order the card reads them: the
   three big bars, then the traits, then the two the rating pass added later,
   then the rating's own identity. `polish` and `apex` are optional on the type
   because snapshots minted before 2026-08-07 have neither. */
export const SKILL_FIELDS: Array<{ key: keyof ManiaSkills; label: string; step?: string }> = [
  { key: "fingerControl", label: "Finger control" },
  { key: "speed", label: "Speed" },
  { key: "accuracy", label: "Accuracy" },
  { key: "stamina", label: "Stamina" },
  { key: "versatility", label: "Versatility" },
  { key: "peak", label: "Peak" },
  { key: "polish", label: "Polish" },
  { key: "apex", label: "Apex" },
  { key: "cardPower", label: "Card power" },
  { key: "starAvg", label: "Star average", step: "0.01" },
  { key: "mainKeyMode", label: "Main keymode" },
  { key: "sampleSize", label: "Sample size" },
];

export interface CardForm {
  tier: string;
  tierLabel: string;
  copies: string;
  copiesMode: "add" | "set";
  recycledCopies: string;
  pp: string;
  globalRank: string;
  skills: Record<string, string>;
  archetype: string;
  /* Three states rather than a checkbox, because "keep" has to be the default:
     adding one copy to a card someone already holds must not wipe the snapshot
     their pull froze. */
  skillsMode: "keep" | "set" | "clear";
  firstPulledAt: string;
  lastPulledAt: string;
  serialMode: "keep" | "mint" | "set";
  serial: string;
  username: string;
  avatarUrl: string;
  countryCode: string;
  overwriteIdentity: boolean;
}

export function emptyCardForm(): CardForm {
  return {
    tier: "unrated",
    tierLabel: "",
    copies: "1",
    copiesMode: "add",
    recycledCopies: "",
    pp: "",
    globalRank: "",
    skills: {},
    archetype: "",
    skillsMode: "keep",
    // Blank leaves the stamps alone, which on a card being minted here for the
    // first time is the moment the grant lands.
    firstPulledAt: "",
    lastPulledAt: "",
    serialMode: "keep",
    serial: "",
    username: "",
    avatarUrl: "",
    countryCode: "",
    overwriteIdentity: false,
  };
}

/* datetime-local reads and writes wall-clock text with no zone, so the epoch
   has to be shifted into the viewer's own offset on the way in and read back
   through the same Date the input wrote. */
export function toLocalInput(ms: number): string {
  return new Date(ms - new Date(ms).getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

export function fromLocalInput(value: string): number | undefined {
  if (!value) return undefined;
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function numberOrUndefined(value: string): number | undefined {
  if (value.trim() === "") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function formTier(form: CardForm): ManiaCardTier | null {
  return form.tier === "unrated" ? null : (form.tier as ManiaCardTier);
}

/* The snapshot the form describes, or null when it is not writing one. Every
   listed field lands as a number so the card front never has to guess: a blank
   box inside a snapshot means that bar is zero, which is different from having
   no snapshot at all. */
export function formSkills(form: CardForm): ManiaSkills | null {
  if (form.skillsMode !== "set") return null;
  const built: Record<string, unknown> = { archetype: form.archetype.trim() || "Allrounder" };
  for (const field of SKILL_FIELDS) built[field.key] = numberOrUndefined(form.skills[field.key] ?? "") ?? 0;
  return built as unknown as ManiaSkills;
}

export function buildCardGrant(
  form: CardForm,
  identity: { cardUserId: number; username?: string; avatarUrl?: string; countryCode?: string },
): AdminCardGrantInput {
  const tier = formTier(form);
  return {
    cardUserId: identity.cardUserId,
    tier,
    /* Only ever a label somebody typed. Sending the tier's own name when the
       box is empty would make it indistinguishable from a deliberate one, and
       the badge already falls back to the tier at render time - which is also
       where the honorary roster's own labels live, so a blank box lets those
       keep answering. */
    tierLabel: form.tierLabel.trim() || null,
    copies: numberOrUndefined(form.copies) ?? 1,
    copiesMode: form.copiesMode,
    recycledCopies: numberOrUndefined(form.recycledCopies),
    pp: numberOrUndefined(form.pp),
    globalRank: numberOrUndefined(form.globalRank),
    skills: formSkills(form) ?? undefined,
    clearSkills: form.skillsMode === "clear",
    firstPulledAt: fromLocalInput(form.firstPulledAt),
    lastPulledAt: fromLocalInput(form.lastPulledAt),
    serialMode: form.serialMode,
    serial: numberOrUndefined(form.serial),
    // The picked player's own identity is the fallback, so granting a card of
    // someone the backend has never stored still gives it a face.
    username: form.username.trim() || identity.username || undefined,
    avatarUrl: form.avatarUrl.trim() || identity.avatarUrl || undefined,
    countryCode: form.countryCode.trim() || identity.countryCode || undefined,
    overwriteIdentity: form.overwriteIdentity,
  };
}
