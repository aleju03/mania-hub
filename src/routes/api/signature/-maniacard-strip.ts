import { createElement as h, type CSSProperties, type ReactElement, type ReactNode } from "react";
import type { ManiaSkills } from "../../../lib/maniacard";

interface ManiaStripOptions {
  width: number;
  height: number;
  username: string;
  avatarUrl: string;
  tierLabel: string;
  accent: string;
  skills: ManiaSkills;
  background: ReactNode[];
  tierBacked: boolean;
  watermark: boolean;
}

const SHADOW = "0 2px 4px rgba(0,0,0,0.5)";
const FILL = { top: 0, right: 0, bottom: 0, left: 0 };

/** The same bright foil, Torus lettering and inset plates as the card front,
 * composed for the compact strip. Background choices stay underneath. */
export function maniaStripElement(options: ManiaStripOptions): ReactElement {
  const { width, height, username, avatarUrl, tierLabel, accent, skills } = options;
  const text = (key: string, value: string, style: CSSProperties) => h("div", { key, style }, value);
  const positioned = (key: string, style: CSSProperties, children: ReactNode[]) => h("div", {
    key, style: { position: "absolute", display: "flex", ...style },
  }, children);
  const plate: CSSProperties = options.tierBacked ? {
    background: "rgba(0,0,0,0.30)", border: "1px solid rgba(255,255,255,0.22)",
  } : {};
  const avatarSize = 108;

  return h("div", {
    style: {
      display: "flex", position: "relative", overflow: "hidden", width, height,
      fontFamily: '"Torus OG"', color: "#ffffff", borderRadius: 14,
      background: "transparent", fontWeight: 900,
    },
  }, [
    ...options.background,
    positioned("avatar", {
      top: 16, left: 16,
      width: avatarSize, height: avatarSize, overflow: "hidden", borderRadius: 16,
      border: "3px solid rgba(255,255,255,0.48)",
      boxShadow: "0 5px 18px rgba(0,0,0,0.20)",
    }, [
      h("img", { src: avatarUrl, width: avatarSize, height: avatarSize,
        style: { width: "100%", height: "100%", objectFit: "cover" } }),
    ]),
    positioned("nameplate", {
      top: 27, left: 142,
      width: 280, height: 46, borderRadius: 12,
      alignItems: "center", justifyContent: "flex-start",
      padding: "0 14px", ...plate,
    }, [
      text("name", username, {
        fontSize: username.length > 16 ? 20 : username.length > 12 ? 24 : 29,
        lineHeight: 1.2, textShadow: SHADOW, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
      }),
    ]),
    positioned("tier", {
      top: 85, left: 156, right: 178,
      justifyContent: "flex-start",
    }, [text("label", tierLabel, {
      fontSize: 15, lineHeight: 1.1, textShadow: SHADOW,
      letterSpacing: "0.04em",
    })]),
    positioned("power", {
      top: 24, right: 18, width: 138, height: 88, borderRadius: 16,
      flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 2, ...plate,
    }, [
      text("value", String(Math.round(skills.cardPower)), {
        fontSize: skills.cardPower >= 1000 ? 38 : 44, lineHeight: 1, color: accent, textShadow: SHADOW,
      }),
      text("label", "CARD POWER", { fontSize: 9, letterSpacing: "0.08em", textShadow: SHADOW }),
    ]),
    ...(options.tierBacked ? [positioned("rim", {
      ...FILL, border: "2px solid rgba(255,255,255,0.46)", borderRadius: 14,
    }, [])] : []),
    ...(options.watermark ? [positioned("watermark", { bottom: 8, right: 20 }, [
      text("mark", "mania-tracker.com", { fontSize: 8, fontWeight: 400, color: "rgba(255,255,255,0.55)", textShadow: SHADOW }),
    ])] : []),
  ]);
}
