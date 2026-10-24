/* Where the chain run was opened from (the Overjoy doodle's centre, in
   viewport px), so the table can open out of it. It expires instead of
   being taken: a development render runs a state initializer twice. */
let origin: { x: number; y: number; at: number } | null = null;

export function setChainEntryOrigin(x: number, y: number): void {
  origin = { x, y, at: Date.now() };
}

export function takeChainEntryOrigin(): { x: number; y: number } | null {
  if (!origin || Date.now() - origin.at > 4000) return null;
  return { x: origin.x, y: origin.y };
}
