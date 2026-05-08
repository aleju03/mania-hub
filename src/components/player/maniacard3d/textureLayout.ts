import { buildStarSegments, truncateToWidth } from "./layout";
import type { ManiaCardReadyData } from "./types";

export type MeasureText = (text: string, fontSize: number, fontFamily: string, fontWeight: number) => number;

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface RoundedSquare {
  x: number;
  y: number;
  size: number;
  radius: number;
}

export interface FaceLayout {
  front: {
    username: { text: string; x: number; y: number; maxWidth: number; fontSize: number };
    tierLabel: { text: string; x: number; y: number; fontSize: number };
    avatar: RoundedSquare;
    stats: Array<{ label: string; value: number; x: number; y: number }>;
    stars: ReturnType<typeof buildStarSegments>;
    starAverage: string;
  };
  back: {
    rarityLabel: string;
    logoCenter: { x: number; y: number };
  };
  masks: {
    avatar: Rect;
  };
}

export function buildFaceLayout(data: ManiaCardReadyData, measure: MeasureText): FaceLayout {
  const usernameMaxWidth = 610;
  const usernameFontSize = 52;
  const avatar = { x: 185, y: 280, size: 630, radius: 32 };
  const username = truncateToWidth(
    data.user.username,
    usernameMaxWidth,
    (text) => measure(text, usernameFontSize, "Torus", 900),
  );

  return {
    front: {
      username: { text: username, x: 310, y: 158, maxWidth: usernameMaxWidth, fontSize: usernameFontSize },
      tierLabel: { text: data.tierStyle.label, x: 930, y: 232, fontSize: 56 },
      avatar,
      stats: data.stats.map((stat, index) => ({
        label: stat.label,
        value: stat.value,
        x: 260,
        y: 1015 + index * 62,
      })),
      stars: buildStarSegments(data.skills.starAvg),
      starAverage: `${data.skills.starAvg.toFixed(2)}★`,
    },
    back: {
      rarityLabel: data.tierStyle.label.toUpperCase(),
      logoCenter: { x: 500, y: 700 },
    },
    masks: {
      avatar: { x: avatar.x, y: avatar.y, width: avatar.size, height: avatar.size },
    },
  };
}
