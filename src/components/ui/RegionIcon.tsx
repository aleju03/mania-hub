import { getRegionShape } from "../../lib/regions";

/**
 * Map silhouette of a region (the union of its member countries' shapes),
 * drawn in currentColor so it tints like a lucide icon. Renders nothing for
 * unknown codes; size via className, like OsuLogo.
 */
export function RegionIcon({ code, className = "" }: { code: string; className?: string }) {
  const shape = getRegionShape(code);
  if (!shape) return null;
  return (
    <svg viewBox={shape.viewBox} className={className} aria-hidden="true" focusable="false">
      <path d={shape.path} fill="currentColor" fillRule="evenodd" />
    </svg>
  );
}
