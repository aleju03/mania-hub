# LN Dan Classifier Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add 4K LN dan support to the Aleju dan classifier calibrated against `datasets/dan-classifier/ln-maps`.

**Architecture:** Add LN-specific feature metrics and a focused `ln.ts` estimator module. The public `estimateDan` wrapper will prefer the LN result when LN pressure is high, while preserving the current regular dan path for non-LN charts. The admin UI will display LN-specific logos from `public/images/dans/ln`.

**Tech Stack:** TypeScript, React, Vitest, existing osu!mania parser, local `.osu` dataset fixtures.

---

### Task 1: Add LN Types And Feature Metrics

**Files:**
- Modify: `src/lib/dan-estimator/types.ts`
- Modify: `src/lib/dan-estimator/features.ts`
- Test: `src/lib/dan-estimator.test.ts`

- [x] **Step 1: Extend family/type fields**

Add `ln` to `DanSkillFamily` and add LN metrics to `DanFeatureMetrics`.

- [x] **Step 2: Extract LN feature metrics**

Compute LN hold duration, overlap, density, and release pressure in `extractDanFeatures`.

- [x] **Step 3: Run existing estimator tests**

Run: `npm run test -- src/lib/dan-estimator.test.ts`

### Task 2: Add LN Estimator Module

**Files:**
- Create: `src/lib/dan-estimator/ln.ts`
- Modify: `src/lib/dan-estimator.ts`
- Test: `src/lib/dan-estimator-ln.test.ts`

- [x] **Step 1: Add LN label parsing**

Implement LN raw-to-label helpers that produce `LN 1` through `LN 15`, including `-` and `+` variants.

- [x] **Step 2: Add LN pressure scoring**

Implement an LN score using star rating, hold ratio, LN density, release pressure, overlap pressure, chord pressure, and duration pressure.

- [x] **Step 3: Prefer LN estimates for LN-heavy maps**

Call the LN estimator from `estimateDan` and return it before regular dan mapping when it applies.

### Task 3: Add Dataset Calibration Tests

**Files:**
- Create: `src/lib/dan-estimator-ln.test.ts`
- Test: `datasets/dan-classifier/ln-maps`

- [x] **Step 1: Read manifest and maps**

Load `manifest.json` and parse each referenced local `.osu` file.

- [x] **Step 2: Assert official underjoy courses**

Assert `_underjoy` courses classify as exact `LN 1` through `LN 15`.

- [x] **Step 3: Assert special singles**

Assert `in the dark` is `LN 14` and `Youmu's Dream` at `1.025x` is `LN 15`.

- [x] **Step 4: Assert Hylotl numeric targets**

Assert numeric Hylotl `lnEstimate` labels while skipping non-numeric targets.

### Task 4: Add LN Logos And Admin Display

**Files:**
- Create: `public/images/dans/ln/1.svg` through `public/images/dans/ln/15.svg`
- Modify: `src/routes/admin/dan-classifier.tsx`

- [x] **Step 1: Generate LN SVG assets**

Create no-pillar LN badge SVGs with background-inspired per-level colors.

- [x] **Step 2: Update admin image lookup**

Use LN logo assets when `estimate.family === "ln"`.

### Task 5: Verify And Commit

**Files:**
- Modify only LN classifier, tests, assets, spec, and plan files.

- [x] **Step 1: Run LN tests**

Run: `npm run test -- src/lib/dan-estimator-ln.test.ts`

- [x] **Step 2: Run regular estimator tests**

Run: `npm run test -- src/lib/dan-estimator.test.ts`

- [x] **Step 3: Run production build**

Run: `npm run build`

- [x] **Step 4: Commit scoped changes**

Stage only LN classifier-related files and commit.
