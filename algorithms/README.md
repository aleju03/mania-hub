# Mania Tracker algorithms

The code that rates charts and players on [mania-tracker.com](https://mania-tracker.com): dan estimates, skillset tags, vibro detection, the LN model, Prism (the 6K-8K MSD calculator), and how a player's plays become skill ratings and a dan.

## Layout

| Folder | What it decides |
| --- | --- |
| `chart/` | Parsing `.osu` files, BPM, the Invert mod, star rating, pp, score accuracy formulas |
| `vibro/` | Whether a chart, or a chart at a given rate, can be played by shaking instead of hitting notes |
| `classification/` | A chart's dan verdict and pattern tags at a given rate, and whether it can count toward a player's dan |
| `dan-estimator/` | Chart features, pattern analysis, dan labels, LN identity and the in-house LN estimator |
| `ln/` | The LN model: hold timeline, required-action workload, the 4K LN rating and its four skillsets |
| `msd/` | How a chart's MSD is computed: MinaCalc, or Prism on 6K-8K |
| `prism/` | Prism 0.25, the MSD calculator for 6K, 7K and 8K |
| `leoblack/` | The wrapper around LeoBlack's estimators and the Companella refinement |
| `player/` | Accuracy to Wife3 goal, per-play SSRs, skill ratings, dan clears, dan courses |
| `replay-judge/` | Reading `.osr` replay frames and judging each key press against the chart, for stable and lazer |

## How it fits together

A chart goes through `classification/chart-classifier.ts`, which picks the engine per keymode (LeoBlack for 4K, 6K and 7K, the in-house LN estimator as a fallback), runs vibro detection and LN identity, and returns a dan verdict and pattern tags.

A play goes through `player/skill-ratings.ts`: its accuracy becomes a Wife3 goal (a ScoreV2 goal on 6K-8K), MinaCalc or Prism rates the chart at that goal and rate, and a player's best plays per skillset are aggregated into their ratings. One play is kept per chart, rate and Invert setting.

`player/dan-clears.ts` turns plays into dan clears: each pass is judged against the accuracy bar of that dan ladder, credited at the chart's dan at the played rate, filed into skillset tiles, and averaged into a dan per tile and a headline dan.

## Prism

Prism 0.25 rates 6K, 7K and 8K charts, the keymodes MinaCalc was never built for. Its numbers are on the MSD scale and in MinaCalc's skillset slots.

- `prism/workload.ts` splits the columns into two hands and builds each hand's strain from what it has to press, jack, hold and release, filing every unit of work under the pattern that asked for it. On 7K the centre column stays on one thumb for the whole chart, and the assignment that rates lower is used.
- `prism/index.ts` solves the 500ms section strains for the skill that scores a goal, maps that skill onto the MSD scale through fitted knots, and rates each skillset by how much of each section's work its pattern carried.
- `prism/params.ts` holds the fitted constants per keymode.
- `prism/ln-skill.ts`, `prism/ln-sections.ts` and `prism/ln-lead.ts` give 6K-8K their LN rating: the same workload on constants fitted to LN charts, read over a hybrid's LN sections when it has enough of them.

Goals are ScoreV2 accuracy, with no Wife3 conversion.

## External code

- **LeoBlack** ([LeoBlackMT/osumania_map_analyser](https://github.com/LeoBlackMT/osumania_map_analyser), MIT): the Mixed, Sunny and LN estimators. Imported here as `leoblack/...`.
- **MinaCalc** ([Etterna](https://github.com/etternagame/etterna)): the MSD calculator, compiled to wasm. `msd/minacalc.ts` only declares the calls the rest of the code makes.

## License

MIT, see [LICENSE](LICENSE).
