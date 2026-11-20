import { fitPictureForUpload } from "./fit-picture-for-upload";
import { isWorkshopFrameId, parseWorkshopFrameArt, registerWorkshopFrames, type WorkshopFrameArt, type WorkshopFrameId } from "./supporter-avatar-frames";

/* A frame a supporter made in the workshop, as the backend lists it
   (backend features/supporter-frames.ts): in everyone's picker from the
   moment it is submitted, reviewed by an admin afterwards. */
export interface SubmittedFrame extends WorkshopFrameArt {
  id: WorkshopFrameId;
  submittedBy: { id: number; username: string };
  createdAt: number;
  listed: boolean;
  /* An admin has looked at it since it went up. */
  reviewed: boolean;
}

export const FRAME_NAME_MAX = 32;

/* One listed frame, checked field by field; its art is registered so it draws at once. */
export function parseSubmittedFrame(raw: unknown): SubmittedFrame | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  const by = value.submittedBy as { id?: unknown; username?: unknown } | null;
  if (!isWorkshopFrameId(value.id) || typeof value.name !== "string" || !by || !Number.isSafeInteger(Number(by.id))) return null;
  const art = parseWorkshopFrameArt({ [value.id]: value })[value.id];
  if (!art) return null;
  registerWorkshopFrames({ [value.id]: art });
  return {
    ...art,
    id: value.id,
    submittedBy: { id: Number(by.id), username: String(by.username ?? by.id) },
    createdAt: Number(value.createdAt) || 0,
    listed: value.listed === true,
    reviewed: value.reviewed === true,
  };
}

export function parseSubmittedFrames(raw: unknown): SubmittedFrame[] {
  return Array.isArray(raw) ? raw.map(parseSubmittedFrame).filter((entry): entry is SubmittedFrame => entry !== null) : [];
}

/* Registers the art of frames that came back from a server function: those
   were parsed on the server, so this page has not seen their art yet. */
export function registerSubmittedFrames(frames: readonly SubmittedFrame[]): readonly SubmittedFrame[] {
  registerWorkshopFrames(Object.fromEntries(frames.map((frame) => [frame.id, { name: frame.name, still: frame.still, video: frame.video, round: frame.round, roundVideo: frame.roundVideo, overhang: frame.overhang }])));
  return frames;
}

/* Uploads one file of a frame (its still, round still or a loop) to
   /api/supporter-frame, which checks it and answers with its public URL and,
   for a picture, how far its art reaches past the avatar. */
export async function uploadFramePart(kind: "still" | "video" | "round", original: Blob): Promise<{ url: string; overhang?: [number, number, number, number] }> {
  const file = kind === "video" ? original : await fitPictureForUpload(original);
  const response = await fetch(`/api/supporter-frame?kind=${kind}`, { method: "POST", headers: { "content-type": file.type || "application/octet-stream" }, body: file });
  const reply = await response.json().catch(() => null) as { url?: unknown; overhang?: unknown; error?: unknown } | null;
  if (!response.ok || typeof reply?.url !== "string") throw new Error(typeof reply?.error === "string" ? reply.error : `Upload failed (${response.status})`);
  return { url: reply.url, overhang: Array.isArray(reply.overhang) ? reply.overhang.map(Number) as [number, number, number, number] : undefined };
}
