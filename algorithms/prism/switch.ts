export const PRISM_ENABLED = true;

export const PRISM_KEY_COUNTS: ReadonlySet<number> = new Set([6, 7, 8]);

export function usesPrism(keyCount: number | null | undefined): boolean {
  return PRISM_ENABLED && keyCount != null && PRISM_KEY_COUNTS.has(keyCount);
}
