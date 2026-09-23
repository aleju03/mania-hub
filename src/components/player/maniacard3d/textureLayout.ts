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
    tierLabel: { text: string; x: number; y: number; fontSize: number; align: "left" | "right" };
    avatar: RoundedSquare;
    stats: Array<{ label: string; value: number; x: number; y: number }>;
    /* The team spine face (a team card); null on a player's card. */
    team: {
      /* The team header turned a quarter down the card's left edge. */
      spine: Rect;
      flag: Rect;
      /* The tag, one letter under the next down the spine. */
      tag: { letters: Array<{ text: string; x: number; y: number }>; fontSize: number };
      name: { lines: string[]; x: number; y: number; fontSize: number; lineHeight: number };
      statValueSize: number;
      statLabelSize: number;
    } | null;
    stars: ReturnType<typeof buildStarSegments>;
    starRow: { x: number; y: number; size: number; spacing: number; averageY: number };
    starAverage: string;
  };
  back: {
    rarityLabel: string;
    logoCenter: { x: number; y: number };
  };
  masks: {
    avatar: Rect;
    /* A second picture the foil dims over: the team card's flag. */
    flag: { rect: Rect; radius: number } | null;
  };
}

// A team card's face: the team header turned sideways runs the full height of
// the left edge, where its 4:1 shape fits nearly uncropped, with the tag down
// it one letter at a time. The flag, name, rarity, stats and stars stack in
// the column to its right.
const TEAM_SPINE: Rect = { x: 0, y: 0, width: 270, height: 1400 };
const TEAM_COLUMN = { x: 310, width: 646 };
const TEAM_FLAG: Rect = { x: TEAM_COLUMN.x, y: 84, width: TEAM_COLUMN.width, height: TEAM_COLUMN.width / 2 };
export const TEAM_FLAG_RADIUS = 26;

function buildTeamFaceLayout(data: ManiaCardReadyData, measure: MeasureText): FaceLayout {
  const team = data.team!;
  const columnCenter = TEAM_COLUMN.x + TEAM_COLUMN.width / 2;

  // As big as the widest letter fits across the spine and the whole tag fits
  // down it.
  const letters = Array.from(team.tag.trim() || "?");
  const widest = Math.max(...letters.map((letter) => measure(letter, 100, "Torus", 900)), 1);
  const tagFontSize = Math.round(Math.min(240, ((TEAM_SPINE.width - 64) / widest) * 100, 1240 / (letters.length * 0.9)));
  const cell = tagFontSize * 0.9;
  const tagTop = (TEAM_SPINE.height - cell * letters.length) / 2;

  const nameFontSize = 56;
  const nameLines = wrapToLines(data.user.username, TEAM_COLUMN.width, 2, (text) => measure(text, nameFontSize, "Torus", 800));
  const nameY = TEAM_FLAG.y + TEAM_FLAG.height + 86;
  const nameLineHeight = 64;

  // Three columns under the rarity, each number as big as the widest one fits
  // with a clear gap to its neighbour.
  const columnWidth = TEAM_COLUMN.width / 3;
  const widestValue = Math.max(...data.stats.map((stat) => measure(String(stat.value), 100, "Torus", 900)), 1);
  const statValueSize = Math.round(Math.min(96, ((columnWidth - 48) / widestValue) * 100));
  const statsY = 880;

  return {
    front: {
      username: { text: nameLines[0] ?? "", x: TEAM_COLUMN.x, y: nameY, maxWidth: TEAM_COLUMN.width, fontSize: nameFontSize },
      tierLabel: {
        text: data.tierStyle.label,
        x: TEAM_COLUMN.x,
        y: nameY + (nameLines.length - 1) * nameLineHeight + 76,
        fontSize: 52,
        align: "left",
      },
      // Only the foil mask reads this on a team card: the square-cornered spine.
      avatar: { x: TEAM_SPINE.x, y: TEAM_SPINE.y, size: TEAM_SPINE.width, radius: 0 },
      stats: data.stats.map((stat, index) => ({
        label: stat.label,
        value: stat.value,
        x: TEAM_COLUMN.x + columnWidth * (index + 0.5),
        y: statsY,
      })),
      stars: buildStarSegments(data.skills.starAvg),
      starRow: { x: columnCenter, y: 1236, size: 50, spacing: 58, averageY: 1306 },
      starAverage: `${data.skills.starAvg.toFixed(2)}★`,
      team: {
        spine: TEAM_SPINE,
        flag: TEAM_FLAG,
        tag: {
          letters: letters.map((letter, index) => ({
            text: letter,
            x: TEAM_SPINE.x + TEAM_SPINE.width / 2,
            y: tagTop + cell * (index + 0.5),
          })),
          fontSize: tagFontSize,
        },
        name: { lines: nameLines, x: TEAM_COLUMN.x, y: nameY, fontSize: nameFontSize, lineHeight: nameLineHeight },
        statValueSize,
        statLabelSize: 32,
      },
    },
    back: {
      rarityLabel: data.tierStyle.label.toUpperCase(),
      logoCenter: { x: 500, y: 700 },
    },
    masks: {
      avatar: { ...TEAM_SPINE },
      flag: { rect: { ...TEAM_FLAG }, radius: TEAM_FLAG_RADIUS },
    },
  };
}

/* Word-wraps into at most maxLines, the last one truncated when the rest will
   not fit. A single word too long for a line is truncated on its own. */
function wrapToLines(text: string, maxWidth: number, maxLines: number, measure: (text: string) => number): string[] {
  const words = text.trim().split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let index = 0;
  while (index < words.length && lines.length < maxLines) {
    if (lines.length === maxLines - 1) {
      lines.push(truncateToWidth(words.slice(index).join(" "), maxWidth, measure));
      break;
    }
    let line = words[index];
    index += 1;
    while (index < words.length && measure(`${line} ${words[index]}`) <= maxWidth) {
      line = `${line} ${words[index]}`;
      index += 1;
    }
    lines.push(truncateToWidth(line, maxWidth, measure));
  }
  return lines.length > 0 ? lines : [""];
}

export function buildFaceLayout(data: ManiaCardReadyData, measure: MeasureText): FaceLayout {
  if (data.team) return buildTeamFaceLayout(data, measure);
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
      tierLabel: { text: data.tierStyle.label, x: 930, y: 232, fontSize: 56, align: "right" },
      avatar,
      stats: data.stats.map((stat, index) => ({
        label: stat.label,
        value: stat.value,
        x: 260,
        y: 1015 + index * 62,
      })),
      stars: buildStarSegments(data.skills.starAvg),
      starRow: { x: 500, y: 1252, size: 64, spacing: 70, averageY: 1320 },
      starAverage: `${data.skills.starAvg.toFixed(2)}★`,
      team: null,
    },
    back: {
      rarityLabel: data.tierStyle.label.toUpperCase(),
      logoCenter: { x: 500, y: 700 },
    },
    masks: {
      avatar: { x: avatar.x, y: avatar.y, width: avatar.size, height: avatar.size },
      flag: null,
    },
  };
}
