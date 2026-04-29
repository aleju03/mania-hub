# Replay Stable Judgement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore stable osu!mania replay judgement behavior without touching the Pixi replay renderer.

**Architecture:** Keep the change inside the pure replay judgement library and its tests. The route and canvas renderer continue consuming the same exported functions and types.

**Tech Stack:** TypeScript, Vitest, TanStack Start app codebase.

---

### Task 1: Add Stable Judgement Regression Tests

**Files:**
- Modify: `src/lib/mania-replay-judgement.test.ts`

- [ ] **Step 1: Add tests for stable HR/EZ and rate-mod windows**

Add tests asserting stable HR/EZ are applied through OD, while DT/HT leave stable classic windows unchanged.

- [ ] **Step 2: Add tests for stable tap hit windows**

Add tests asserting a late press after the stable OK window is a miss at `note.time + windows.ok`, and an early 50 remains a 50.

- [ ] **Step 3: Add test for stable long-note late release**

Add a test asserting a stable long note held past the late OK tail window produces a combined miss at `note.endTime + windows.ok`.

- [ ] **Step 4: Run targeted tests and verify they fail**

Run: `npm run test -- src/lib/mania-replay-judgement.test.ts`

Expected: new tests fail against current implementation.

### Task 2: Implement Stable Judgement Fixes

**Files:**
- Modify: `src/lib/mania-replay-judgement.ts`

- [ ] **Step 1: Update stable ruleset modifiers**

Add an effective OD multiplier for stable HR/EZ and include DC as a half-rate mod.

- [ ] **Step 2: Keep stable classic windows independent from rate mods**

Use a total multiplier of `1` for stable classic windows, while retaining existing lazer rate/difficulty behavior.

- [ ] **Step 3: Limit stable late tap hits to the OK window**

For stable mode, scan tap/head presses only through `note.time + windows.ok`; allow early 50s by keeping the early miss-side window.

- [ ] **Step 4: Make stable late long-note releases miss**

When a stable hold segment extends past the late OK tail window, emit a miss at `note.endTime + windows.ok` instead of treating the tail as released at exact end time.

- [ ] **Step 5: Run targeted tests**

Run: `npm run test -- src/lib/mania-replay-judgement.test.ts`

Expected: all replay judgement tests pass.

### Task 3: Verify Slice

**Files:**
- No additional file changes.

- [ ] **Step 1: Run full tests**

Run: `npm run test`

Expected: all Vitest tests pass.

- [ ] **Step 2: Inspect diff scope**

Run: `git diff --stat`

Expected: only docs and replay judgement test/library files are changed, plus any pre-existing unrelated dirty files.
