/* Supporter avatar frames: art drawn around a supporter's avatar on their
   profile. Each frame is a looping transparent WebM plus a still PNG under
   /images/supporter-frames/, made from the designs in
   local-notes/supporter-decorations/ (export/export-frames.py writes both and
   the geometry below). The parts that pass behind the avatar are already cut
   out of the art, so the frame simply lies on top of it. The backend keeps the
   pick against the same ids (SUPPORTER_AVATAR_FRAMES in features/supporters.ts);
   how the picker groups them lives in SupporterFramePicker. */

interface FrameGeometry {
  /* Where the art's canvas sits: [left, top, width, height] in avatar widths, from the avatar's top-left corner. */
  box: readonly [number, number, number, number];
  /* How far the drawn art reaches past the avatar: [left, top, right, bottom] in avatar widths. */
  overhang: readonly [number, number, number, number];
  /* A CSS filter for the avatar itself, for frames that restyle the picture (a video overlay cannot). */
  avatarFilter?: string;
  /* Its art frames a square window (a photo, a window, a card). Lists draw
     avatars round, and a round one here leaves the window's corners bare, so
     this frame keeps its avatar square there too. */
  squareWindow?: true;
  /* Its art passes behind the avatar through a hole cut to the rounded
     square, so a round avatar would show the cut; lists use {id}-round.png,
     the same still with a round hole (foundry/lib/still-round.mjs). */
  roundStill?: true;
  /* Shown as the still PNG only, never the looping video. */
  stillOnly?: boolean;
  /* Where the wearer's own dan badge sits on the art, [left, top, width, height]
     as fractions of the art's canvas, for a frame that shows it. */
  danWindow?: readonly [number, number, number, number];
  /* The point the art swings from, [x, y] as fractions of its canvas, for art
     that swings as a whole (its dan badge has to move with it). */
  swingPivot?: readonly [number, number];
  /* Where the dan's name and its keymode/skillset line are printed beside the
     badge, [left, top, width, height] as fractions of the art's canvas. */
  danText?: readonly [number, number, number, number];
  /* The laminated card a holo sheen crosses as the art swings, [left, top,
     width, height] as fractions of the art's canvas, and its corner radius as a
     fraction of its width. */
  sheenCard?: readonly [number, number, number, number, number];
}

/* A player's own dan, for a frame that shows it: the one they picked from
   every dan they hold (any keymode, rice or LN, overall or one skillset),
   else the overall rice dan of the keymode they play most. `key` names it
   ("4:rc:tech"), `skillset` is null for a side's overall dan. */
export interface FrameDan {
  key: string;
  label: string;
  family: "rc" | "ln";
  keyCount: number;
  skillset: string | null;
}

export function parseFrameDan(raw: unknown): FrameDan | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  const keyCount = Number(value.keyCount);
  if (typeof value.label !== "string" || !value.label || (value.family !== "rc" && value.family !== "ln") || !Number.isInteger(keyCount)) return null;
  const skillset = typeof value.skillset === "string" ? value.skillset : null;
  const key = typeof value.key === "string" ? value.key : `${keyCount}:${value.family}:${skillset ?? "overall"}`;
  return { key, label: value.label, family: value.family, keyCount, skillset };
}

const FRAME_GEOMETRY = {
  crown: { box: [-0.2419, -0.6452, 1.5323, 1.0484], overhang: [0.1935, 0.4516, 0, 0] },
  sakura: { box: [-0.4355, -0.4194, 1.629, 1.6613], overhang: [0.3589, 0.3387, 0.1935, 0.2016] },
  stardust: { box: [-0.8548, -0.3548, 2.1935, 2.129], overhang: [0.8427, 0, 0.2823, 0.7742] },
  storm: { box: [-0.3226, -0.6129, 1.6935, 1.8226], overhang: [0, 0.3024, 0.3468, 0] },
  wisteria: { roundStill: true, box: [-0.2419, -0.2419, 1.4839, 1.4839], overhang: [0.2419, 0.2258, 0, 0.2419] },
  "aero-bubble": { squareWindow: true, box: [-0.371, -0.371, 1.7419, 1.7419], overhang: [0.2298, 0.1774, 0.1976, 0.1815] },
  "aero-window": { squareWindow: true, box: [-0.2419, -0.2419, 1.4839, 1.4839], overhang: [0.1048, 0.2177, 0.1048, 0.121] },
  "ai-wings-1": { roundStill: true, box: [-0.7258, -0.7581, 2.6129, 1.9677], overhang: [0.7258, 0.2401, 0.7611, 0] },
  "ai-wings-2": { roundStill: true, box: [-0.7258, -0.7581, 2.6129, 1.9677], overhang: [0.7258, 0.5294, 0.7611, 0] },
  "ai-wings-3": { roundStill: true, box: [-0.7258, -0.7581, 2.6129, 1.9677], overhang: [0.7258, 0.7534, 0.7611, 0] },
  "autumn-maple": { box: [-0.2419, -0.2419, 1.4839, 1.4839], overhang: [0.2419, 0.2419, 0.2419, 0.2419] },
  "azimuth-orbit": { box: [-0.3065, -0.371, 1.6129, 1.6774], overhang: [0.246, 0.3266, 0.254, 0.2298] },
  "battle-buttons": { box: [-0.4677, -0.371, 1.9355, 1.7419], overhang: [0.4395, 0, 0.4395, 0.254] },
  "black-belt": { box: [-0.3065, -0.2419, 1.6129, 1.8548], overhang: [0.0887, 0, 0.0887, 0.4355] },
  "bronze-laurel": { box: [-0.2419, -0.2419, 1.4839, 1.4839], overhang: [0.1129, 0.1008, 0.1331, 0.1855] },
  "bullet-board": { squareWindow: true, box: [-0.371, -0.371, 1.7419, 1.7419], overhang: [0.3347, 0.3347, 0.3347, 0.3347] },
  "cat-parade": { box: [-0.2419, -0.2419, 1.4839, 1.4839], overhang: [0.1573, 0.1694, 0.1532, 0.1694] },
  "chordjack-pile": { box: [-0.2419, -0.5323, 1.4839, 1.7742], overhang: [0.0484, 0.4476, 0.0444, 0] },
  "classic-window": { squareWindow: true, box: [-0.2419, -0.2419, 1.4839, 1.4839], overhang: [0.0726, 0.2056, 0.0726, 0.0847] },
  "clutch-hp": { squareWindow: true, box: [-0.3065, -0.3065, 1.6129, 1.6129], overhang: [0.1169, 0.1169, 0.1169, 0.1169] },
  "combo-break": { box: [-0.2419, -0.2419, 1.4839, 1.8065], overhang: [0, 0, 0, 0.2823] },
  "course-run": { box: [-0.2419, -0.5645, 1.7419, 1.9355], overhang: [0, 0.3468, 0.1452, 0] },
  "crayon-border": { squareWindow: true, box: [-0.371, -0.371, 1.7419, 1.7419], overhang: [0.2056, 0.2016, 0.2097, 0.2056] },
  "crown-sketch": { box: [-0.2419, -0.6452, 1.5323, 1.129], overhang: [0.1411, 0.4435, 0, 0] },
  "crown-sketch-gold": { box: [-0.2419, -0.6452, 1.5323, 1.129], overhang: [0.1411, 0.4315, 0, 0] },
  "crt-monitor": { squareWindow: true, box: [-0.2419, -0.2419, 1.4839, 1.7419], overhang: [0.1895, 0.0968, 0.1895, 0.4556] },
  "dan-license": { box: [-0.2419, -0.2419, 1.4839, 2.0887], overhang: [0, 0, 0, 0.6129], stillOnly: true, danWindow: [0.2636, 0.6931, 0.1793, 0.1274], swingPivot: [0.5, 0.5946], danText: [0.4755, 0.7359, 0.2649, 0.0938], sheenCard: [0.2337, 0.6274, 0.5299, 0.2413, 0.045] },
  "dan-skip-1-eta": { squareWindow: true, box: [-0.2419, -0.2419, 1.4839, 1.4839], overhang: [0.1048, 0.129, 0.1048, 0.1653] },
  "dan-skip-10-alpha": { squareWindow: true, box: [-0.2419, -0.2419, 1.4839, 1.4839], overhang: [0.1573, 0.0968, 0.121, 0.129] },
  "dan-skip-5-gamma": { squareWindow: true, box: [-0.2419, -0.2419, 1.4839, 1.4839], overhang: [0.129, 0.129, 0.125, 0.1895] },
  "dan-skip-alpha-kappa": { squareWindow: true, box: [-0.2419, -0.2419, 1.4839, 1.4839], overhang: [0.1089, 0.1048, 0.1169, 0.125] },
  "delta-crest": { squareWindow: true, box: [-0.2419, -0.2419, 1.4839, 1.4839], overhang: [0.1734, 0.1653, 0.1774, 0.1855] },
  "dfjk-keys": { box: [-0.2419, -0.2419, 1.4839, 1.5806], overhang: [0, 0, 0, 0.1411] },
  "dialogue-box": { box: [-0.371, -0.371, 1.7419, 1.8871], overhang: [0.2621, 0, 0.2621, 0.4879] },
  "disc-bounce": { box: [-0.2419, -0.2419, 1.4839, 1.4839], overhang: [0, 0, 0, 0] },
  "disc-bounce-7k": { box: [-0.2419, -0.2419, 1.4839, 1.4839], overhang: [0, 0, 0, 0] },
  "error-cascade": { box: [-0.2419, -0.2419, 1.6129, 1.4839], overhang: [0, 0.1815, 0.3387, 0] },
  "fairy-lights": { squareWindow: true, box: [-0.2419, -0.2419, 1.4839, 1.4839], overhang: [0.0927, 0.0565, 0.0927, 0] },
  "five-star-pull": { box: [-0.4032, -0.3226, 1.8065, 1.6935], overhang: [0.3508, 0, 0.3589, 0.1532] },
  "gamma-orbit": { box: [-0.3065, -0.371, 1.6129, 1.6774], overhang: [0.246, 0, 0.254, 0] },
  "greek-circle": { box: [-0.5081, -0.5565, 2.0161, 2.0726], overhang: [0.2621, 0.3105, 0.2621, 0.2742] },
  "hakurei-torii": { roundStill: true, box: [-0.3548, -0.4839, 1.7097, 1.8226], overhang: [0.3548, 0.4839, 0.3548, 0.2419] },
  "halo-cyan": { box: [-0.371, -0.5, 1.7419, 1.6129], overhang: [0, 0.4919, 0, 0] },
  "halo-pink": { box: [-0.371, -0.5, 1.7419, 1.6129], overhang: [0, 0.4798, 0, 0] },
  "hanging-stellium": { box: [-0.2984, -0.2984, 1.4839, 1.4839], overhang: [0, 0.0847, 0.1008, 0] },
  "highlighter-loop": { box: [-0.371, -0.371, 1.7419, 1.7419], overhang: [0.2137, 0.1089, 0.1815, 0.1613] },
  "hit-error": { box: [-0.2419, -0.2419, 1.4839, 1.6935], overhang: [0.0202, 0, 0.0202, 0.2218] },
  "hp-bar": { box: [-0.371, -0.371, 1.7419, 1.7419], overhang: [0.2944, 0, 0.2944, 0.2782] },
  "ice-fairy": { box: [-0.5645, -0.3548, 2.129, 1.5806], overhang: [0.5645, 0.2702, 0.5645, 0.1169] },
  "ink-plum": { box: [-0.2419, -0.2419, 1.4839, 1.4839], overhang: [0, 0.2419, 0.2419, 0.1532] },
  "judge-line": { box: [-0.371, -0.371, 1.7419, 1.7419], overhang: [0.3629, 0.3669, 0.3629, 0.3669] },
  "judgement-pop": { box: [-0.2419, -0.2419, 1.4839, 1.4839], overhang: [0, 0.1371, 0, 0] },
  "kappa-signal": { box: [-0.2419, -0.2419, 1.4839, 1.4839], overhang: [0.1169, 0.0484, 0.1532, 0.121] },
  "knob-lasers": { box: [-0.371, -0.371, 1.7419, 1.7419], overhang: [0.371, 0.371, 0.371, 0.371] },
  "light-wings-1": { roundStill: true, box: [-0.9194, -0.8065, 2.8387, 2.0161], overhang: [0.6573, 0.121, 0.6573, 0] },
  "light-wings-2": { roundStill: true, box: [-0.9194, -0.8065, 2.8387, 2.0161], overhang: [0.7984, 0.3589, 0.7984, 0] },
  "light-wings-3": { roundStill: true, box: [-0.9194, -0.8065, 2.8387, 2.0161], overhang: [0.9113, 0.6169, 0.9113, 0] },
  "ln-hold-1": { box: [-0.2419, -0.2419, 1.4839, 1.4839], overhang: [0.1008, 0.125, 0.1008, 0.0766] },
  "ln-hold-13": { box: [-0.2419, -0.2419, 1.4839, 1.4839], overhang: [0.125, 0.1048, 0.125, 0.1048] },
  "ln-hold-17": { box: [-0.2419, -0.2419, 1.4839, 1.4839], overhang: [0.125, 0.1048, 0.125, 0.1048] },
  "ln-hold-5": { box: [-0.2419, -0.2419, 1.4839, 1.4839], overhang: [0.1008, 0.125, 0.1008, 0.0766] },
  "ln-hold-9": { box: [-0.2419, -0.2419, 1.4839, 1.4839], overhang: [0.125, 0.125, 0.125, 0.1048] },
  "loading-bar": { box: [-0.2419, -0.2419, 1.4839, 1.5806], overhang: [0, 0, 0, 0.121] },
  "makiba-peek": { roundStill: true, box: [-0.2903, -0.3387, 1.5806, 1.5806], overhang: [0.0726, 0.3306, 0.1169, 0.0847] },
  "makiba-chubby": { roundStill: true, box: [-0.2903, -0.3387, 1.5806, 1.5806], overhang: [0.0726, 0.3387, 0.1169, 0.0847] },
  "margin-doodles": { squareWindow: true, box: [-0.371, -0.371, 1.7419, 1.7419], overhang: [0.2863, 0.2581, 0.2823, 0.3024] },
  "neon-ears": { box: [-0.2419, -0.3387, 1.4839, 1.5806], overhang: [0, 0.2944, 0, 0] },
  "note-highway": { box: [-0.2419, -0.4677, 1.4839, 1.7097], overhang: [0, 0.3952, 0, 0] },
  "old-photo": { squareWindow: true, box: [-0.2419, -0.2419, 1.4839, 1.6129], overhang: [0.1371, 0.2339, 0.1411, 0.3548], avatarFilter: "sepia(0.55) saturate(0.75) contrast(1.05)" },
  "pass-stamp": { roundStill: true, box: [-0.2419, -0.2419, 1.8065, 1.8548], overhang: [0.0081, 0, 0.3226, 0.3306] },
  "pencil-boil": { squareWindow: true, box: [-0.371, -0.371, 1.7419, 1.7419], overhang: [0.2823, 0.2903, 0.3065, 0.2944] },
  "percy-check": { box: [-0.2419, -0.2419, 1.4839, 1.7258], overhang: [0.1331, 0.1371, 0.1331, 0.254] },
  "pity-counter": { squareWindow: true, box: [-0.371, -0.371, 1.7419, 1.7419], overhang: [0.0887, 0.0887, 0.0887, 0.2016] },
  "pixel-hearts": { box: [-0.2419, -0.2419, 1.4839, 1.4839], overhang: [0, 0.0968, 0, 0] },
  "rail-pass": { squareWindow: true, box: [-0.371, -0.371, 1.7419, 1.7419], overhang: [0.1331, 0.3306, 0.1331, 0.1411] },
  "rain-cloud": { box: [-0.2419, -0.2419, 1.4839, 1.4839], overhang: [0, 0.2016, 0.2419, 0.0202] },
  "rainbow-crystal-wings": { box: [-0.6774, -0.2903, 2.3548, 1.3548], overhang: [0.621, 0.0605, 0.629, 0] },
  "reimu-ribbon": { box: [0.0806, -0.5161, 1.4194, 1.0484], overhang: [0, 0.3669, 0.3548, 0] },
  "results-grade": { squareWindow: true, box: [-0.3145, -0.3145, 1.7742, 1.7419], overhang: [0.1089, 0.1089, 0.3347, 0.2863], stillOnly: true },
  "save-star": { box: [-0.371, -0.371, 1.7419, 1.7419], overhang: [0, 0, 0.3266, 0.0363] },
  "scarlet-moon": { roundStill: true, box: [-0.4516, -0.4839, 1.871, 1.6129], overhang: [0.4516, 0.4637, 0.4194, 0] },
  "scratch-deck": { box: [-0.371, -0.371, 1.7419, 1.871], overhang: [0.3629, 0, 0.3629, 0.5] },
  "seven-key": { box: [-0.3387, -0.2419, 1.6774, 1.6452], overhang: [0.1089, 0, 0.1089, 0.1815] },
  "skill-radar": { box: [-0.5, -0.5, 2.0, 1.9677], overhang: [0.2742, 0.2863, 0.2742, 0.2298] },
  "soul-shatter": { box: [-0.371, -0.371, 1.7419, 1.7419], overhang: [0.0081, 0, 0.1532, 0.371] },
  "spell-card": { box: [-0.5484, -0.5484, 2.0968, 2.0968], overhang: [0.5484, 0.5484, 0.5484, 0.5484] },
  "ssr-card": { squareWindow: true, box: [-0.371, -0.371, 1.7419, 1.7419], overhang: [0.2097, 0.1694, 0.1008, 0.3185] },
  "stage-four-fail": { box: [-0.2419, -0.5645, 1.7419, 1.9355], overhang: [0, 0.2742, 0.3065, 0.0806] },
  "stair-roll": { box: [-0.2903, -0.2903, 1.5806, 1.5806], overhang: [0.2258, 0.254, 0.2258, 0.2339] },
  "stellium-orbit": { roundStill: true, box: [-0.3065, -0.371, 1.6129, 1.6774], overhang: [0.3065, 0.3266, 0.3065, 0.2298] },
  "step-pad": { squareWindow: true, box: [-0.371, -0.371, 1.7419, 1.7419], overhang: [0.371, 0.371, 0.371, 0.371] },
  "susies-idea": { box: [-0.371, -0.371, 1.7419, 1.7419], overhang: [0.1089, 0, 0.0968, 0.2298] },
  "sv-gimmick": { box: [-0.2419, -0.7258, 1.4839, 1.9677], overhang: [0.0524, 0.4798, 0.0524, 0] },
  "taped-page": { squareWindow: true, box: [-0.371, -0.371, 1.7419, 1.7419], overhang: [0.2419, 0.25, 0.254, 0.3387] },
  "term-boot": { squareWindow: true, box: [-0.2419, -0.2419, 1.4839, 1.5806], overhang: [0.1169, 0.1815, 0.1169, 0.3065] },
  "term-hud": { box: [-0.2419, -0.2419, 1.4839, 1.4839], overhang: [0.2218, 0.1815, 0.2339, 0.1734] },
  "term-rain": { box: [-0.2419, -0.2419, 1.4839, 1.4839], overhang: [0.2339, 0.2419, 0.2177, 0.2419] },
  "term-window": { squareWindow: true, box: [-0.2419, -0.2419, 1.4839, 1.6452], overhang: [0.1694, 0.2298, 0.1694, 0.4032] },
  "time-stop-knives": { box: [-0.371, -0.371, 1.7419, 1.7419], overhang: [0.3306, 0.3226, 0.3306, 0.3427] },
  "trophy-shelf": { box: [-0.3548, -0.2419, 1.7097, 1.8629], overhang: [0.1492, 0, 0.1492, 0.3871] },
  "wash-ring": { roundStill: true, box: [-0.371, -0.371, 1.7419, 1.7419], overhang: [0.371, 0.3669, 0.371, 0.371] },
  "wings-feather-1": { roundStill: true, box: [-0.8548, -0.7581, 2.871, 1.9677], overhang: [0.7223, 0, 0.7235, 0] },
  "wings-feather-2": { roundStill: true, box: [-0.8548, -0.7581, 2.871, 1.9677], overhang: [0.7334, 0.2501, 0.7346, 0] },
  "wings-feather-3": { roundStill: true, box: [-0.8548, -0.7581, 2.871, 1.9677], overhang: [0.7334, 0.4931, 0.7346, 0] },
  "wings-gold-1": { box: [-0.8548, -0.7581, 2.871, 1.9677], overhang: [0.6561, 0, 0.6573, 0] },
  "wings-gold-2": { roundStill: true, box: [-0.8548, -0.7581, 2.871, 1.9677], overhang: [0.6837, 0.2391, 0.6849, 0] },
  "wings-gold-3": { roundStill: true, box: [-0.8548, -0.7581, 2.871, 1.9677], overhang: [0.6837, 0.4544, 0.6849, 0] },
  "wings-pink-1": { roundStill: true, box: [-0.8548, -0.7581, 2.871, 1.9677], overhang: [0.7831, 0.0569, 0.7842, 0] },
  "wings-pink-2": { roundStill: true, box: [-0.8548, -0.7581, 2.871, 1.9677], overhang: [0.8107, 0.3329, 0.8118, 0] },
  "wings-pink-3": { roundStill: true, box: [-0.8548, -0.7581, 2.871, 1.9677], overhang: [0.8107, 0.5648, 0.8118, 0] },
  "wings-soft-1": { roundStill: true, box: [-0.8548, -0.7581, 2.871, 1.9677], overhang: [0.5898, 0.1563, 0.5855, 0] },
  "wings-soft-2": { roundStill: true, box: [-0.8548, -0.7581, 2.871, 1.9677], overhang: [0.5898, 0.4047, 0.5855, 0] },
  "wings-soft-3": { roundStill: true, box: [-0.8548, -0.7581, 2.871, 1.9677], overhang: [0.5898, 0.5869, 0.5855, 0] },
  "wings-swept-1": { box: [-0.8548, -0.7581, 2.871, 1.9677], overhang: [0.6947, 0, 0.6904, 0] },
  "wings-swept-2": { box: [-0.8548, -0.7581, 2.871, 1.9677], overhang: [0.7389, 0.1728, 0.7401, 0] },
  "wings-swept-3": { roundStill: true, box: [-0.8548, -0.7581, 2.871, 1.9677], overhang: [0.7389, 0.3992, 0.7401, 0] },
  "winter-pine": { box: [-0.2419, -0.2419, 1.4839, 1.4839], overhang: [0.2419, 0.2419, 0.2419, 0.2419] },
  "witch-broom": { box: [-0.8548, -0.7742, 2.1935, 2.5484], overhang: [0.8427, 0.2944, 0.2823, 0.7742] },
  "witch-hat": { box: [-0.4839, -0.7742, 1.2258, 1.0968], overhang: [0.1613, 0.5685, 0, 0] },
  "xp-window": { squareWindow: true, box: [-0.2419, -0.2419, 1.4839, 1.4839], overhang: [0.0887, 0.2016, 0.0887, 0.0887] },
  "yinyang-orbs": { box: [-0.371, -0.371, 1.7419, 1.7419], overhang: [0.3427, 0.3226, 0.3427, 0.3629] },
  "zenith-orbit": { roundStill: true, box: [-0.3065, -0.371, 1.6129, 1.6774], overhang: [0.3065, 0.3266, 0.3065, 0.2298] },
} as const satisfies Record<string, FrameGeometry>;

/* The site's own frames, by id. */
export type BuiltInFrameId = keyof typeof FRAME_GEOMETRY;
/* A frame a supporter made in the workshop, by its backend id ("u12"). */
export type WorkshopFrameId = `u${number}`;
export type SupporterAvatarFrameId = BuiltInFrameId | WorkshopFrameId;

export const SUPPORTER_AVATAR_FRAMES = Object.keys(FRAME_GEOMETRY) as BuiltInFrameId[];

/* The workshop template every made frame is drawn on: a square canvas with
   the avatar inset the same on every side, at twice the profile's size. */
export const WORKSHOP_FRAME_TEMPLATE = { size: 384, avatar: 248, inset: 68 } as const;
const WORKSHOP_BOX = [
  -WORKSHOP_FRAME_TEMPLATE.inset / WORKSHOP_FRAME_TEMPLATE.avatar,
  -WORKSHOP_FRAME_TEMPLATE.inset / WORKSHOP_FRAME_TEMPLATE.avatar,
  WORKSHOP_FRAME_TEMPLATE.size / WORKSHOP_FRAME_TEMPLATE.avatar,
  WORKSHOP_FRAME_TEMPLATE.size / WORKSHOP_FRAME_TEMPLATE.avatar,
] as const;

/* What a page needs to draw a workshop frame: its files and how far its art reaches. */
export interface WorkshopFrameArt {
  name: string;
  still: string;
  video: string | null;
  /* The still drawn round a round avatar, for lists; without it lists keep the avatar square. */
  round: string | null;
  overhang: readonly [number, number, number, number];
}

/* Workshop frames this page has been told about (payloads that name one carry
   its art as `frameArt`). An unknown one draws nothing until its art arrives. */
const workshopFrames = new Map<string, { art: WorkshopFrameArt; geometry: FrameGeometry }>();
const workshopListeners = new Set<() => void>();

export function isWorkshopFrameId(value: unknown): value is WorkshopFrameId {
  return typeof value === "string" && /^u\d{1,12}$/.test(value);
}

export function parseWorkshopFrameArt(raw: unknown): Record<string, WorkshopFrameArt> {
  const out: Record<string, WorkshopFrameArt> = {};
  if (!raw || typeof raw !== "object") return out;
  for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
    const art = value as { name?: unknown; still?: unknown; video?: unknown; round?: unknown; overhang?: unknown } | null;
    const overhang = Array.isArray(art?.overhang) && art.overhang.length === 4 ? art.overhang.map(Number) : null;
    if (!isWorkshopFrameId(id) || typeof art?.still !== "string" || !/^https:\/\//.test(art.still) || !overhang || overhang.some((n) => !Number.isFinite(n))) continue;
    out[id] = { name: typeof art.name === "string" ? art.name.slice(0, 40) : "", still: art.still, video: typeof art.video === "string" && /^https:\/\//.test(art.video) ? art.video : null, round: typeof art.round === "string" && /^https:\/\//.test(art.round) ? art.round : null, overhang: overhang as [number, number, number, number] };
  }
  return out;
}

export function registerWorkshopFrames(frames: Record<string, WorkshopFrameArt>): void {
  let changed = false;
  for (const [id, art] of Object.entries(frames)) {
    const known = workshopFrames.get(id)?.art;
    if (known && known.still === art.still && known.video === art.video && known.round === art.round && known.name === art.name) continue;
    // with a round version a list draws its avatar round; without one it keeps it square
    workshopFrames.set(id, { art, geometry: art.round
      ? { box: WORKSHOP_BOX, overhang: art.overhang, roundStill: true, stillOnly: !art.video }
      : { box: WORKSHOP_BOX, overhang: art.overhang, squareWindow: true, stillOnly: !art.video } });
    changed = true;
  }
  if (changed) {
    workshopVersion++;
    for (const listener of workshopListeners) listener();
  }
}

let workshopVersion = 0;
/* Bumps whenever a workshop frame's art arrives, as a store snapshot. */
export function workshopFramesVersion(): number {
  return workshopVersion;
}

export function workshopFrameName(id: SupporterAvatarFrameId): string | null {
  return isWorkshopFrameId(id) ? workshopFrames.get(id)?.art.name || null : null;
}

export function subscribeWorkshopFrames(listener: () => void): () => void {
  workshopListeners.add(listener);
  return () => workshopListeners.delete(listener);
}

/* Whether a frame can be drawn now: one of the site's own, or a workshop frame whose art is known. */
export function isDrawableFrame(id: SupporterAvatarFrameId): boolean {
  return isWorkshopFrameId(id) ? workshopFrames.has(id) : Object.hasOwn(FRAME_GEOMETRY, id);
}

/* A drawable stand-in while a workshop frame's art is unknown: no overhang, no art. */
const NO_GEOMETRY: FrameGeometry = { box: WORKSHOP_BOX, overhang: [0, 0, 0, 0], squareWindow: true, stillOnly: true };

function geometryOf(id: SupporterAvatarFrameId): FrameGeometry {
  if (isWorkshopFrameId(id)) return workshopFrames.get(id)?.geometry ?? NO_GEOMETRY;
  return (FRAME_GEOMETRY as Record<string, FrameGeometry>)[id] ?? NO_GEOMETRY;
}

/* The designs assume a 124px avatar with a 16px corner radius. */
export const FRAMED_AVATAR_RADIUS = `${(16 / 124) * 100}%`;

export function isSupporterAvatarFrame(value: unknown): value is SupporterAvatarFrameId {
  return typeof value === "string" && (Object.hasOwn(FRAME_GEOMETRY, value) || isWorkshopFrameId(value));
}

/* Style for the avatar under a frame: the designs' corner radius, plus the
   frame's avatar filter if it has one. Nothing when there is no frame. */
/* `round`: a list avatar, which stays a circle inside any frame but a
   square-window one. */
export function framedAvatarStyle(frame: SupporterAvatarFrameId | null, { round = false }: { round?: boolean } = {}): { borderRadius: string; filter?: string } | undefined {
  if (!frame) return undefined;
  const geometry = geometryOf(frame);
  const borderRadius = round && !geometry.squareWindow ? "50%" : FRAMED_AVATAR_RADIUS;
  return geometry.avatarFilter ? { borderRadius, filter: geometry.avatarFilter } : { borderRadius };
}

export function supporterFrameGeometry(id: SupporterAvatarFrameId): FrameGeometry {
  return geometryOf(id);
}

/* Bump after re-exporting any frame: /images/ is served cache-first by the
   service worker, so changed art needs a new URL. */
const FRAME_ART_VERSION = 68;

/* `round`: the still for a round avatar, where the frame has one. */
export function supporterFrameSrc(id: SupporterAvatarFrameId, kind: "video" | "still", { round = false }: { round?: boolean } = {}): string {
  if (isWorkshopFrameId(id)) {
    const art = workshopFrames.get(id)?.art;
    return (kind === "video" ? art?.video : round ? art?.round : null) ?? art?.still ?? "";
  }
  if (kind === "still" && round && geometryOf(id).roundStill) return `/images/supporter-frames/${id}-round.png?v=${FRAME_ART_VERSION}`;
  return `/images/supporter-frames/${id}.${kind === "video" ? "webm" : "png"}?v=${FRAME_ART_VERSION}`;
}
