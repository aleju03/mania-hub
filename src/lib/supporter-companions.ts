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
  "fumo-satori",
  "fumo-koishi",
  "fumo-marisa",
  "leek",
  "plush-miku",
  "plush-teto",
  "fairy-white",
  "fairy-red",
  "fairy-blue",
  "taiko-don",
  "taiko-ka",
  "plush-black-cat",
  "maneki-neko",
  "cat-maxwell",
  "cat-sleeping",
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
  /* The artist, linked to the model's page (which carries its licence; the
     full notices are in public/models/companions/LICENSES.md). */
  credit?: { author: string; url: string };
  /* How tall it stands next to a plain fumo, which fills its box: a hat that
     rises above the rest makes it taller, and its canvas grows past the box
     to fit, so every fumo's body is drawn the same size. */
  size?: number;
}

const sketchfab = (author: string, uid: string) => ({ author, url: `https://sketchfab.com/3d-models/${uid}` });

/* A licensed Sketchfab model. The scans face every which way, so each gets the
   turn that faces it front; plush and fabric ones are drawn matte. */
const licensed = (id: BuiltInCompanionId, name: MessageDescriptor, author: string, uid: string, facing: number, { matte = true, size }: { matte?: boolean; size?: number } = {}): BuiltInCompanion => ({
  id,
  name,
  kind: "model",
  url: `/models/companions/${id}.glb`,
  thumb: `/models/companions/thumbs/${id}.webp`,
  facing,
  matte,
  size,
  credit: sketchfab(author, uid),
});
const fumo = (id: BuiltInCompanionId, name: MessageDescriptor, uid: string, facing: number, size?: number) => licensed(id, name, "Renafox", uid, facing, { size });

export const BUILT_IN_COMPANIONS: readonly BuiltInCompanion[] = [
  { id: "sahur-keycap", name: msg`Tung tung sahur keycap`, kind: "keycap" },
  { id: "blob-pink", name: msg`Pink blob`, kind: "model", url: "/models/companions/blob-pink.glb", thumb: "/models/companions/thumbs/blob-pink.webp" },
  fumo("fumo-reimu-v2", msg`Reimu fumo`, "ff926e77d0564c028bde86fd32a487c1", -1.47),
  fumo("fumo-cirno", msg`Cirno fumo`, "efd2a7f4dbf048c1a18438db7f86c4b9", 2.06),
  fumo("fumo-flandre", msg`Flandre fumo`, "bef0ada62b64410ba523923cf6ac56ce", -0.9),
  fumo("fumo-mokou", msg`Mokou fumo`, "f58946a7b7304ef099c0275b1ac3ef18", 1.87),
  fumo("fumo-youmu", msg`Youmu fumo`, "0031ed6284ac4310952095302aad77c2", -1.67, 1.15),
  fumo("fumo-yuyuko", msg`Yuyuko fumo`, "6d5d0483009942fb916eedc60ea383a4", 3.04, 1.15),
  fumo("fumo-sakuya-inu", msg`Inu Sakuya`, "7a573802931f485db8118a9d64f26362", 0.15),
  licensed("fumo-satori", msg`Satori fumo`, "DAsh9986", "19bb1a2fad344a639f18f57449cae11d", 0),
  licensed("fumo-koishi", msg`Koishi fumo`, "203Null", "37a56b489b5c4440bbabb7b7777036f6", 0, { size: 1.2 }),
  licensed("fumo-marisa", msg`Marisa fumo`, "203Null", "7dea820bf4884ecc8f2c31a085b07428", 3.14, { size: 1.4 }),
  { id: "leek", name: msg`Leek`, kind: "model", url: "/models/companions/leek.glb", thumb: "/models/companions/thumbs/leek.webp" },
  licensed("plush-miku", msg`Miku plush`, "revsworks", "22e25b5fbd444102a175c088e14eb541", 0),
  licensed("plush-teto", msg`Chubby Teto`, "revsworks", "bd8157eb42a04161b2628e58dfd2a852", 0),
  { id: "fairy-white", name: msg`White fairy`, kind: "model", url: "/models/companions/fairy-white.glb", thumb: "/models/companions/thumbs/fairy-white.webp" },
  { id: "fairy-red", name: msg`Red fairy`, kind: "model", url: "/models/companions/fairy-red.glb", thumb: "/models/companions/thumbs/fairy-red.webp" },
  { id: "fairy-blue", name: msg`Blue fairy`, kind: "model", url: "/models/companions/fairy-blue.glb", thumb: "/models/companions/thumbs/fairy-blue.webp" },
  { id: "taiko-don", name: msg`Don-chan`, kind: "model", url: "/models/companions/taiko-don.glb", thumb: "/models/companions/thumbs/taiko-don.webp", facing: -0.42 },
  { id: "taiko-ka", name: msg`Ka-chan`, kind: "model", url: "/models/companions/taiko-ka.glb", thumb: "/models/companions/thumbs/taiko-ka.webp", facing: -0.42 },
  licensed("plush-black-cat", msg`Black cat plush`, "dro", "0a81d050ac2c4f2c9adce8b640af1eeb", 0),
  licensed("maneki-neko", msg`Maneki-neko`, "Rice & Soy Sauce", "50b5d360717c442c971b3db0576606c4", 0, { matte: false }),
  licensed("cat-maxwell", msg`Maxwell the cat`, "Zhuier", "4175776146ba4550a8dd643363b7b0aa", 0.75),
  licensed("cat-sleeping", msg`Sleeping cat`, "Psu", "3f7608e2b6b248bf83db09fb21125c2b", -1.2),
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
