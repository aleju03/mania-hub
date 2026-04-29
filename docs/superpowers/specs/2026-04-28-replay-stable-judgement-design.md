# Replay Stable Judgement Recovery Design

## Goal

Recover the stable osu!mania replay judgement fixes from the replay investigation stash without reintroducing the Pixi renderer crash.

## Scope

This pass is limited to `src/lib/mania-replay-judgement.ts` and its Vitest coverage. It must not modify Pixi lifecycle, canvas keys, route background loading, or replay renderer cleanup.

## Design

Stable replay judgement should follow classic stable behavior more closely:

- Stable HR and EZ alter effective OD before classic hit windows are calculated.
- Stable DT, NC, HT, and DC do not resize classic hit windows.
- Stable tap notes only allow late hits through the late OK window; later presses inside the miss window should display a miss at the timeout.
- Stable tap notes still allow early 50s.
- Stable long notes require a release inside the late OK tail window; holding past that window should miss instead of being treated as a perfect tail release.

Lazer behavior should continue using existing lazer windows and separate hold head/tail judgement flow.

## Testing

Add focused tests to `src/lib/mania-replay-judgement.test.ts` for each stable behavior above, verify they fail on current code, then implement the minimal library changes until the targeted tests pass. Run the full Vitest suite after the targeted green pass.

## Non-Goals

- No Pixi renderer migration or cleanup changes.
- No route background/lifecycle changes.
- No visual mod badge changes in this slice.
- No replay UI redesign.
