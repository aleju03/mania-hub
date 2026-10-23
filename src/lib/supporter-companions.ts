import { msg } from "@lingui/core/macro";
import type { MessageDescriptor } from "@lingui/core";

/* Companions: a small figure an active supporter keeps beside their profile's
   numbers. The site's own are listed here (backend/src/features/
   supporter-companions.ts holds the same ids); any supporter can also submit
   one, a 3D model or an image, which goes live at once, shows who sent it, and
   which an admin can delete. 3D ones turn left and right when dragged, never
   tipping over. */

export const SUPPORTER_COMPANION_IDS = [
  "sahur-keycap",
  "blob-pink",
  "fumo-reimu-v2",
  "fumo-cirno",
  "fumo-flandre",
  "fumo-mokou",
  "fumo-youmu",
  "fumo-yuyuko",
  "fumo-sakuya-inu",
] as const;

export type BuiltInCompanionId = (typeof SUPPORTER_COMPANION_IDS)[number];
export type CompanionKind = "model" | "image";

export interface BuiltInCompanion {
  id: BuiltInCompanionId;
  name: MessageDescriptor;
  /* The keycap is its own pressable drawing; the rest are models. */
  kind: "keycap" | "model";
  url?: string;
  /* Turn (radians) that faces the model toward the viewer. */
  facing?: number;
  /* Fabric: drawn fully matte, whatever shine the scan's maps carry. */
  matte?: boolean;
  /* A still of the model, rendered ahead of time (companionThumbnail) so a
     list of them downloads no models. */
  thumb?: string;
  credit?: { author: string; url: string; license: string };
}

const FUMO_CREDIT = (uid: string) => ({ author: "Renafox", url: `https://sketchfab.com/3d-models/${uid}`, license: "CC BY 4.0" });

/* The scans face every which way, so each gets the turn that faces it front. */
const fumo = (id: BuiltInCompanionId, name: MessageDescriptor, uid: string, facing: number): BuiltInCompanion => ({
  id,
  name,
  kind: "model",
  url: `/models/companions/${id}.glb`,
  thumb: `/models/companions/thumbs/${id}.webp`,
  facing,
  matte: true,
  credit: FUMO_CREDIT(uid),
});

export const BUILT_IN_COMPANIONS: readonly BuiltInCompanion[] = [
  { id: "sahur-keycap", name: msg`Tung tung sahur keycap`, kind: "keycap" },
  { id: "blob-pink", name: msg`Pink blob`, kind: "model", url: "/models/companions/blob-pink.glb", thumb: "/models/companions/thumbs/blob-pink.webp" },
  fumo("fumo-reimu-v2", msg`Reimu fumo`, "ff926e77d0564c028bde86fd32a487c1", -1.47),
  fumo("fumo-cirno", msg`Cirno fumo`, "efd2a7f4dbf048c1a18438db7f86c4b9", 2.06),
  fumo("fumo-flandre", msg`Flandre fumo`, "bef0ada62b64410ba523923cf6ac56ce", -0.9),
  fumo("fumo-mokou", msg`Mokou fumo`, "f58946a7b7304ef099c0275b1ac3ef18", 1.87),
  fumo("fumo-youmu", msg`Youmu fumo`, "0031ed6284ac4310952095302aad77c2", -1.67),
  fumo("fumo-yuyuko", msg`Yuyuko fumo`, "6d5d0483009942fb916eedc60ea383a4", 3.04),
  fumo("fumo-sakuya-inu", msg`Inu Sakuya`, "7a573802931f485db8118a9d64f26362", 0.15),
];

export interface SubmittedCompanion {
  id: string;
  name: string;
  kind: CompanionKind;
  url: string;
  submittedBy: { id: number; username: string };
  createdAt: number;
}

/* What a profile wears: one of the site's own, or a submission. */
export type SupporterCompanion = { builtIn: BuiltInCompanion } | { submitted: SubmittedCompanion };

export const COMPANION_NAME_MAX = 32;

export function builtInCompanion(id: unknown): BuiltInCompanion | null {
  return BUILT_IN_COMPANIONS.find((entry) => entry.id === id) ?? null;
}

const COMPANION_URL: Record<CompanionKind, RegExp> = {
  model: /^https:\/\/[a-z0-9.-]+\/companions\/[a-f0-9]{64}\.glb$/,
  image: /^https:\/\/[a-z0-9.-]+\/companions\/[a-f0-9]{64}\.webp$/,
};

export function parseSubmittedCompanion(value: unknown): SubmittedCompanion | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const kind = raw.kind;
  if ((kind !== "model" && kind !== "image") || typeof raw.url !== "string" || !COMPANION_URL[kind].test(raw.url)) return null;
  if (typeof raw.id !== "string" || !/^u\d+$/.test(raw.id) || typeof raw.name !== "string") return null;
  const by = (raw.submittedBy ?? {}) as Record<string, unknown>;
  return {
    id: raw.id,
    name: raw.name.slice(0, COMPANION_NAME_MAX),
    kind,
    url: raw.url,
    submittedBy: { id: Number(by.id) || 0, username: String(by.username ?? "") },
    createdAt: Number(raw.createdAt) || 0,
  };
}

/* The backend's answer for a profile: `{ id }` for one of the site's own, a submission whole. */
export function parseSupporterCompanion(value: unknown): SupporterCompanion | null {
  if (!value || typeof value !== "object") return null;
  const builtIn = builtInCompanion((value as { id?: unknown }).id);
  if (builtIn) return { builtIn };
  const submitted = parseSubmittedCompanion(value);
  return submitted ? { submitted } : null;
}

export function companionId(companion: SupporterCompanion): string {
  return "builtIn" in companion ? companion.builtIn.id : companion.submitted.id;
}
