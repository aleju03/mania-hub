# Stable ScoreV2 replay validation

Stable replays with `SV2` (tosu: `V2`) use the `stable-scorev2` judgement mode.
They retain their Stable client label and presentation. ScoreV2 changes the
PERFECT window, judges hold heads and tails separately, and weights MAX at 305
for accuracy. See the [osu!mania judgement reference](https://osu.ppy.sh/wiki/en/Gameplay/Judgement/osu!mania#scorev2).

The simulator shares separate head/tail events with lazer, but keeps stable's
input ownership and timeout rules. The input gate uses the unscaled miss
window, with 1.5x lenience for tails; judgement bands remain in replay time.
The previous replay frame determines whether a sampled press reaches an
object before its timeout. An input at the next note's exact timestamp belongs
to that next note. Expired holds do not reclaim presses after their tails.

Release windows are truncated before applying lenience. A released hold can
receive Meh when its tail enters the early Meh window. The release edge and
hold-state update can occur on adjacent frames; that reconstruction remains
an estimate and is the next area to validate across additional captures.

ScoreV1's combined hold judgement and input reconstruction remain unchanged.
Stable ScoreV2 does not reconcile simulated judgements to the header counts.
Header accuracy is calculated independently for the replay info panel and
uploaded replay descriptions; description version 3 refreshes cached values.

## 2026-09-05 capture

- Player: SWADEEF; upload `d6UBSbyhlMUiFaDcfgme`; DT + SV2.
- Map: Kou! - Fermion Amplification [Superconductivity], beatmap 5308489.
- Beatmap checksum: `576d6f792f44dfa19cdd1fbc436dd0ad` (verified against the `.osr`).
- Fixtures: `cache/replay-fixtures/fermion-stable-sv2/{beatmap.osu,replay.osr}`.
- Capture: `cache/replay-captures/fermion-stable-sv2.{jsonl,ndjson}`.
- The capture contains 2,222 selected gameplay samples. Its final counts match
  the replay header and results screen. Live score is 498458; results/header
  score is 498475.
- The original logger also recorded 8,001 hit-error values in `newHitErrors`.
  The converter previously discarded these. It now rebuilds the cumulative
  `play.hitErrorArray` that the comparison harness reads, preserving their
  order and resetting across sessions/restarts. The capture above has been
  reconverted; use these errors before requesting a new recording.
- After the follow-up input fixes, `--hit-error-fit` matches all 8,001 captured
  errors. There are three additional simulated hold-head errors. The logger
  had a path that advanced its error cursor without writing a frame when only
  hit errors changed; `tosu-log` now retains those updates. That is a possible
  explanation for the three absent entries, not proof about their origin.

| Measurement | Before | After | Stable capture/header |
| --- | ---: | ---: | ---: |
| Total judgements | 5867 | 8177 | 8177 |
| MAX | 1598 | 2762 | 2762 |
| 300 | 1870 | 2745 | 2746 |
| 200 | 1231 | 1707 | 1712 |
| 100 | 659 | 641 | 633 |
| 50 | 189 | 140 | 142 |
| Miss | 320 | 182 | 182 |
| Simulated accuracy | 77.379126% | 83.336909% | 83.360966% |
| Header accuracy shown | 84.187355% | 83.360966% | 83.360966% |

The aggregate absolute count difference improved from 36 after the initial
ScoreV2 fix to 16 after using the recorded errors. MAX and Miss now match
exactly; the middle grades still differ. All observed timing errors matching
does not prove every grade is correct, and the similar final accuracies can
hide cancelling errors. The 2,310 missing judgements and wrong accuracy scale
are resolved. Ordinal comparisons can still drift when heads and tails are
judged in a different order.

```sh
npm run replay:compare-capture -- \
  --beatmap cache/replay-fixtures/fermion-stable-sv2/beatmap.osu \
  --replay cache/replay-fixtures/fermion-stable-sv2/replay.osr \
  --hit-error-fit --drift-summary --diff-intervals \
  cache/replay-captures/fermion-stable-sv2.ndjson
```

Regression checks against the pre-change engine produced identical judgement
events and note states for all seven older captures: 2694112504, 3171032026,
3009692002, 6504946329, 6302257891, 3081339102, and `reyvateil-fullln-dt`.
Focused regression cases live in `src/lib/mania-replay-scorev2.test.ts`.
