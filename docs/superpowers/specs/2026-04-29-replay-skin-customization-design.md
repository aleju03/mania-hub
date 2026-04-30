# Replay Skin Customization Design

## Goal

Allow the replay viewer playfield to switch between the current bar skin and a new circle skin, with persisted note colors and a Percy visual toggle.

## UX

The replay controls row gains a compact gear button that opens a `Replay skin` modal. The modal uses the route's existing dark osu-style surfaces, rounded corners, small uppercase labels, and pink active states. It contains a `Bars`/`Circles` style selector, color controls for `Tap notes`, `LN head`, and `LN body`, a bare `Percy` toggle, plus reset/close actions.

Settings apply live to the active renderer and persist to localStorage as versioned JSON. The default style is `bars`, preserving current behavior.

## Renderer Behavior

Bars remain compatible with the current playfield. Circle mode renders tap notes as filled circles, LN bodies as rounded gray vertical bodies by default, and LN heads as colored circles. Circle mode hides the horizontal judgment line. Circle receptors are white outline circles only: idle at roughly 50% opacity and pressed at full opacity, with no glow, beam, or color fill.

Percy is visual only. It slightly shortens LN bodies to create spacing in dense LN sections and never changes replay timing, judgement simulation, audio sync, or note hit state.

## Persistence

Store settings under `mania-hub-replay-skin-v1` as readable JSON:

```json
{
  "version": 1,
  "style": "circles",
  "tapColor": "#9cf2ae",
  "lnHeadColor": "#dfffe6",
  "lnBodyColor": "#8b8b93",
  "percy": true
}
```

Invalid or missing values fall back per field to defaults.

## Testing

Add focused tests for settings parsing/defaulting. Add renderer source safeguards for circle mode expectations that are hard to exercise in Pixi under Vitest: no circle receptor beam/glow path, circle mode hides the judgment line, and renderer exposes live skin settings updates.
