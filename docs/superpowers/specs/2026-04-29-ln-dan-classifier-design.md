# LN Dan Classifier Design

## Goal

Add 4K LN dan support to the Aleju dan classifier using the local `datasets/dan-classifier/ln-maps` calibration set.

## Scope

The Aleju estimator will auto-detect LN-heavy 4K maps and return LN dan labels on a separate `LN 1` through `LN 15` scale. Regular non-LN maps must continue using the existing regular dan families and labels.

Calibration targets come from `datasets/dan-classifier/ln-maps/manifest.json`:

- `_underjoy` marathon courses classify as `LN 1` through `LN 15`.
- `in the dark` classifies as `LN 14`.
- `Youmu's Dream` at `1.025x` classifies as `LN 15`.
- Hylotl maps with numeric `lnEstimate` values classify to that label, including `+` and `-` variants.
- Non-numeric labels such as `Release`, `Very Dense`, and `LN ?` are excluded from hard target tests.

## Architecture

LN support lives beside the regular estimator in `src/lib/dan-estimator/ln.ts`. It receives the existing extracted features, star rating, duration, notes, and metadata input, then returns either an LN estimate or `null`. The public `estimateDan` wrapper uses that result before the regular family-choice label mapping when a chart is clearly LN-heavy or known LN-course style.

The existing feature extractor will grow LN-specific metrics: hold duration pressure, LN density, LN overlap pressure, LN chord pressure, and release/tail pressure. The regular scoring code should not depend on those metrics except through existing fields.

## UI

Add `family: "ln"` and LN logos at `public/images/dans/ln/1.svg` through `15.svg`. The admin classifier uses LN logos when the estimate family is `ln`; otherwise it keeps the existing Reform dan logos.

## Tests

Add dataset-driven Vitest coverage in `src/lib/dan-estimator-ln.test.ts`. The tests read actual `.osu` files from `datasets/dan-classifier/ln-maps`, parse them with the existing beatmap parser, pass star rating and length from `manifest.json`, and assert expected LN labels.

The existing `src/lib/dan-estimator.test.ts` suite must keep passing.
