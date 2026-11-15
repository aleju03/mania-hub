import type { LayerKind } from "../../../lib/custom-theme-layers";

/* One small drawing per kind of layer, for the layer list and the add menu. */
export function LayerIcon({ kind, className }: { kind: LayerKind | "finish"; className?: string }) {
  const common = { viewBox: "0 0 24 24", className, "aria-hidden": true, fill: "none", stroke: "currentColor", strokeWidth: 1.7, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };
  switch (kind) {
    case "background":
      return (
        <svg {...common}>
          <rect x="3.5" y="4.5" width="17" height="15" rx="2.5" />
          <path d="M3.5 14.5c3-2.2 5.5-2.2 8.5 0s5.5 2.2 8.5 0" opacity=".7" />
        </svg>
      );
    case "image":
      return (
        <svg {...common}>
          <rect x="3.5" y="4.5" width="17" height="15" rx="2.5" />
          <circle cx="9" cy="9.5" r="1.6" />
          <path d="m4 17.5 5-5 3.5 3.5 2.5-2.5 5 4.5" />
        </svg>
      );
    case "particles":
      return (
        <svg {...common} fill="currentColor" stroke="none">
          <circle cx="6" cy="7" r="1.6" />
          <circle cx="14" cy="5" r="1.1" />
          <circle cx="18.5" cy="10" r="1.9" />
          <circle cx="9.5" cy="13" r="1.2" />
          <circle cx="15" cy="16" r="1.5" />
          <circle cx="6" cy="18.5" r="1" />
        </svg>
      );
    case "fog":
      return (
        <svg {...common}>
          <path d="M3.5 9c2.3-1.6 4.4-1.6 6.7 0s4.4 1.6 6.7 0c1.2-.8 2.4-1.2 3.6-1.2" />
          <path d="M3.5 13.5c2.3-1.6 4.4-1.6 6.7 0s4.4 1.6 6.7 0c1.2-.8 2.4-1.2 3.6-1.2" opacity=".7" />
          <path d="M3.5 18c2.3-1.6 4.4-1.6 6.7 0s4.4 1.6 6.7 0c1.2-.8 2.4-1.2 3.6-1.2" opacity=".45" />
        </svg>
      );
    case "glow":
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="3.6" fill="currentColor" stroke="none" />
          <circle cx="12" cy="12" r="7" opacity=".45" />
          <circle cx="12" cy="12" r="9.8" opacity=".2" />
        </svg>
      );
    case "stars":
      return (
        <svg {...common} fill="currentColor" stroke="none">
          <circle cx="5.5" cy="6" r=".9" />
          <circle cx="11" cy="4.5" r=".6" />
          <circle cx="18" cy="6.5" r="1.3" />
          <circle cx="8" cy="11.5" r="1.4" />
          <circle cx="15" cy="12" r=".7" />
          <circle cx="20" cy="15" r=".8" />
          <circle cx="4.5" cy="17" r=".7" />
          <circle cx="11.5" cy="18.5" r="1" />
          <circle cx="17" cy="19.5" r=".6" />
        </svg>
      );
    case "finish":
      return (
        <svg {...common}>
          <rect x="3.5" y="4.5" width="17" height="15" rx="2.5" />
          <ellipse cx="12" cy="12" rx="5.5" ry="4" opacity=".55" />
        </svg>
      );
  }
}
