# ThreeJS Maniacard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the CSS Maniacard with a shared ThreeJS layered physical card renderer while keeping `/admin/maniacard` and `/player/...` synced through the same production component.

**Architecture:** `src/components/player/ManiaCard.tsx` remains the public import used by routes. The old CSS implementation is renamed to `CssManiaCardPanel` for admin comparison only, while `ManiaCardPanel` delegates to a new raw ThreeJS renderer under `src/components/player/maniacard3d/`. Dynamic front/back art is generated as canvas textures; ThreeJS handles card thickness, front/back faces, overlay shaders, tilt, flip, gyro, and adaptive idle.

**Tech Stack:** React 19, TanStack Start, Vite, Vitest, raw `three`, Canvas 2D texture generation, custom `ShaderMaterial`.

---

## File Structure

- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `src/components/player/ManiaCard.tsx`
- Modify: `src/routes/admin/maniacard.tsx`
- Create: `src/components/player/maniacard3d/types.ts`
- Create: `src/components/player/maniacard3d/renderData.ts`
- Create: `src/components/player/maniacard3d/renderData.test.ts`
- Create: `src/components/player/maniacard3d/layout.ts`
- Create: `src/components/player/maniacard3d/layout.test.ts`
- Create: `src/components/player/maniacard3d/textureLayout.ts`
- Create: `src/components/player/maniacard3d/textureLayout.test.ts`
- Create: `src/components/player/maniacard3d/cardTexture.ts`
- Create: `src/components/player/maniacard3d/cardShaders.ts`
- Create: `src/components/player/maniacard3d/cardGeometry.ts`
- Create: `src/components/player/maniacard3d/cardGeometry.test.ts`
- Create: `src/components/player/maniacard3d/cardMaterials.ts`
- Create: `src/components/player/maniacard3d/interactions.ts`
- Create: `src/components/player/maniacard3d/interactions.test.ts`
- Create: `src/components/player/maniacard3d/ManiaCardRenderer.ts`
- Create: `src/components/player/maniacard3d/ManiaCard3DPanel.tsx`

The admin route must not build its own card object. It should render:

- `CssManiaCardPanel` as the reference column.
- `ManiaCardPanel` as the production ThreeJS column.

The player route continues importing and rendering only `ManiaCardPanel`, so admin and player stay synced by construction.

---

### Task 1: Add ThreeJS Dependency

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`

- [ ] **Step 1: Install `three`**

Run:

```bash
npm install three
```

Expected:

```text
added 1 package
```

The exact npm text may include audit output. The important verification is that `package.json` contains `"three"` under `dependencies` and `package-lock.json` records it.

- [ ] **Step 2: Verify install compiles with current code**

Run:

```bash
npm run test
```

Expected:

```text
Test Files  ... passed
Tests       ... passed
```

- [ ] **Step 3: Commit**

```bash
git add package.json package-lock.json
git commit -m "Add ThreeJS dependency"
```

---

### Task 2: Add Shared Maniacard Render Data

**Files:**
- Create: `src/components/player/maniacard3d/types.ts`
- Create: `src/components/player/maniacard3d/renderData.ts`
- Create: `src/components/player/maniacard3d/renderData.test.ts`

- [ ] **Step 1: Write the failing render-data tests**

Create `src/components/player/maniacard3d/renderData.test.ts`:

```ts
import { describe, expect, test } from "vitest";
import { buildManiaCardRenderData, parseCssRgba, parseGradientStops } from "./renderData";
import type { OsuScore, OsuUser } from "../../../lib/types";

const user = {
  id: 123,
  username: "PlayerWithAVeryLongName",
  avatar_url: "https://example.test/avatar.png",
  country_code: "US",
  statistics: { global_rank: 4567 },
} as OsuUser;

function score(starRating: number, pp: number): OsuScore {
  return {
    pp,
    accuracy: 0.9876,
    max_combo: 900,
    mods: [],
    beatmap: {
      difficulty_rating: starRating,
      bpm: 180,
      total_length: 120,
      accuracy: 8,
      drain: 6,
      count_circles: 900,
      count_sliders: 0,
      count_spinners: 0,
      max_combo: 900,
      cs: 4,
      ar: 9,
      od: 8,
      hp: 6,
      version: "Test",
    },
  } as OsuScore;
}

describe("buildManiaCardRenderData", () => {
  test("computes one shared dynamic data object for ThreeJS and admin comparison", () => {
    const data = buildManiaCardRenderData({ user, scores: [score(6.2, 420)] });

    expect(data.status).toBe("ready");
    if (data.status !== "ready") throw new Error("expected ready data");
    expect(data.user.id).toBe(123);
    expect(data.user.username).toBe("PlayerWithAVeryLongName");
    expect(data.avatarUrl).toBe("/api/avatar?u=123");
    expect(data.stats).toEqual([
      { label: "Control", value: data.skills.fingerControl },
      { label: "Speed", value: data.skills.speed },
      { label: "Precision", value: data.skills.accuracy },
    ]);
    expect(data.tier).toBeTypeOf("string");
    expect(data.tierStyle.label.length).toBeGreaterThan(0);
  });

  test("returns empty status when no ranked play can mint a card", () => {
    const data = buildManiaCardRenderData({ user, scores: [] });

    expect(data).toEqual({
      status: "empty",
      message: "Need at least one ranked play with full beatmap data to mint a card.",
    });
  });
});

describe("style parsing helpers", () => {
  test("parses rgba tier colors into normalized channels", () => {
    expect(parseCssRgba("rgba(251, 113, 133, 0.4)")).toEqual({
      r: 251,
      g: 113,
      b: 133,
      a: 0.4,
    });
  });

  test("parses badge gradient stops for canvas and shader use", () => {
    expect(parseGradientStops("linear-gradient(142deg, #ff8ec4 0%, #ff3d8a 44%, #b81f68 100%)")).toEqual([
      { color: "#ff8ec4", offset: 0 },
      { color: "#ff3d8a", offset: 0.44 },
      { color: "#b81f68", offset: 1 },
    ]);
  });
});
```

- [ ] **Step 2: Run the test and verify it fails**

Run:

```bash
npm run test -- src/components/player/maniacard3d/renderData.test.ts
```

Expected:

```text
FAIL  src/components/player/maniacard3d/renderData.test.ts
Cannot find module './renderData'
```

- [ ] **Step 3: Add the shared types**

Create `src/components/player/maniacard3d/types.ts`:

```ts
import type { ManiaCardTier, ManiaCardTierStyle, ManiaSkills } from "../../../lib/maniacard";
import type { OsuScore, OsuUser } from "../../../lib/types";

export interface ManiaCardPanelProps {
  user: Pick<OsuUser, "id" | "username" | "avatar_url" | "country_code"> & {
    statistics?: { global_rank: number | null };
  };
  scores: OsuScore[];
  loading: boolean;
}

export interface ManiaCardStat {
  label: "Control" | "Speed" | "Precision";
  value: number;
}

export interface RgbaColor {
  r: number;
  g: number;
  b: number;
  a: number;
}

export interface GradientStop {
  color: string;
  offset: number;
}

export interface ManiaCardReadyData {
  status: "ready";
  user: ManiaCardPanelProps["user"];
  avatarUrl: string;
  scores: OsuScore[];
  skills: ManiaSkills;
  tier: ManiaCardTier;
  tierStyle: ManiaCardTierStyle;
  stats: ManiaCardStat[];
  edgeColor: RgbaColor;
  glowColor: RgbaColor;
  badgeGradientStops: GradientStop[];
}

export interface ManiaCardEmptyData {
  status: "empty";
  message: string;
}

export type ManiaCardRenderData = ManiaCardReadyData | ManiaCardEmptyData;

export interface ManiaCardRenderInput {
  user: ManiaCardPanelProps["user"];
  scores: OsuScore[];
}
```

- [ ] **Step 4: Add the render data implementation**

Create `src/components/player/maniacard3d/renderData.ts`:

```ts
import {
  computeManiaSkills,
  getManiaCardTier,
  MANIA_TIER_STYLES,
} from "../../../lib/maniacard";
import type {
  GradientStop,
  ManiaCardRenderData,
  ManiaCardRenderInput,
  RgbaColor,
} from "./types";

const EMPTY_CARD_MESSAGE = "Need at least one ranked play with full beatmap data to mint a card.";

export function buildManiaCardRenderData({ user, scores }: ManiaCardRenderInput): ManiaCardRenderData {
  const skills = computeManiaSkills(scores);
  if (!skills) {
    return { status: "empty", message: EMPTY_CARD_MESSAGE };
  }

  const tier = getManiaCardTier(skills.cardPower);
  const tierStyle = MANIA_TIER_STYLES[tier];

  return {
    status: "ready",
    user,
    avatarUrl: `/api/avatar?u=${user.id}`,
    scores,
    skills,
    tier,
    tierStyle,
    stats: [
      { label: "Control", value: skills.fingerControl },
      { label: "Speed", value: skills.speed },
      { label: "Precision", value: skills.accuracy },
    ],
    edgeColor: parseCssRgba(tierStyle.edgeFill),
    glowColor: parseCssRgba(tierStyle.glowColor),
    badgeGradientStops: parseGradientStops(tierStyle.badgeGradient),
  };
}

export function parseCssRgba(value: string): RgbaColor {
  const [r = 168, g = 85, b = 247, a = 1] = value.match(/[\d.]+/g)?.map(Number) ?? [];
  return { r, g, b, a };
}

export function parseGradientStops(value: string): GradientStop[] {
  const stopPattern = /(#[0-9a-fA-F]{3,8})\s+([\d.]+)%/g;
  const stops: GradientStop[] = [];
  let match: RegExpExecArray | null;
  while ((match = stopPattern.exec(value)) !== null) {
    stops.push({
      color: match[1]!,
      offset: Number(match[2]) / 100,
    });
  }
  return stops;
}
```

- [ ] **Step 5: Run the render-data test and verify it passes**

Run:

```bash
npm run test -- src/components/player/maniacard3d/renderData.test.ts
```

Expected:

```text
PASS  src/components/player/maniacard3d/renderData.test.ts
```

- [ ] **Step 6: Commit**

```bash
git add src/components/player/maniacard3d/types.ts src/components/player/maniacard3d/renderData.ts src/components/player/maniacard3d/renderData.test.ts
git commit -m "Add shared maniacard render data"
```

---

### Task 3: Add Deterministic Layout Helpers

**Files:**
- Create: `src/components/player/maniacard3d/layout.ts`
- Create: `src/components/player/maniacard3d/layout.test.ts`

- [ ] **Step 1: Write failing layout tests**

Create `src/components/player/maniacard3d/layout.test.ts`:

```ts
import { describe, expect, test } from "vitest";
import {
  CARD_TEXTURE_HEIGHT,
  CARD_TEXTURE_WIDTH,
  buildStarSegments,
  clamp,
  resolveQualityProfile,
  truncateToWidth,
} from "./layout";

describe("layout constants", () => {
  test("uses a fixed 5:7 texture surface", () => {
    expect(CARD_TEXTURE_WIDTH).toBe(1000);
    expect(CARD_TEXTURE_HEIGHT).toBe(1400);
    expect(CARD_TEXTURE_WIDTH / CARD_TEXTURE_HEIGHT).toBeCloseTo(5 / 7, 3);
  });
});

describe("truncateToWidth", () => {
  test("keeps short text unchanged", () => {
    const measure = (text: string) => text.length * 10;
    expect(truncateToWidth("Aleju", 80, measure)).toBe("Aleju");
  });

  test("adds an ellipsis when text is too wide", () => {
    const measure = (text: string) => text.length * 10;
    expect(truncateToWidth("VeryLongPlayerName", 70, measure)).toBe("VeryLo...");
  });
});

describe("buildStarSegments", () => {
  test("maps fractional star average into full half and empty stars", () => {
    expect(buildStarSegments(4.6, 6)).toEqual(["full", "full", "full", "full", "half", "empty"]);
  });
});

describe("resolveQualityProfile", () => {
  test("caps mobile pixel ratio and reduces idle", () => {
    expect(resolveQualityProfile({ mobile: true, reducedMotion: false, devicePixelRatio: 3 })).toEqual({
      pixelRatio: 1.5,
      antialias: true,
      adaptiveIdle: true,
      shaderQuality: "high",
      idleMotion: "wake-on-input",
    });
  });

  test("disables idle motion when reduced motion is requested", () => {
    expect(resolveQualityProfile({ mobile: false, reducedMotion: true, devicePixelRatio: 2 })).toMatchObject({
      pixelRatio: 1,
      shaderQuality: "medium",
      idleMotion: "off",
    });
  });
});

describe("clamp", () => {
  test("bounds values inclusively", () => {
    expect(clamp(-1, 0, 1)).toBe(0);
    expect(clamp(2, 0, 1)).toBe(1);
    expect(clamp(0.5, 0, 1)).toBe(0.5);
  });
});
```

- [ ] **Step 2: Run layout tests and verify they fail**

Run:

```bash
npm run test -- src/components/player/maniacard3d/layout.test.ts
```

Expected:

```text
FAIL  src/components/player/maniacard3d/layout.test.ts
Cannot find module './layout'
```

- [ ] **Step 3: Add layout helpers**

Create `src/components/player/maniacard3d/layout.ts`:

```ts
export const CARD_TEXTURE_WIDTH = 1000;
export const CARD_TEXTURE_HEIGHT = 1400;
export const CARD_ASPECT = CARD_TEXTURE_WIDTH / CARD_TEXTURE_HEIGHT;

export type StarSegment = "full" | "half" | "empty";
export type ShaderQuality = "medium" | "high";
export type IdleMotion = "off" | "continuous" | "wake-on-input";

export interface QualityInput {
  mobile: boolean;
  reducedMotion: boolean;
  devicePixelRatio: number;
}

export interface QualityProfile {
  pixelRatio: number;
  antialias: boolean;
  adaptiveIdle: boolean;
  shaderQuality: ShaderQuality;
  idleMotion: IdleMotion;
}

export function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

export function truncateToWidth(
  text: string,
  maxWidth: number,
  measure: (text: string) => number,
) {
  if (measure(text) <= maxWidth) return text;
  const ellipsis = "...";
  let next = text;
  while (next.length > 0 && measure(`${next}${ellipsis}`) > maxWidth) {
    next = next.slice(0, -1);
  }
  return `${next}${ellipsis}`;
}

export function buildStarSegments(value: number, count = Math.min(10, Math.max(1, Math.ceil(value)))): StarSegment[] {
  return Array.from({ length: count }, (_, index) => {
    const remaining = value - index;
    if (remaining >= 1) return "full";
    if (remaining >= 0.5) return "half";
    return "empty";
  });
}

export function resolveQualityProfile(input: QualityInput): QualityProfile {
  if (input.reducedMotion) {
    return {
      pixelRatio: 1,
      antialias: true,
      adaptiveIdle: true,
      shaderQuality: "medium",
      idleMotion: "off",
    };
  }

  if (input.mobile) {
    return {
      pixelRatio: clamp(input.devicePixelRatio, 1, 1.5),
      antialias: true,
      adaptiveIdle: true,
      shaderQuality: "high",
      idleMotion: "wake-on-input",
    };
  }

  return {
    pixelRatio: clamp(input.devicePixelRatio, 1, 2),
    antialias: true,
    adaptiveIdle: false,
    shaderQuality: "high",
    idleMotion: "continuous",
  };
}
```

- [ ] **Step 4: Run layout tests and verify they pass**

Run:

```bash
npm run test -- src/components/player/maniacard3d/layout.test.ts
```

Expected:

```text
PASS  src/components/player/maniacard3d/layout.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add src/components/player/maniacard3d/layout.ts src/components/player/maniacard3d/layout.test.ts
git commit -m "Add maniacard layout helpers"
```

---

### Task 4: Add Canvas Texture Layout Commands

**Files:**
- Create: `src/components/player/maniacard3d/textureLayout.ts`
- Create: `src/components/player/maniacard3d/textureLayout.test.ts`

- [ ] **Step 1: Write failing texture-layout tests**

Create `src/components/player/maniacard3d/textureLayout.test.ts`:

```ts
import { describe, expect, test } from "vitest";
import { buildFaceLayout, type MeasureText } from "./textureLayout";
import type { ManiaCardReadyData } from "./types";

const measure: MeasureText = (text, size) => text.length * size * 0.55;

const data = {
  status: "ready",
  user: { id: 1, username: "LongLongLongLongLongName", country_code: "US", statistics: { global_rank: 10 } },
  avatarUrl: "/api/avatar?u=1",
  tier: "ultraRare",
  tierStyle: {
    label: "Ultra Rare",
    background: "",
    border: "",
    glow: "",
    edgeFill: "rgba(131, 24, 67, 0.94)",
    glowColor: "rgba(251, 113, 133, 0.4)",
    starColor: "text-amber-300",
    badgeColor: "text-rose-50",
    badgeGradient: "",
    badgeHalo: "rgba(251,113,133,0.58)",
    badgeGlyphShadow: "rgba(88,28,135,0.45)",
  },
  edgeColor: { r: 131, g: 24, b: 67, a: 0.94 },
  glowColor: { r: 251, g: 113, b: 133, a: 0.4 },
  badgeGradientStops: [
    { color: "#ff8ec4", offset: 0 },
    { color: "#ff3d8a", offset: 0.44 },
    { color: "#b81f68", offset: 1 },
  ],
  scores: [],
  skills: {
    starAvg: 6.45,
    fingerControl: 812,
    speed: 744,
    accuracy: 901,
    stamina: 650,
    versatility: 580,
    peak: 820,
    cardPower: 500,
    mainKeyMode: 4,
    archetype: "Hybrid",
    sampleSize: 1,
  },
  stats: [
    { label: "Control", value: 812 },
    { label: "Speed", value: 744 },
    { label: "Precision", value: 901 },
  ],
} as ManiaCardReadyData;

describe("buildFaceLayout", () => {
  test("builds front commands with fitted username and avatar mask metadata", () => {
    const layout = buildFaceLayout(data, measure);

    expect(layout.front.username.text.endsWith("...")).toBe(true);
    expect(layout.front.avatar).toEqual({ x: 185, y: 280, size: 630, radius: 32 });
    expect(layout.masks.avatar).toEqual({ x: 185, y: 280, width: 630, height: 630 });
    expect(layout.front.stats.map((stat) => stat.label)).toEqual(["Control", "Speed", "Precision"]);
  });

  test("builds back commands from the same tier label", () => {
    const layout = buildFaceLayout(data, measure);

    expect(layout.back.rarityLabel).toBe("ULTRA RARE");
    expect(layout.back.logoCenter).toEqual({ x: 500, y: 700 });
  });
});
```

- [ ] **Step 2: Run texture-layout tests and verify they fail**

Run:

```bash
npm run test -- src/components/player/maniacard3d/textureLayout.test.ts
```

Expected:

```text
FAIL  src/components/player/maniacard3d/textureLayout.test.ts
Cannot find module './textureLayout'
```

- [ ] **Step 3: Add texture-layout command builder**

Create `src/components/player/maniacard3d/textureLayout.ts`:

```ts
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
  const username = truncateToWidth(
    data.user.username,
    usernameMaxWidth,
    (text) => measure(text, usernameFontSize, "Torus", 900),
  );

  return {
    front: {
      username: { text: username, x: 310, y: 158, maxWidth: usernameMaxWidth, fontSize: usernameFontSize },
      tierLabel: { text: data.tierStyle.label, x: 930, y: 224, fontSize: 48 },
      avatar: { x: 185, y: 280, size: 630, radius: 32 },
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
      avatar: { x: 185, y: 280, width: 630, height: 630 },
    },
  };
}
```

- [ ] **Step 4: Run texture-layout tests and verify they pass**

Run:

```bash
npm run test -- src/components/player/maniacard3d/textureLayout.test.ts
```

Expected:

```text
PASS  src/components/player/maniacard3d/textureLayout.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add src/components/player/maniacard3d/textureLayout.ts src/components/player/maniacard3d/textureLayout.test.ts
git commit -m "Add maniacard texture layout commands"
```

---

### Task 5: Add Card Geometry

**Files:**
- Create: `src/components/player/maniacard3d/cardGeometry.ts`
- Create: `src/components/player/maniacard3d/cardGeometry.test.ts`

- [ ] **Step 1: Write failing geometry tests**

Create `src/components/player/maniacard3d/cardGeometry.test.ts`:

```ts
import { describe, expect, test } from "vitest";
import { BoxGeometry, PlaneGeometry } from "three";
import { createCardBodyGeometry, createCardFaceGeometry } from "./cardGeometry";
import { CARD_ASPECT } from "./layout";

describe("card geometry", () => {
  test("creates a thin 5:7 card body", () => {
    const geometry = createCardBodyGeometry(3.5);

    expect(geometry).toBeInstanceOf(BoxGeometry);
    geometry.computeBoundingBox();
    const box = geometry.boundingBox;
    if (!box) throw new Error("expected bounding box");
    expect(box.max.x - box.min.x).toBeCloseTo(3.5 * CARD_ASPECT, 3);
    expect(box.max.y - box.min.y).toBeCloseTo(3.5, 3);
    expect(box.max.z - box.min.z).toBeCloseTo(0.08, 3);
  });

  test("creates face planes just above the card body", () => {
    const front = createCardFaceGeometry(3.5);

    expect(front).toBeInstanceOf(PlaneGeometry);
    front.computeBoundingBox();
    const box = front.boundingBox;
    if (!box) throw new Error("expected bounding box");
    expect(box.max.x - box.min.x).toBeCloseTo(3.5 * CARD_ASPECT, 3);
    expect(box.max.y - box.min.y).toBeCloseTo(3.5, 3);
  });
});
```

- [ ] **Step 2: Run geometry tests and verify they fail**

Run:

```bash
npm run test -- src/components/player/maniacard3d/cardGeometry.test.ts
```

Expected:

```text
FAIL  src/components/player/maniacard3d/cardGeometry.test.ts
Cannot find module './cardGeometry'
```

- [ ] **Step 3: Add geometry helpers**

Create `src/components/player/maniacard3d/cardGeometry.ts`:

```ts
import { BoxGeometry, PlaneGeometry } from "three";
import { CARD_ASPECT } from "./layout";

export const CARD_WORLD_HEIGHT = 3.5;
export const CARD_WORLD_THICKNESS = 0.08;
export const FACE_Z_OFFSET = CARD_WORLD_THICKNESS / 2 + 0.003;
export const OVERLAY_Z_OFFSET = CARD_WORLD_THICKNESS / 2 + 0.009;

export function createCardBodyGeometry(height = CARD_WORLD_HEIGHT) {
  return new BoxGeometry(height * CARD_ASPECT, height, CARD_WORLD_THICKNESS, 4, 4, 1);
}

export function createCardFaceGeometry(height = CARD_WORLD_HEIGHT) {
  return new PlaneGeometry(height * CARD_ASPECT, height, 1, 1);
}
```

- [ ] **Step 4: Run geometry tests and verify they pass**

Run:

```bash
npm run test -- src/components/player/maniacard3d/cardGeometry.test.ts
```

Expected:

```text
PASS  src/components/player/maniacard3d/cardGeometry.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add src/components/player/maniacard3d/cardGeometry.ts src/components/player/maniacard3d/cardGeometry.test.ts
git commit -m "Add maniacard 3D geometry helpers"
```

---

### Task 6: Add Canvas Texture Drawing

**Files:**
- Create: `src/components/player/maniacard3d/cardTexture.ts`

- [ ] **Step 1: Add browser-only canvas texture generation**

Create `src/components/player/maniacard3d/cardTexture.ts`:

```ts
import { CanvasTexture, LinearFilter, SRGBColorSpace } from "three";
import { CARD_TEXTURE_HEIGHT, CARD_TEXTURE_WIDTH } from "./layout";
import { buildFaceLayout } from "./textureLayout";
import type { FaceLayout } from "./textureLayout";
import type { ManiaCardReadyData } from "./types";

const FONT = "Torus, Arial, sans-serif";

export interface CardTextureSet {
  frontTexture: CanvasTexture;
  backTexture: CanvasTexture;
  layout: FaceLayout;
  dispose: () => void;
}

export async function createCardTextures(data: ManiaCardReadyData): Promise<CardTextureSet> {
  const frontCanvas = createCanvas();
  const backCanvas = createCanvas();
  const front = getContext(frontCanvas);
  const back = getContext(backCanvas);
  const measure = (text: string, size: number, family: string, weight: number) => {
    front.font = `${weight} ${size}px ${family}`;
    return front.measureText(text).width;
  };
  const layout = buildFaceLayout(data, measure);
  const avatar = await loadImage(data.avatarUrl).catch(() => null);

  drawFront(front, data, layout, avatar);
  drawBack(back, data, layout);

  const frontTexture = toTexture(frontCanvas);
  const backTexture = toTexture(backCanvas);

  return {
    frontTexture,
    backTexture,
    layout,
    dispose: () => {
      frontTexture.dispose();
      backTexture.dispose();
    },
  };
}

function createCanvas() {
  const canvas = document.createElement("canvas");
  canvas.width = CARD_TEXTURE_WIDTH;
  canvas.height = CARD_TEXTURE_HEIGHT;
  return canvas;
}

function getContext(canvas: HTMLCanvasElement) {
  const context = canvas.getContext("2d");
  if (!context) throw new Error("2D canvas is unavailable");
  return context;
}

function toTexture(canvas: HTMLCanvasElement) {
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  texture.minFilter = LinearFilter;
  texture.magFilter = LinearFilter;
  texture.needsUpdate = true;
  return texture;
}

async function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.crossOrigin = "anonymous";
    image.referrerPolicy = "no-referrer";
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error(`Could not load image: ${src}`));
    image.src = src;
  });
}

function drawFront(
  context: CanvasRenderingContext2D,
  data: ManiaCardReadyData,
  layout: FaceLayout,
  avatar: HTMLImageElement | null,
) {
  drawTierBackground(context, data);
  drawTrianglePattern(context, 0.28);
  drawModeBadge(context, data);
  drawUsername(context, layout);
  drawAvatar(context, layout, avatar);
  drawStats(context, layout);
  drawStars(context, layout);
}

function drawBack(context: CanvasRenderingContext2D, data: ManiaCardReadyData, layout: FaceLayout) {
  drawTierBackground(context, data);
  drawTrianglePattern(context, 0.16);
  context.save();
  context.strokeStyle = "rgba(255,255,255,0.55)";
  context.lineWidth = 8;
  roundedRect(context, 86, 80, 828, 1240, 42);
  context.stroke();
  context.beginPath();
  context.arc(layout.back.logoCenter.x, layout.back.logoCenter.y, 176, 0, Math.PI * 2);
  context.fillStyle = "rgba(255,255,255,0.22)";
  context.fill();
  context.lineWidth = 28;
  context.strokeStyle = "rgba(255,255,255,0.92)";
  context.stroke();
  context.font = `900 54px ${FONT}`;
  context.textAlign = "center";
  context.fillStyle = "rgba(255,255,255,0.48)";
  context.fillText(layout.back.rarityLabel, 500, 1255);
  context.restore();
}

function drawTierBackground(context: CanvasRenderingContext2D, data: ManiaCardReadyData) {
  const gradient = context.createLinearGradient(0, 0, CARD_TEXTURE_WIDTH, CARD_TEXTURE_HEIGHT);
  const stops = data.badgeGradientStops.length > 0
    ? data.badgeGradientStops
    : [{ color: "#7c3aed", offset: 0 }, { color: "#1e1b4b", offset: 1 }];
  for (const stop of stops) gradient.addColorStop(stop.offset, stop.color);
  context.fillStyle = gradient;
  context.fillRect(0, 0, CARD_TEXTURE_WIDTH, CARD_TEXTURE_HEIGHT);
}

function drawTrianglePattern(context: CanvasRenderingContext2D, opacity: number) {
  context.save();
  context.globalAlpha = opacity;
  for (let y = -40; y < CARD_TEXTURE_HEIGHT + 80; y += 78) {
    for (let x = -40; x < CARD_TEXTURE_WIDTH + 90; x += 90) {
      context.beginPath();
      context.moveTo(x + 45, y + 8);
      context.lineTo(x + 82, y + 70);
      context.lineTo(x + 8, y + 70);
      context.closePath();
      context.fillStyle = "rgba(255,255,255,0.08)";
      context.fill();
    }
  }
  context.restore();
}

function drawModeBadge(context: CanvasRenderingContext2D, data: ManiaCardReadyData) {
  const gradient = context.createLinearGradient(44, 44, 170, 170);
  for (const stop of data.badgeGradientStops) gradient.addColorStop(stop.offset, stop.color);
  context.save();
  roundedRect(context, 38, 38, 132, 132, 30);
  context.fillStyle = data.badgeGradientStops.length ? gradient : "rgba(255,255,255,0.22)";
  context.fill();
  context.strokeStyle = "rgba(255,255,255,0.35)";
  context.lineWidth = 4;
  context.stroke();
  context.font = `900 48px ${FONT}`;
  context.textAlign = "center";
  context.fillStyle = "white";
  context.fillText("M", 104, 122);
  context.restore();
}

function drawUsername(context: CanvasRenderingContext2D, layout: FaceLayout) {
  context.save();
  roundedRect(context, 244, 76, 640, 104, 24);
  context.fillStyle = "rgba(0,0,0,0.34)";
  context.fill();
  context.font = `900 ${layout.front.username.fontSize}px ${FONT}`;
  context.textAlign = "center";
  context.fillStyle = "white";
  context.fillText(layout.front.username.text, 564, layout.front.username.y);
  context.restore();
}

function drawAvatar(context: CanvasRenderingContext2D, layout: FaceLayout, avatar: HTMLImageElement | null) {
  const box = layout.front.avatar;
  context.save();
  roundedRect(context, box.x - 8, box.y - 8, box.size + 16, box.size + 16, box.radius + 8);
  context.fillStyle = "rgba(255,255,255,0.16)";
  context.fill();
  roundedRect(context, box.x, box.y, box.size, box.size, box.radius);
  context.clip();
  if (avatar) {
    context.drawImage(avatar, box.x, box.y, box.size, box.size);
  } else {
    context.fillStyle = "rgba(0,0,0,0.42)";
    context.fillRect(box.x, box.y, box.size, box.size);
    context.font = `900 120px ${FONT}`;
    context.textAlign = "center";
    context.fillStyle = "rgba(255,255,255,0.64)";
    context.fillText("?", box.x + box.size / 2, box.y + box.size / 2 + 42);
  }
  context.restore();
}

function drawStats(context: CanvasRenderingContext2D, layout: FaceLayout) {
  context.save();
  roundedRect(context, 225, 960, 550, 218, 30);
  context.fillStyle = "rgba(0,0,0,0.30)";
  context.fill();
  context.font = `800 34px ${FONT}`;
  context.fillStyle = "rgba(255,255,255,0.84)";
  for (const stat of layout.front.stats) {
    context.textAlign = "left";
    context.fillText(`${stat.label}:`, stat.x, stat.y);
    context.textAlign = "right";
    context.font = `900 48px ${FONT}`;
    context.fillStyle = "white";
    context.fillText(String(stat.value), 720, stat.y);
    context.font = `800 34px ${FONT}`;
    context.fillStyle = "rgba(255,255,255,0.84)";
  }
  context.restore();
}

function drawStars(context: CanvasRenderingContext2D, layout: FaceLayout) {
  context.save();
  context.textAlign = "center";
  context.font = `900 42px ${FONT}`;
  context.fillStyle = "#fcd34d";
  context.fillText(layout.front.stars.map((star) => star === "empty" ? "☆" : "★").join(" "), 500, 1252);
  context.font = `800 24px ${FONT}`;
  context.fillStyle = "rgba(255,255,255,0.62)";
  context.fillText(layout.front.starAverage, 500, 1292);
  context.restore();
}

function roundedRect(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
) {
  context.beginPath();
  context.moveTo(x + radius, y);
  context.arcTo(x + width, y, x + width, y + height, radius);
  context.arcTo(x + width, y + height, x, y + height, radius);
  context.arcTo(x, y + height, x, y, radius);
  context.arcTo(x, y, x + width, y, radius);
  context.closePath();
}
```

- [ ] **Step 2: Verify existing pure layout tests still pass**

Run:

```bash
npm run test -- src/components/player/maniacard3d/layout.test.ts src/components/player/maniacard3d/textureLayout.test.ts
```

Expected:

```text
PASS  src/components/player/maniacard3d/layout.test.ts
PASS  src/components/player/maniacard3d/textureLayout.test.ts
```

- [ ] **Step 3: Commit**

```bash
git add src/components/player/maniacard3d/cardTexture.ts
git commit -m "Add dynamic maniacard canvas textures"
```

---

### Task 7: Add Materials and Shaders

**Files:**
- Create: `src/components/player/maniacard3d/cardShaders.ts`
- Create: `src/components/player/maniacard3d/cardMaterials.ts`

- [ ] **Step 1: Add shader strings**

Create `src/components/player/maniacard3d/cardShaders.ts`:

```ts
export const cardOverlayVertexShader = `
varying vec2 vUv;

void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

export const cardOverlayFragmentShader = `
precision highp float;

uniform float uTime;
uniform float uIntensity;
uniform vec2 uLight;
uniform vec3 uTierColor;
uniform vec4 uAvatarMask;
varying vec2 vUv;

vec3 screen(vec3 base, vec3 blend) {
  return 1.0 - (1.0 - base) * (1.0 - blend);
}

float diagonalBands(vec2 uv, float offset) {
  float coord = uv.x * 1.25 + uv.y * 0.72 + offset;
  return smoothstep(0.08, 0.16, fract(coord * 8.0)) * (1.0 - smoothstep(0.18, 0.34, fract(coord * 8.0)));
}

void main() {
  vec2 light = clamp(uLight, vec2(0.0), vec2(1.0));
  float dist = distance(vUv, light);
  float glare = 1.0 - smoothstep(0.0, 0.62, dist);
  float bands = diagonalBands(vUv, uTime * 0.035 + light.x * 0.22);
  vec3 rainbow = 0.5 + 0.5 * cos(6.28318 * (vec3(0.0, 0.33, 0.67) + vUv.x + vUv.y + uTime * 0.025));
  vec3 holo = screen(uTierColor * 0.55, rainbow) * bands;

  vec2 avatarMin = uAvatarMask.xy;
  vec2 avatarMax = uAvatarMask.xy + uAvatarMask.zw;
  float inAvatar = step(avatarMin.x, vUv.x) * step(avatarMin.y, vUv.y) * step(vUv.x, avatarMax.x) * step(vUv.y, avatarMax.y);
  float avatarShine = inAvatar * glare * 0.28;

  vec3 color = holo * (0.32 + glare * 0.72) + vec3(glare * 0.42) + vec3(avatarShine);
  float alpha = clamp((bands * 0.22 + glare * 0.28 + avatarShine) * uIntensity, 0.0, 0.72);
  gl_FragColor = vec4(color, alpha);
}
`;
```

- [ ] **Step 2: Add material helpers**

Create `src/components/player/maniacard3d/cardMaterials.ts`:

```ts
import {
  Color,
  MeshBasicMaterial,
  MeshStandardMaterial,
  ShaderMaterial,
  Texture,
  Vector2,
  Vector3,
  Vector4,
} from "three";
import { CARD_TEXTURE_HEIGHT, CARD_TEXTURE_WIDTH } from "./layout";
import { cardOverlayFragmentShader, cardOverlayVertexShader } from "./cardShaders";
import type { FaceLayout } from "./textureLayout";
import type { ManiaCardReadyData } from "./types";

export function createEdgeMaterial(data: ManiaCardReadyData) {
  return new MeshStandardMaterial({
    color: new Color(data.edgeColor.r / 255, data.edgeColor.g / 255, data.edgeColor.b / 255),
    roughness: 0.36,
    metalness: 0.18,
  });
}

export function createFaceMaterial(texture: Texture) {
  return new MeshBasicMaterial({
    map: texture,
    transparent: false,
    toneMapped: false,
  });
}

export function createOverlayMaterial(data: ManiaCardReadyData, layout: FaceLayout) {
  const avatar = layout.masks.avatar;
  return new ShaderMaterial({
    transparent: true,
    depthWrite: false,
    vertexShader: cardOverlayVertexShader,
    fragmentShader: cardOverlayFragmentShader,
    uniforms: {
      uTime: { value: 0 },
      uIntensity: { value: 0.88 },
      uLight: { value: new Vector2(0.5, 0.38) },
      uTierColor: { value: new Vector3(data.glowColor.r / 255, data.glowColor.g / 255, data.glowColor.b / 255) },
      uAvatarMask: {
        value: new Vector4(
          avatar.x / CARD_TEXTURE_WIDTH,
          1 - (avatar.y + avatar.height) / CARD_TEXTURE_HEIGHT,
          avatar.width / CARD_TEXTURE_WIDTH,
          avatar.height / CARD_TEXTURE_HEIGHT,
        ),
      },
    },
  });
}
```

- [ ] **Step 3: Verify TypeScript and tests**

Run:

```bash
npm run test -- src/components/player/maniacard3d
```

Expected:

```text
PASS  src/components/player/maniacard3d/renderData.test.ts
PASS  src/components/player/maniacard3d/layout.test.ts
PASS  src/components/player/maniacard3d/textureLayout.test.ts
PASS  src/components/player/maniacard3d/cardGeometry.test.ts
```

- [ ] **Step 4: Commit**

```bash
git add src/components/player/maniacard3d/cardShaders.ts src/components/player/maniacard3d/cardMaterials.ts
git commit -m "Add maniacard shader materials"
```

---

### Task 8: Add Interaction Controller

**Files:**
- Create: `src/components/player/maniacard3d/interactions.ts`
- Create: `src/components/player/maniacard3d/interactions.test.ts`

- [ ] **Step 1: Write failing interaction tests**

Create `src/components/player/maniacard3d/interactions.test.ts`:

```ts
import { describe, expect, test } from "vitest";
import {
  createInteractionState,
  pointerToLight,
  pointerToRotation,
  settleRotation,
} from "./interactions";

describe("pointerToRotation", () => {
  test("maps pointer delta into bounded card rotation", () => {
    expect(pointerToRotation({ deltaX: 100, deltaY: -100 })).toEqual({
      x: 22,
      y: 35,
    });
  });
});

describe("pointerToLight", () => {
  test("maps rotation into normalized shader light coordinates", () => {
    expect(pointerToLight({ x: 22, y: 35 })).toEqual({
      x: 0.36,
      y: 0.82,
    });
  });
});

describe("settleRotation", () => {
  test("eases rotation toward rest", () => {
    expect(settleRotation({ x: 10, y: -10 }, 0.5)).toEqual({ x: 5, y: -5 });
  });
});

describe("createInteractionState", () => {
  test("starts at rest on the front side", () => {
    expect(createInteractionState()).toEqual({
      dragging: false,
      flipped: false,
      rotation: { x: 0, y: 0 },
      targetRotation: { x: 0, y: 0 },
      light: { x: 0.5, y: 0.38 },
      lastInputAt: 0,
    });
  });
});
```

- [ ] **Step 2: Run interaction tests and verify they fail**

Run:

```bash
npm run test -- src/components/player/maniacard3d/interactions.test.ts
```

Expected:

```text
FAIL  src/components/player/maniacard3d/interactions.test.ts
Cannot find module './interactions'
```

- [ ] **Step 3: Add interaction helpers**

Create `src/components/player/maniacard3d/interactions.ts`:

```ts
import { clamp } from "./layout";

export interface Rotation2D {
  x: number;
  y: number;
}

export interface Light2D {
  x: number;
  y: number;
}

export interface InteractionState {
  dragging: boolean;
  flipped: boolean;
  rotation: Rotation2D;
  targetRotation: Rotation2D;
  light: Light2D;
  lastInputAt: number;
}

export function createInteractionState(): InteractionState {
  return {
    dragging: false,
    flipped: false,
    rotation: { x: 0, y: 0 },
    targetRotation: { x: 0, y: 0 },
    light: { x: 0.5, y: 0.38 },
    lastInputAt: 0,
  };
}

export function pointerToRotation(delta: { deltaX: number; deltaY: number }): Rotation2D {
  return {
    x: Math.round(clamp(-delta.deltaY * 0.22, -24, 24)),
    y: Math.round(clamp(delta.deltaX * 0.35, -180, 180)),
  };
}

export function pointerToLight(rotation: Rotation2D): Light2D {
  return {
    x: Number(clamp(0.5 - rotation.y * 0.004, 0.08, 0.92).toFixed(2)),
    y: Number(clamp(0.38 + rotation.x * 0.02, 0.1, 0.9).toFixed(2)),
  };
}

export function settleRotation(rotation: Rotation2D, factor: number): Rotation2D {
  return {
    x: Number((rotation.x * (1 - factor)).toFixed(3)),
    y: Number((rotation.y * (1 - factor)).toFixed(3)),
  };
}
```

- [ ] **Step 4: Run interaction tests and verify they pass**

Run:

```bash
npm run test -- src/components/player/maniacard3d/interactions.test.ts
```

Expected:

```text
PASS  src/components/player/maniacard3d/interactions.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add src/components/player/maniacard3d/interactions.ts src/components/player/maniacard3d/interactions.test.ts
git commit -m "Add maniacard interaction helpers"
```

---

### Task 9: Add the ThreeJS Renderer

**Files:**
- Create: `src/components/player/maniacard3d/ManiaCardRenderer.ts`

- [ ] **Step 1: Add renderer controller**

Create `src/components/player/maniacard3d/ManiaCardRenderer.ts`:

```ts
import {
  AmbientLight,
  Group,
  Mesh,
  PerspectiveCamera,
  Scene,
  WebGLRenderer,
} from "three";
import { createCardBodyGeometry, createCardFaceGeometry, FACE_Z_OFFSET, OVERLAY_Z_OFFSET } from "./cardGeometry";
import { createEdgeMaterial, createFaceMaterial, createOverlayMaterial } from "./cardMaterials";
import { createCardTextures, type CardTextureSet } from "./cardTexture";
import { resolveQualityProfile, type QualityProfile } from "./layout";
import { createInteractionState, pointerToLight, pointerToRotation, settleRotation, type InteractionState } from "./interactions";
import type { ManiaCardReadyData } from "./types";

export interface ManiaCardRendererOptions {
  host: HTMLElement;
  data: ManiaCardReadyData;
  mobile: boolean;
  reducedMotion: boolean;
  devicePixelRatio: number;
}

export class ManiaCardRenderer {
  private readonly host: HTMLElement;
  private readonly renderer: WebGLRenderer;
  private readonly scene = new Scene();
  private readonly camera = new PerspectiveCamera(35, 5 / 7, 0.1, 100);
  private readonly group = new Group();
  private readonly quality: QualityProfile;
  private readonly interaction: InteractionState = createInteractionState();
  private textures: CardTextureSet | null = null;
  private frameId: number | null = null;
  private disposed = false;
  private dragStart: { x: number; y: number } | null = null;
  private overlay: Mesh | null = null;

  constructor(options: ManiaCardRendererOptions) {
    this.host = options.host;
    this.quality = resolveQualityProfile({
      mobile: options.mobile,
      reducedMotion: options.reducedMotion,
      devicePixelRatio: options.devicePixelRatio,
    });
    this.renderer = new WebGLRenderer({ antialias: this.quality.antialias, alpha: true });
    this.renderer.setPixelRatio(this.quality.pixelRatio);
    this.renderer.setSize(this.host.clientWidth, this.host.clientHeight, false);
    this.host.appendChild(this.renderer.domElement);
    this.camera.position.set(0, 0, 7);
    this.scene.add(new AmbientLight(0xffffff, 1.4));
    this.scene.add(this.group);
    this.attachPointerEvents();
    void this.setData(options.data);
  }

  async setData(data: ManiaCardReadyData) {
    const textures = await createCardTextures(data);
    if (this.disposed) {
      textures.dispose();
      return;
    }

    this.textures?.dispose();
    this.textures = textures;
    this.clearGroup();

    const body = new Mesh(createCardBodyGeometry(), createEdgeMaterial(data));
    const front = new Mesh(createCardFaceGeometry(), createFaceMaterial(textures.frontTexture));
    front.position.z = FACE_Z_OFFSET;

    const back = new Mesh(createCardFaceGeometry(), createFaceMaterial(textures.backTexture));
    back.position.z = -FACE_Z_OFFSET;
    back.rotation.y = Math.PI;

    this.overlay = new Mesh(createCardFaceGeometry(), createOverlayMaterial(data, textures.layout));
    this.overlay.position.z = OVERLAY_Z_OFFSET;

    this.group.add(body, front, back, this.overlay);
    this.start();
  }

  resize() {
    const width = Math.max(1, this.host.clientWidth);
    const height = Math.max(1, this.host.clientHeight);
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
  }

  dispose() {
    this.disposed = true;
    if (this.frameId !== null) cancelAnimationFrame(this.frameId);
    this.detachPointerEvents();
    this.textures?.dispose();
    this.group.traverse((object) => {
      const mesh = object as Mesh;
      if (mesh.geometry) mesh.geometry.dispose();
      const materials = Array.isArray(mesh.material) ? mesh.material : mesh.material ? [mesh.material] : [];
      for (const material of materials) material.dispose();
    });
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }

  private clearGroup() {
    while (this.group.children.length > 0) {
      const child = this.group.children[0];
      if (!child) continue;
      this.group.remove(child);
      const mesh = child as Mesh;
      if (mesh.geometry) mesh.geometry.dispose();
      const materials = Array.isArray(mesh.material) ? mesh.material : mesh.material ? [mesh.material] : [];
      for (const material of materials) material.dispose();
    }
  }

  private start() {
    if (this.frameId !== null) return;
    const tick = (time: number) => {
      if (this.disposed) return;
      this.frameId = requestAnimationFrame(tick);
      this.tick(time * 0.001);
    };
    this.frameId = requestAnimationFrame(tick);
  }

  private tick(time: number) {
    if (!this.interaction.dragging && this.quality.idleMotion !== "continuous") {
      this.interaction.rotation = settleRotation(this.interaction.rotation, 0.08);
    } else if (this.quality.idleMotion === "continuous") {
      this.interaction.rotation.x += Math.sin(time * 0.9) * 0.005;
      this.interaction.rotation.y += Math.sin(time * 0.7) * 0.01;
    }

    const frontFacingOffset = this.interaction.flipped ? Math.PI : 0;
    this.group.rotation.x = (this.interaction.rotation.x * Math.PI) / 180;
    this.group.rotation.y = frontFacingOffset + (this.interaction.rotation.y * Math.PI) / 180;

    if (this.overlay?.material && "uniforms" in this.overlay.material) {
      const uniforms = this.overlay.material.uniforms;
      uniforms.uTime.value = time;
      uniforms.uLight.value.set(this.interaction.light.x, this.interaction.light.y);
    }

    this.renderer.render(this.scene, this.camera);
  }

  private onPointerDown = (event: PointerEvent) => {
    this.dragStart = { x: event.clientX, y: event.clientY };
    this.interaction.dragging = true;
    this.renderer.domElement.setPointerCapture(event.pointerId);
  };

  private onPointerMove = (event: PointerEvent) => {
    if (!this.dragStart) return;
    const rotation = pointerToRotation({
      deltaX: event.clientX - this.dragStart.x,
      deltaY: event.clientY - this.dragStart.y,
    });
    this.interaction.rotation = rotation;
    this.interaction.light = pointerToLight(rotation);
    this.interaction.lastInputAt = performance.now();
  };

  private onPointerUp = (event: PointerEvent) => {
    if (this.renderer.domElement.hasPointerCapture(event.pointerId)) {
      this.renderer.domElement.releasePointerCapture(event.pointerId);
    }
    if (this.dragStart) {
      const dx = Math.abs(event.clientX - this.dragStart.x);
      const dy = Math.abs(event.clientY - this.dragStart.y);
      if (dx < 8 && dy < 8) this.interaction.flipped = !this.interaction.flipped;
    }
    this.dragStart = null;
    this.interaction.dragging = false;
  };

  private attachPointerEvents() {
    this.renderer.domElement.addEventListener("pointerdown", this.onPointerDown);
    this.renderer.domElement.addEventListener("pointermove", this.onPointerMove);
    this.renderer.domElement.addEventListener("pointerup", this.onPointerUp);
    this.renderer.domElement.addEventListener("pointercancel", this.onPointerUp);
  }

  private detachPointerEvents() {
    this.renderer.domElement.removeEventListener("pointerdown", this.onPointerDown);
    this.renderer.domElement.removeEventListener("pointermove", this.onPointerMove);
    this.renderer.domElement.removeEventListener("pointerup", this.onPointerUp);
    this.renderer.domElement.removeEventListener("pointercancel", this.onPointerUp);
  }
}
```

- [ ] **Step 2: Run focused tests**

Run:

```bash
npm run test -- src/components/player/maniacard3d
```

Expected:

```text
PASS  src/components/player/maniacard3d/renderData.test.ts
PASS  src/components/player/maniacard3d/layout.test.ts
PASS  src/components/player/maniacard3d/textureLayout.test.ts
PASS  src/components/player/maniacard3d/cardGeometry.test.ts
PASS  src/components/player/maniacard3d/interactions.test.ts
```

- [ ] **Step 3: Commit**

```bash
git add src/components/player/maniacard3d/ManiaCardRenderer.ts
git commit -m "Add ThreeJS maniacard renderer"
```

---

### Task 10: Add React ThreeJS Panel

**Files:**
- Create: `src/components/player/maniacard3d/ManiaCard3DPanel.tsx`

- [ ] **Step 1: Add the React wrapper**

Create `src/components/player/maniacard3d/ManiaCard3DPanel.tsx`:

```tsx
import { useEffect, useMemo, useRef, useState } from "react";
import { buildManiaCardRenderData } from "./renderData";
import { ManiaCardRenderer } from "./ManiaCardRenderer";
import type { ManiaCardPanelProps } from "./types";

function useReducedMotion() {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReduced(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  return reduced;
}

function isMobileViewport() {
  return typeof window !== "undefined" && window.matchMedia("(max-width: 640px)").matches;
}

export function ManiaCard3DPanel({ user, scores, loading }: ManiaCardPanelProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const rendererRef = useRef<ManiaCardRenderer | null>(null);
  const reducedMotion = useReducedMotion();
  const data = useMemo(() => buildManiaCardRenderData({ user, scores }), [user, scores]);

  useEffect(() => {
    if (loading || data.status !== "ready") return;
    const host = hostRef.current;
    if (!host) return;

    const renderer = new ManiaCardRenderer({
      host,
      data,
      mobile: isMobileViewport(),
      reducedMotion,
      devicePixelRatio: window.devicePixelRatio || 1,
    });
    rendererRef.current = renderer;

    const resize = new ResizeObserver(() => renderer.resize());
    resize.observe(host);
    renderer.resize();

    return () => {
      resize.disconnect();
      renderer.dispose();
      if (rendererRef.current === renderer) rendererRef.current = null;
    };
  }, [data, loading, reducedMotion]);

  if (loading) return <ManiaCard3DLoading />;

  if (data.status === "empty") {
    return (
      <div className="max-w-[640px] mx-auto py-12 text-center text-sm text-osu-f1">
        {data.message}
      </div>
    );
  }

  return (
    <div className="py-4 sm:py-6">
      <div className="mx-auto w-full max-w-[440px] px-2">
        <div
          ref={hostRef}
          className="relative w-full overflow-visible"
          style={{ aspectRatio: "5 / 7" }}
          aria-label={`${data.user.username} ${data.tierStyle.label} Maniacard. Control ${data.skills.fingerControl}, Speed ${data.skills.speed}, Precision ${data.skills.accuracy}.`}
        />
      </div>
    </div>
  );
}

function ManiaCard3DLoading() {
  return (
    <div className="py-4 sm:py-6">
      <div className="max-w-[440px] mx-auto px-2">
        <div
          className="relative rounded-[22px] border-2 border-osu-b3/30 bg-osu-b4/40"
          style={{ aspectRatio: "5 / 7" }}
        >
          <div className="absolute inset-0 rounded-[22px] animate-pulse" />
        </div>
        <div className="mt-4 text-center text-[11px] text-osu-f1">Calculating skills...</div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Run focused tests**

Run:

```bash
npm run test -- src/components/player/maniacard3d
```

Expected:

```text
PASS  src/components/player/maniacard3d/renderData.test.ts
PASS  src/components/player/maniacard3d/layout.test.ts
PASS  src/components/player/maniacard3d/textureLayout.test.ts
PASS  src/components/player/maniacard3d/cardGeometry.test.ts
PASS  src/components/player/maniacard3d/interactions.test.ts
```

- [ ] **Step 3: Commit**

```bash
git add src/components/player/maniacard3d/ManiaCard3DPanel.tsx
git commit -m "Add React wrapper for ThreeJS maniacard"
```

---

### Task 11: Make `ManiaCardPanel` the Shared Production Object

**Files:**
- Modify: `src/components/player/ManiaCard.tsx`

- [ ] **Step 1: Rename the current CSS export and add the ThreeJS export**

In `src/components/player/ManiaCard.tsx`:

1. Add this import near the top:

```ts
import { ManiaCard3DPanel } from "./maniacard3d/ManiaCard3DPanel";
```

2. Replace:

```ts
export function ManiaCardPanel({ user, scores, loading }: ManiaCardPanelProps) {
```

with:

```ts
export function ManiaCardPanel(props: ManiaCardPanelProps) {
  return <ManiaCard3DPanel {...props} />;
}

export function CssManiaCardPanel({ user, scores, loading }: ManiaCardPanelProps) {
```

3. Keep the rest of the old function body under `CssManiaCardPanel`.

4. Keep the existing type export at the bottom:

```ts
export type { ManiaSkills, ManiaCardTier };
```

- [ ] **Step 2: Run focused tests**

Run:

```bash
npm run test -- src/components/player/maniacard3d
```

Expected:

```text
PASS  src/components/player/maniacard3d/renderData.test.ts
PASS  src/components/player/maniacard3d/layout.test.ts
PASS  src/components/player/maniacard3d/textureLayout.test.ts
PASS  src/components/player/maniacard3d/cardGeometry.test.ts
PASS  src/components/player/maniacard3d/interactions.test.ts
```

- [ ] **Step 3: Commit**

```bash
git add src/components/player/ManiaCard.tsx
git commit -m "Route maniacard panel through ThreeJS renderer"
```

---

### Task 12: Add Admin Old/New Comparison Without Forking Production Card

**Files:**
- Modify: `src/routes/admin/maniacard.tsx`

- [ ] **Step 1: Update imports**

Replace:

```ts
import { ManiaCardPanel } from "../../components/player/ManiaCard";
```

with:

```ts
import { CssManiaCardPanel, ManiaCardPanel } from "../../components/player/ManiaCard";
```

- [ ] **Step 2: Replace the preview section**

Replace the single-card `<section>` at lines around `115-134` with:

```tsx
<section className="rounded-lg border border-osu-b3/30 bg-osu-b4/35 px-3 py-5 sm:px-5">
  {error ? (
    <div className="py-16 text-center">
      <div className="text-sm font-bold text-osu-red">Could not load maniacard</div>
      <div className="mt-2 text-sm text-osu-f1">{error}</div>
    </div>
  ) : (
    <div className="grid gap-5 xl:grid-cols-2">
      <div>
        <div className="mb-3 text-center text-[11px] font-black uppercase tracking-[0.16em] text-osu-f1">
          CSS reference
        </div>
        {user ? (
          <CssManiaCardPanel user={user} scores={scores} loading={loading} />
        ) : (
          <CssManiaCardPanel
            user={{
              id: 0,
              username: player,
            } as OsuUser}
            scores={[]}
            loading
          />
        )}
      </div>
      <div>
        <div className="mb-3 text-center text-[11px] font-black uppercase tracking-[0.16em] text-osu-yellow">
          ThreeJS production
        </div>
        {user ? (
          <ManiaCardPanel user={user} scores={scores} loading={loading} />
        ) : (
          <ManiaCardPanel
            user={{
              id: 0,
              username: player,
            } as OsuUser}
            scores={[]}
            loading
          />
        )}
      </div>
    </div>
  )}
</section>
```

This keeps `/admin/maniacard` and `/player/...` synced because both use `ManiaCardPanel` for the ThreeJS production card. Admin only adds the CSS reference beside it.

- [ ] **Step 3: Update helper copy**

Replace the aside text at lines around `164-166` with:

```tsx
<div className="mt-5 border-t border-osu-b3/30 pt-4 text-xs leading-relaxed text-osu-f1">
  The ThreeJS column is the same shared <code>ManiaCardPanel</code> used by profile pages. The CSS column is only a reference while tuning the new renderer.
</div>
```

- [ ] **Step 4: Run build verification**

Run:

```bash
npm run build
```

Expected:

```text
✓ built
```

- [ ] **Step 5: Commit**

```bash
git add src/routes/admin/maniacard.tsx
git commit -m "Compare CSS and ThreeJS maniacards in admin"
```

---

### Task 13: Add Gyroscope Support

**Files:**
- Modify: `src/components/player/maniacard3d/ManiaCardRenderer.ts`
- Modify: `src/components/player/maniacard3d/interactions.ts`
- Modify: `src/components/player/maniacard3d/interactions.test.ts`

- [ ] **Step 1: Add failing gyroscope normalization tests**

Update the first import in `src/components/player/maniacard3d/interactions.test.ts` so it includes `orientationToRotation`:

```ts
import {
  createInteractionState,
  orientationToRotation,
  pointerToLight,
  pointerToRotation,
  settleRotation,
} from "./interactions";
```

Then append this test block:

```ts

describe("orientationToRotation", () => {
  test("normalizes device beta and gamma into bounded card rotation", () => {
    expect(orientationToRotation({ beta: 55, gamma: 8, restBeta: 45 })).toEqual({
      x: -10,
      y: -8,
    });
  });
});
```

- [ ] **Step 2: Run interaction tests and verify they fail**

Run:

```bash
npm run test -- src/components/player/maniacard3d/interactions.test.ts
```

Expected:

```text
FAIL  src/components/player/maniacard3d/interactions.test.ts
orientationToRotation is not a function
```

- [ ] **Step 3: Add orientation helper**

Append to `src/components/player/maniacard3d/interactions.ts`:

```ts
export function orientationToRotation(input: { beta: number; gamma: number; restBeta: number }): Rotation2D {
  const x = clamp(-(input.beta - input.restBeta), -24, 24);
  const y = clamp(-input.gamma, -24, 24);
  return {
    x: Math.round(x),
    y: Math.round(y),
  };
}
```

- [ ] **Step 4: Wire device orientation into renderer**

In `src/components/player/maniacard3d/ManiaCardRenderer.ts`, import `orientationToRotation`:

```ts
import { createInteractionState, orientationToRotation, pointerToLight, pointerToRotation, settleRotation, type InteractionState } from "./interactions";
```

Add fields to the class:

```ts
private restBeta: number | null = null;
```

Add this method:

```ts
private onDeviceOrientation = (event: DeviceOrientationEvent) => {
  if (event.beta == null || event.gamma == null) return;
  if (this.restBeta === null) this.restBeta = event.beta;
  const rotation = orientationToRotation({
    beta: event.beta,
    gamma: event.gamma,
    restBeta: this.restBeta,
  });
  if (this.interaction.dragging) return;
  this.interaction.rotation = rotation;
  this.interaction.light = pointerToLight(rotation);
  this.interaction.lastInputAt = performance.now();
};
```

Add in the constructor after pointer setup:

```ts
if (options.mobile && typeof window !== "undefined" && "DeviceOrientationEvent" in window) {
  window.addEventListener("deviceorientation", this.onDeviceOrientation);
}
```

Add in `dispose()`:

```ts
window.removeEventListener("deviceorientation", this.onDeviceOrientation);
```

- [ ] **Step 5: Run interaction tests and build**

Run:

```bash
npm run test -- src/components/player/maniacard3d/interactions.test.ts
npm run build
```

Expected:

```text
PASS  src/components/player/maniacard3d/interactions.test.ts
✓ built
```

- [ ] **Step 6: Commit**

```bash
git add src/components/player/maniacard3d/ManiaCardRenderer.ts src/components/player/maniacard3d/interactions.ts src/components/player/maniacard3d/interactions.test.ts
git commit -m "Add mobile gyro input to maniacard"
```

---

### Task 14: Final Verification and Manual Tuning Pass

**Files:**
- Modify: `src/components/player/maniacard3d/cardTexture.ts` only when face layout or static drawing differs from the CSS reference.
- Modify: `src/components/player/maniacard3d/cardShaders.ts` only when holo, glare, foil color, opacity, or banding differs from the CSS reference.
- Modify: `src/components/player/maniacard3d/ManiaCardRenderer.ts` only when camera distance, tilt rate, flip timing, or idle motion differs from the desired physical behavior.

- [ ] **Step 1: Run all tests**

Run:

```bash
npm run test
```

Expected:

```text
Test Files  ... passed
Tests       ... passed
```

- [ ] **Step 2: Run production build**

Run:

```bash
npm run build
```

Expected:

```text
✓ built
```

- [ ] **Step 3: Start dev server**

Run:

```bash
npm run dev
```

Expected:

```text
Local:   http://localhost:3000/
```

- [ ] **Step 4: Manual visual checks**

Open:

```text
http://localhost:3000/admin/maniacard
```

Verify:

- CSS reference and ThreeJS production card use the same player and score data.
- ThreeJS card has a 5:7 silhouette, front, back, thickness, and tier edge color.
- Username, avatar, Control, Speed, Precision, star average, and tier label match the CSS card content.
- Clicking/tapping flips between front and back.
- Dragging tilts the card and moves the foil/glare light.
- Profile route renders the same ThreeJS production object:

```text
http://localhost:3000/player/Anthony2308
```

- [ ] **Step 5: Tune only scoped visual constants**

If visual parity needs adjustment, edit only:

- `src/components/player/maniacard3d/cardTexture.ts` for canvas layout, text positions, avatar size, back design, and static face styling.
- `src/components/player/maniacard3d/cardShaders.ts` for holo, glare, foil color, opacity, and banding.
- `src/components/player/maniacard3d/ManiaCardRenderer.ts` for camera distance, card size, tilt rate, and idle motion.

After each tuning edit, rerun:

```bash
npm run build
```

Expected:

```text
✓ built
```

- [ ] **Step 6: Commit final tuning**

```bash
git add src/components/player/maniacard3d src/components/player/ManiaCard.tsx src/routes/admin/maniacard.tsx package.json package-lock.json
git commit -m "Tune ThreeJS maniacard renderer"
```
