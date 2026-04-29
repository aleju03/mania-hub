# Replay Beatmap Score Progress Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show replayable scores progressively after selecting a beatmap difficulty on `/replay`, while making the country lookup faster without increasing API scope.

**Architecture:** Add replay-specific beatmap score status and partial-result cache entries in `src/lib/osu.ts`. The existing `getBeatmapScores` country path will update those entries while scanning ranked country players; `src/routes/replay.tsx` will poll them while the request is in flight and render partial replayable scores immediately.

**Tech Stack:** TanStack Start server functions, React state/effects, existing persistent cache helpers, Vitest source-level and helper tests.

---

### Task 1: Server Progress State

**Files:**
- Modify: `src/lib/types.ts`
- Modify: `src/lib/osu.ts`
- Test: `src/lib/beatmap-score-progress.test.ts`

- [ ] **Step 1: Write failing tests**

Create tests that assert a status key and partial key include both beatmap id and normalized country, and that merge sorting keeps score order stable.

- [ ] **Step 2: Run tests**

Run: `npm run test -- src/lib/beatmap-score-progress.test.ts`
Expected: FAIL because helpers are not exported yet.

- [ ] **Step 3: Add types and helpers**

Add `BeatmapScoreLookupStatus` to `src/lib/types.ts`. Add exported pure helpers in `src/lib/osu.ts`: `beatmapScoreLookupStatusKey`, `beatmapScoreLookupPartialKey`, and `sortBeatmapScores`.

- [ ] **Step 4: Run tests**

Run: `npm run test -- src/lib/beatmap-score-progress.test.ts`
Expected: PASS.

### Task 2: Progressive Server Lookup

**Files:**
- Modify: `src/lib/osu.ts`

- [ ] **Step 1: Update country lookup**

Raise `COUNTRY_BEATMAP_LOOKUP_CONCURRENCY` from `10` to `15`. During `getCountryBeatmapScores`, write status before scan, update partial scores after each found score, throttle status writes, and clear status at the end. Preserve the existing final return shape.

- [ ] **Step 2: Add polling server functions**

Add `getBeatmapScoreLookupStatus` and `getPartialBeatmapScores` server functions with `noStore()`.

### Task 3: Replay Route Polling

**Files:**
- Modify: `src/routes/replay.tsx`
- Test: `src/routes/-replay-beatmap-score-progress.test.ts`

- [ ] **Step 1: Write failing route tests**

Assert replay imports the two polling functions, maintains partial score state/status, and renders checked/found progress copy.

- [ ] **Step 2: Run route test**

Run: `npm run test -- src/routes/-replay-beatmap-score-progress.test.ts`
Expected: FAIL before route changes.

- [ ] **Step 3: Wire polling**

When a difficulty is selected, clear partial state and start the full `getBeatmapScores` request. While loading, poll status and partial scores every 750ms using a request token so stale selections cannot overwrite the current one.

- [ ] **Step 4: Render progressive results**

Use partial scores while loading and full scores when the request finishes. Replace the lone spinner with progress text like `37/100 players checked · 4 replays found`.

- [ ] **Step 5: Run route test**

Run: `npm run test -- src/routes/-replay-beatmap-score-progress.test.ts`
Expected: PASS.

### Task 4: Verification

**Files:**
- Test touched behavior only.

- [ ] **Step 1: Run targeted tests**

Run: `npm run test -- src/lib/beatmap-score-progress.test.ts src/routes/-replay-beatmap-score-progress.test.ts src/routes/-replay-beatmap-search.test.ts src/lib/beatmap-search.test.ts`
Expected: PASS.

- [ ] **Step 2: Build if TypeScript boundaries changed unexpectedly**

Run: `npm run build`
Expected: PASS if run; note any environment blockers.
