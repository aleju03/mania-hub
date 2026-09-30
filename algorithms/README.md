# Mania Tracker algorithms

The code that rates charts and players on [mania-tracker.com](https://mania-tracker.com): dan estimates, skillset tags, vibro detection, the LN model, and how a player's plays become skill ratings and a dan.

## Layout

| Folder | What it decides |
| --- | --- |
| `chart/` | Parsing `.osu` files, BPM, the Invert mod, star rating, pp, score accuracy formulas |
| `vibro/` | Whether a chart, or a chart at a given rate, can be played by shaking instead of hitting notes |
| `classification/` | A chart's dan verdict and pattern tags at a given rate, and whether it can count toward a player's dan |
| `dan-estimator/` | Chart features, pattern analysis, dan labels, LN identity and the in-house LN estimator |
| `ln/` | The LN model: hold timeline, required-action workload, the 4K LN rating and its four skillsets |
| `msd/` | How MinaCalc is called and how its skillsets become a chart's MSD |
| `leoblack/` | The wrapper around LeoBlack's estimators and the Companella refinement |
| `player/` | Accuracy to Wife3 goal, per-play SSRs, skill ratings, dan clears, dan courses |

## How it fits together

A chart goes through `classification/chart-classifier.ts`, which picks the engine per keymode (LeoBlack for 4K, 6K and 7K, the in-house LN estimator as a fallback), runs vibro detection and LN identity, and returns a dan verdict and pattern tags.

A play goes through `player/skill-ratings.ts`: its accuracy becomes a Wife3 goal, MinaCalc rates the chart at that goal and rate, and a player's best plays per skillset are aggregated into their ratings. One play is kept per chart, rate and Invert setting.

`player/dan-clears.ts` turns plays into dan clears: each pass is judged against the accuracy bar of that dan ladder, credited at the chart's dan at the played rate, filed into skillset tiles, and averaged into a dan per tile and a headline dan.

## External code

- **LeoBlack** ([LeoBlackMT/osumania_map_analyser](https://github.com/LeoBlackMT/osumania_map_analyser), MIT): the Mixed, Sunny and LN estimators. Imported here as `leoblack/...`.
- **MinaCalc** ([Etterna](https://github.com/etternagame/etterna)): the MSD calculator, compiled to wasm. `msd/minacalc.ts` only declares the calls the rest of the code makes.

The Wife3 model coefficients in `player/wife-calibration.ts` are declared but not included.

## License

MIT, see [LICENSE](LICENSE).
