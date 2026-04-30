# Replay Skin Customization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add persisted replay skin customization with bar/circle playfield styles, note colors, LN body color, and Percy.

**Architecture:** Create a small typed settings module for defaults, parsing, and localStorage helpers. Pass those settings from `src/routes/replay.tsx` into `ManiaReplayRenderer`, and expose a live `setSkinSettings` renderer method. Keep drawing changes scoped to `src/components/replay/ReplayCanvas.ts`.

**Tech Stack:** React, TypeScript, TanStack Start route, Pixi.js renderer, Vitest.

---

### Task 1: Settings Model

**Files:**
- Create: `src/lib/replay-skin.ts`
- Create: `src/lib/replay-skin.test.ts`

- [ ] Write failing tests for default settings, partial JSON hydration, invalid field fallback, and localStorage round-trip.
- [ ] Implement `ReplaySkinSettings`, `DEFAULT_REPLAY_SKIN_SETTINGS`, `normalizeReplaySkinSettings`, `readReplaySkinSettings`, and `writeReplaySkinSettings`.
- [ ] Run `npm run test -- src/lib/replay-skin.test.ts`.

### Task 2: Renderer Skin Support

**Files:**
- Modify: `src/components/replay/ReplayCanvas.ts`
- Modify: `src/components/replay/ReplayCanvas.test.ts`

- [ ] Add failing source-level tests for renderer skin option plumbing and circle receptor constraints.
- [ ] Add `skinSettings?: ReplaySkinSettings` to renderer options and a live `setSkinSettings(settings)` method.
- [ ] Draw circles for tap notes and LN heads in circle mode.
- [ ] Draw LN bodies with rounded top, configurable body color, and conservative Percy shortening.
- [ ] Hide the judgment line in circle mode.
- [ ] Draw circle receptors as white outline circles with idle/pressed opacity only.
- [ ] Run `npm run test -- src/components/replay/ReplayCanvas.test.ts`.

### Task 3: Replay Modal UI

**Files:**
- Modify: `src/routes/replay.tsx`

- [ ] Load persisted skin settings in `ReplayViewer`.
- [ ] Add settings state/ref and pass it to `ManiaReplayRenderer`.
- [ ] Add a gear button to the controls row.
- [ ] Add a modal with style selector, three color inputs, Percy checkbox, reset, and close.
- [ ] Apply changes live through `renderer.setSkinSettings`.
- [ ] Persist settings changes to localStorage.

### Task 4: Verification

**Files:**
- Verify all changed files.

- [ ] Run `npm run test`.
- [ ] Run `npm run build`.
- [ ] Check `git diff --check`.
