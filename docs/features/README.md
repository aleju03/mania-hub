# Feature models

One file per area; read only the one you need. Card packs and the GOAT poll are in `../packs.md`, the Discord bot and `/communities` in `../discord.md`.

| File | Covers |
| --- | --- |
| [chart-analysis.md](chart-analysis.md) | Per-chart analysis: engines (MinaCalc, Prism, LeoBlack), 4K LN identity, LN rating, hybrids, pattern tags, LeoBlack adaptations, note BPM |
| [vibro.md](vibro.md) | Vibro and unrateable charts: policy, detection rules, adjusted vs excluded |
| [skill-ratings.md](skill-ratings.md) | Player MSD/SSR ratings, axes per keymode, Etterna Overall, pending plays, Skills tab, skill and maniacard history |
| [dan-estimates.md](dan-estimates.md) | Chart dan verdicts, clear credit, player dan aggregation, tile filing, hybrid credit, chart families, course and practice clears, adding missing scores |
| [profiles-rankings.md](profiles-rankings.md) | Profiles, per-keymode pp and tracked plays, the `/rankings` boards, unrated plays, goals |
| [live-boards.md](live-boards.md) | Teams, tracker, snipes, top plays, activity |
| [maps.md](maps.md) | `/maps` search index, map collections, farm helper (`/recommendations`) |
| [my-data.md](my-data.md) | The `/my-data` dashboard, insights, removing tracked plays |
| [uploaded-replays.md](uploaded-replays.md) | Unlisted `.osr` uploads, the owner index, community gallery and beatmaps |
| [skins.md](skins.md) | Skin privacy, dates, likes, trait filters, previews |

## Writing these

- Describe current behaviour and the rules it must keep, with pointers to the code (file, function, constant). The code is the source of truth for thresholds; give a number only when it is the rule itself.
- No change history: version bumps, dated "since ..." notes, what a rule replaced, before/after corpus measurements and chart anecdotes belong in commit messages or next to the constant in code.
- Keep the reason a rule exists when it is not obvious from the code, in a sentence.
- Edit the paragraph that describes a behaviour instead of appending a new one.
