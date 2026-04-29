# Dan Estimator Refactor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Refactor the Aleju dan estimator into focused modules without changing classifier behavior.

**Architecture:** Keep `estimateDan(map, input)` as the public API in `src/lib/dan-estimator.ts`. Move types, math helpers, label mapping, feature extraction, scoring, family choice, and dan-course handling into separate sibling modules under `src/lib/dan-estimator/`. Existing tests remain golden coverage; each task must run `npm run test -- src/lib/dan-estimator.test.ts`.

**Tech Stack:** TypeScript, Vitest, existing osu!mania beatmap parser types.

---

### Task 1: Extract Shared Types And Labels

**Files:**
- Create: `src/lib/dan-estimator/types.ts`
- Create: `src/lib/dan-estimator/labels.ts`
- Modify: `src/lib/dan-estimator.ts`
- Test: `src/lib/dan-estimator.test.ts`

- [x] **Step 1: Create type module**

Move the exported type/interface declarations from the top of `src/lib/dan-estimator.ts` into `src/lib/dan-estimator/types.ts`:

```ts
import type { ManiaNote } from "../beatmap-parser";

export type DanSkillFamily = "jack" | "stream" | "handstream" | "stamina" | "chordjack" | "tech" | "dan";
export type DanPrimaryFamily = Exclude<DanSkillFamily, "dan">;

export interface DanEstimateInput {
  starRating?: number;
  totalLength?: number;
  title?: string;
  version?: string;
  rate?: number;
}

export interface DanEstimate {
  label: string;
  variant: string | null;
  displayName: string;
  rawDan: number;
  estimatedSr: number;
  family: DanSkillFamily;
  confidence: number;
  metrics: DanFeatureMetrics;
  skillScores: Record<DanSkillFamily, number>;
  warnings: string[];
  debug?: DanEstimateDebug;
}

export interface DanFeatureMetrics {
  keyCount: number;
  noteCount: number;
  holdRatio: number;
  chordRatio: number;
  peakNps1s: number;
  peakNps5s: number;
  sustainedNps10s: number;
  jackPressure: number;
  streamPressure: number;
  chordjackPressure: number;
  techPressure: number;
  rowBurstPressure: number;
  fastRowRatio: number;
  rowIntervalEntropy: number;
  patternVariety: number;
  strainSpikiness: number;
  sustainedPressureRatio: number;
  anchorPressure: number;
  lnReleasePressure: number;
  chordSizeChangeRate: number;
  directionChangeRate: number;
  staminaPressure: number;
}

export interface DanEstimateDebug {
  scoring: DanScoringDebug;
  familyChoice: DanFamilyChoiceDebug;
}

export interface DanScoringDebug {
  densitySr: number;
  staminaSr: number;
  structuralSr: number;
  base: number;
  lnNerf: number;
  gates: Record<string, number>;
  terms: Record<string, number>;
  contributions: Record<DanSkillFamily, DanScoreContribution[]>;
}

export interface DanScoreContribution {
  id: string;
  value: number;
  description: string;
}

export interface DanFamilyChoiceDebug {
  topFamily: DanPrimaryFamily;
  topScore: number;
  selectedFamily: DanPrimaryFamily;
  reason: string;
}

export interface DanFeatureExtractionResult {
  notes: ManiaNote[];
  noteTimes: number[];
  durationMs: number;
  orderedRows: Array<[number, ManiaNote[]]>;
  metrics: DanFeatureMetrics;
  warnings: string[];
}
```

- [x] **Step 2: Create label module**

Move `DAN_LABELS`, `MAX_SUPPORTED_DAN_INDEX`, `DAN_MEANS`, `getInputRate`, `srToRawDan`, and `parseDan` into `src/lib/dan-estimator/labels.ts`. Export `getInputRate`, `srToRawDan`, and `parseDan`.

- [x] **Step 3: Update public wrapper imports**

At the top of `src/lib/dan-estimator.ts`, import the moved types and label helpers:

```ts
import type { ManiaBeatmap } from "./beatmap-parser";
import type { DanEstimate, DanEstimateInput } from "./dan-estimator/types";
import { getInputRate, parseDan, srToRawDan } from "./dan-estimator/labels";
```

Re-export public types from `src/lib/dan-estimator.ts`:

```ts
export type {
  DanEstimate,
  DanEstimateDebug,
  DanEstimateInput,
  DanFamilyChoiceDebug,
  DanPrimaryFamily,
  DanScoreContribution,
  DanScoringDebug,
  DanSkillFamily,
} from "./dan-estimator/types";
```

- [x] **Step 4: Run tests**

Run: `npm run test -- src/lib/dan-estimator.test.ts`

Expected: all dan estimator tests pass.

### Task 2: Extract Math Helpers And Feature Extraction

**Files:**
- Create: `src/lib/dan-estimator/math.ts`
- Create: `src/lib/dan-estimator/features.ts`
- Modify: `src/lib/dan-estimator.ts`
- Test: `src/lib/dan-estimator.test.ts`

- [x] **Step 1: Move math helpers**

Move these functions into `src/lib/dan-estimator/math.ts` and export them:

```ts
export function clamp(value: number, min: number, max: number): number;
export function clamp01(value: number): number;
export function gateWhen(condition: boolean, value: number): number;
export function minGate(...values: number[]): number;
export function quantile(values: number[], q: number): number;
export function countInWindow(times: number[], windowMs: number): number;
export function average(values: number[]): number;
export function bucketEntropy(values: number[], bucketSize: number): number;
export function bucketValues(values: number[], bucketSize: number): number[];
export function raoQuadraticEntropyLog(values: number[], logIterations: number): number;
export function powerMean(values: number[], weights: number[], exponent: number): number;
export function strainSpikiness(values: number[], weights: number[]): number;
```

- [x] **Step 2: Move feature extraction**

Move `getRatedNotes`, `groupNotesByTime`, and `extractDanFeatures` into `src/lib/dan-estimator/features.ts`. Import `ManiaBeatmap`, `ManiaNote`, `DanEstimateInput`, and `DanFeatureExtractionResult`. Import math helpers from `./math`.

- [x] **Step 3: Update public wrapper imports**

In `src/lib/dan-estimator.ts`, import:

```ts
import { extractDanFeatures } from "./dan-estimator/features";
```

Remove the old local feature-extraction and math helper definitions from `src/lib/dan-estimator.ts`.

- [x] **Step 4: Run tests**

Run: `npm run test -- src/lib/dan-estimator.test.ts`

Expected: all dan estimator tests pass.

### Task 3: Extract Scoring And Family Choice

**Files:**
- Create: `src/lib/dan-estimator/scoring.ts`
- Create: `src/lib/dan-estimator/family-choice.ts`
- Modify: `src/lib/dan-estimator.ts`
- Test: `src/lib/dan-estimator.test.ts`

- [x] **Step 1: Move scoring**

Move `BASE_SR_CALIBRATION`, `DanFamilyScoreResult`, and `estimateFamilyScores` into `src/lib/dan-estimator/scoring.ts`. Import `DanFeatureMetrics`, `DanScoringDebug`, `DanSkillFamily`, and math helpers from `./math`.

- [x] **Step 2: Move family choice**

Move `PRIMARY_FAMILIES`, `DanFamilyChoiceResult`, `DanFamilyChoiceRule`, `FAMILY_CHOICE_RULES`, and `chooseSkillFamily` into `src/lib/dan-estimator/family-choice.ts`. Import `DanFeatureMetrics`, `DanFamilyChoiceDebug`, `DanPrimaryFamily`, and `DanSkillFamily`.

- [x] **Step 3: Update public wrapper imports**

In `src/lib/dan-estimator.ts`, import:

```ts
import { chooseSkillFamily } from "./dan-estimator/family-choice";
import { estimateFamilyScores } from "./dan-estimator/scoring";
```

Remove the old local scoring and family-choice definitions from `src/lib/dan-estimator.ts`.

- [x] **Step 4: Run tests**

Run: `npm run test -- src/lib/dan-estimator.test.ts`

Expected: all dan estimator tests pass.

### Task 4: Extract Dan Course Detection

**Files:**
- Create: `src/lib/dan-estimator/courses.ts`
- Modify: `src/lib/dan-estimator.ts`
- Test: `src/lib/dan-estimator.test.ts`

- [x] **Step 1: Move course helpers**

Move `countDanSegments`, `isDanCourse`, and `estimateDanCourseSr` into `src/lib/dan-estimator/courses.ts`. Import `ManiaNote`, `DanEstimateInput`, and `DanFeatureMetrics`.

- [x] **Step 2: Update public wrapper imports**

In `src/lib/dan-estimator.ts`, import:

```ts
import { estimateDanCourseSr, isDanCourse } from "./dan-estimator/courses";
```

Remove local course helper definitions from `src/lib/dan-estimator.ts`.

- [x] **Step 3: Run tests**

Run: `npm run test -- src/lib/dan-estimator.test.ts`

Expected: all dan estimator tests pass.

### Task 5: Verify Build And Commit

**Files:**
- Modify: no code unless earlier tasks reveal import/type issues.

- [x] **Step 1: Run full estimator tests**

Run: `npm run test -- src/lib/dan-estimator.test.ts`

Expected: 50 tests pass.

- [x] **Step 2: Run production build**

Run: `npm run build`

Expected: build exits 0. Existing Vite warnings about externalized node modules, chunk size, and ignored `"use client"` directives may remain.

- [x] **Step 3: Review changed files**

Run:

```bash
git status --short
git diff --stat
```

Expected: only dan-estimator module split files, tests if touched by imports, and no generated route tree changes.

- [x] **Step 4: Commit**

Run:

```bash
git add src/lib/dan-estimator.ts src/lib/dan-estimator src/lib/dan-estimator.test.ts
git commit -m "Refactor dan estimator modules"
```

Expected: one focused refactor commit.

