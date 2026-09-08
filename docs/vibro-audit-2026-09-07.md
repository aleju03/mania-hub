# Localized vibro rating audit — 2026-09-07

**Correction:** the first section policy incorrectly unflagged the user-confirmed
vibro chart found footage (4871104). The original corpus totals below describe
v1 and do not establish that every restored chart was a false positive. Section
policy v2 adds sustained short-jack-stream detection and a real-note regression
for this map; it is excluded independently of its name and OD.

**V4 correction:** the user confirmed easy chordjack and VAPO VAPO as vibro;
both are excluded again by the dense-chord repetition rule below. Chaser
[Wristjacker] at DT and abandoned 1.3x remain eligible as requested. Passing
tests and corpus scans do not establish that every restored chart is valid.

The section policy restores every reported rate edit in the cached regression
set. It uses note structure and played timing only. Chart titles, beatmap IDs,
mapper names and declared rate names do not participate in detection.

## Reported charts

These results use cached note files. MSD values are Overall at the standard
calculator goal, not osu! star ratings or a particular player's SSR.

| Chart | Result | Active time removed | MSD before → after |
| --- | --- | ---: | ---: |
| Lemon Tree, Challenge 1.1x | Adjusted | 8.4% (17.22s) | 32.98 → 33.29 |
| Lemon Tree, Challenge 1.2x | Adjusted | 8.4% (15.78s) | 35.80 → 36.16 |
| FITB, 42 [1.05] | Adjusted | 1.0% (1.74s) | 31.88 → 31.87 |
| FITB, 42 [1.1] | Adjusted | 1.0% (1.66s) | 33.28 → 33.23 |
| FITB, 42 [1.15] | Adjusted | 1.0% (1.59s) | 34.79 → 34.81 |
| FITB, 42 [1.2] | Adjusted | 1.0% (1.52s) | 36.23 → 36.13 |
| Daichi ni Saku Senritsu, Impossible 1.3x / 1.4x | Clean | 0% | 31.98 / 34.31 unchanged |
| Polyriddim, Chordriddim 1.3x / 1.4x | Clean | 0% | 30.94 / 32.94 unchanged |
| traveling, flowing 1.3x (152bpm) | Clean | 0% | 35.76 unchanged |
| Angel Dust, Zeta Jack (4490040) | Clean | 0% | 36.39 unchanged |
| FITB, 42 [0.9] at DT | Adjusted | 1.0% (1.35s) | 41.23 → 41.18 |

The Zeta result describes that cached upload, not an independently verified
match to the suggestion's screenshot. The FITB DT comparison describes the
chart; it does not establish which upload or cached verdict GenirX's play used.

Removing notes changes MinaCalc's distribution, so its standard-goal MSD can
move slightly upward as well as downward. Player ratings additionally lower
the goal conservatively: all observed accuracy loss is assigned to the
remaining notes. Original score accuracy remains visible and stored.

## Original v1 corpus checks (superseded)

The read-only audit examined 119,865 indexed 4K entries at both 1.0x and 1.5x.
Forty files were unavailable locally. Of the scanned entries, 88,364 had cached
4K rice charts with at most 10% holds and were within this policy's scope.
Hold-heavy charts retain the legacy policy.

- At 1.0x, no ranked chart was excluded. Two ranked charts had localized
  adjustments: Rush (Cut Ver.) [Titanium] and Fusyoku ressentiment, fushiyoku no
  sarugakuza. [Monochrome Insanity].
- Five loved charts remained excluded at 1.0x; all were already flagged
  Vibro Anthology charts.
- At 1.0x, 2,621 previously flagged charts became eligible, either clean or
  with adjusted sections. Eighteen previously unflagged charts became excluded;
  none were ranked or loved.
- At 1.5x, one ranked chart was excluded: 680 BPM Born Slippy [Luetin]. This
  is a hypothetical rate audit of the corpus, not evidence of a particular
  player's clear or a validation against every legitimate DT score.

The final short-jack refinement only removes detections: four short isolated
bursts must also cover at least 20% of notes. A second pass reevaluated every
audit entry with isolated-jack evidence. This kept Violence [Violate the I]
at DT eligible instead of disqualifying it for scattered short bursts.

## Implementation and rollout

### Individual clear exception on 2026-09-08

The user confirmed the ranked DT classifications and asked to preserve
Saragi's controlled clear. The stored play is EVERYTHING BLACK (4706643),
legacy score 618991942 / solo score 4859818946: 1,072 MAX, 418 300s,
176 200s, 13 100s and four misses, at OD9. That is 95.7615% stable accuracy
and a 2.5646:1 MAX:300 ratio. Its retained player row was version 24, when
PP-backed trust applied; the committed pipeline had no explicit
accuracy/ratio exception to the vibro gate.

`dan/vibro-clear-evidence.ts` now implements the requested player-layer rule:
95%+ stable-formula accuracy, at least 2:1 MAX:300, OD9+ and known un-widened
windows. Only flagged 4K rice charts within the section policy can use it;
structurally ineligible note stacks cannot. Chart classification and all
chart-level exclusions remain unchanged. This is a score-quality criterion,
not proof of a player's hand technique, and does not use player/chart/score
identity. Qualifying plays receive their ordinary full-note SSR and dan
credit, with the usual accuracy curve and other eligibility checks.

Exact judgement evidence survives with an accepted play. Older retained
records can qualify only when their judgement-derived stable accuracy,
320-weighted custom accuracy and miss share prove a conservative lower bound
on MAX:300. The calculation never guesses exact counts. Saragi's old summaries
prove a ratio above 2:1 even without the source score. Missing or inconsistent
evidence fails closed. Corrected counts invalidate previous acceptances and
cached rejections. Existing localized adjustments retain their filtering and
conservative accuracy; the exception applies to otherwise excluded plays.

Play details explain the individual acceptance and show its accuracy, ratio
(marked as a lower bound when reconstructed) and OD. Player version 34 and
detector stamp 9 re-evaluate stored plays and exclusions while retaining
compatible older rows as compute seeds. Chart policy v4, dan cache 20 and
chart sweep v12 are unchanged by this player-only exception.

Final verification: the full working tree passed 2,847 backend tests. The
isolated commit candidate, excluding unrelated pending changes, passed
2,822 backend tests, eight relevant frontend tests and both TypeScript
checks. Regression coverage includes fresh and retained accepted clears,
corrected judgement counts, missing mod evidence, low OD, widened windows,
structural note stacks and conservative reconstruction of older evidence.
No app build or deployment was run.

### V4 dense-chord correction on 2026-09-08

The user's follow-up confirmed easy chordjack (5442206) and VAPO VAPO
(5847544) as vibro, while identifying Chaser [Wristjacker] (1144551) at DT
and abandoned 1.3x (5441542) as legitimate fast charts. Abandoned 1.4x
(5441543) remains unconfirmed; no identity-based override was added.

The old section rules missed dense overlapping chords whenever changing
shapes, light rows or breathers broke the consecutive-row run. V4 adds a
64-row window requiring both a high share of rows reloading multiple fingers
and a high share of all note heads returning quickly. At the 75ms cutoff,
at least 65% of rows must reload two or more fingers and at least 70% of heads
must return within the cutoff. At 50ms, those shares are 40% and 65%.
The window must average at most 100ms between rows; gaps over one second
separate phrases. All timing thresholds apply at the played rate.

Easy chordjack is excluded: its detected 0:59.714–1:18.785 passage covers
25.76% of active time and 47.05% of notes. VAPO is excluded: detections cover
0:23.449–0:28.392, 1:00.194–1:03.189, 1:08.863–1:15.438 and the existing
third-column jack at 1:16.875–1:17.922, totaling 21.90% of active time and
44.73% of notes. The previous Eta/Iota estimates therefore do not credit
player dan or MSD ratings.

Chaser +DT stays clean (Zeta−); abandoned 1.3x and Yawaraka stay clean.
Ren-chon and found footage remain excluded. Makiba retains its existing
adjustment. The original reported-chart regressions, including FITB at DT,
retain their results. Fixtures use anonymous metadata; synthetic tests cover
dense changing shapes at fast and slow timings, plus long breaks separating
short bursts. Player version 33, detector stamp 8, dan cache 20 and sweep v12
refresh older cached decisions after deployment.

Verification: 2,829 backend tests and both TypeScript checks passed.

The v4 full corpus audit scanned the same 119,865 indexed entries at normal
speed and DT (88,364 cached rice charts in scope, 40 missing files). Relative
to v3, normal speed adds 200 exclusions (102 formerly clean, 98 adjusted)
and 59 localized adjustments. None of the new normal-speed exclusions are
ranked; the one loved change is Paradisus-Paradoxum from arpia97's Vibro
Anthology (3261960), previously adjusted. At hypothetical DT, 4,148 charts
become excluded (2,147 formerly clean, 2,001 adjusted), and 1,582 formerly
clean charts receive adjustments. These are detector outcomes, not
independently verified technique labels or evidence of actual clears.

Three newly excluded ranked DT charts were brought to the user for review:

| Chart | Beatmap ID | Detected passages, original chart time |
| --- | ---: | --- |
| EVERYTHING BLACK, EDGY DIFFNAME | 4706643 | 1:10.450–1:29.750 |
| The Big Black, FRAWOG | 5362857 | 0:19.881–0:38.158; 1:56.051–2:16.701 |
| Outo, Final Requiem | 5376483 | Especially 0:58.587–1:36.813; additional sections later |

All three are clean or adjusted in v3 and excluded in v4 at DT. No 96%+ DT
passes for these were found in the inspected local board, retained score-event
and top-score rows; that absence does not establish that they are vibro.
The original ranked DT exclusion, Born Slippy [Luetin], remains excluded.
The user confirmed FRAWOG and Outo as vibro and identified the individual
EVERYTHING BLACK clear that should still count; that exception is documented
above. All three chart-level DT exclusions now have note-only regressions.

### V3 review correction on 2026-09-08

The user's review identified Yawaraka Jacktrill [34-12] (4448459) as a
plausibly controlled jack chart and confirmed Ren-chon no Drum and Bass
(918842) as vibro. The short-jack-stream rule had accepted non-quad repeats
up to 100ms apart, while sustained walls required 92ms. V3 applies the
same shape-dependent repetition cutoff to both rules. Quads retain their
105ms cutoff, with short-jack streams still requiring 64 uninterrupted rows
no more than 100ms apart. No chart identity participates in the decision.

Yawaraka's repeated jumps are exactly 100ms apart and now remain clean.
Ren-chon's repeated chords (85–86ms) and found footage's (89–90ms) remain
excluded. Makiba 0.93x (5526453) retains its quad-heavy section adjustment
at 1:56.756–2:08.272. At the screenshot's 96.85% accuracy, Makiba credits
14.92 (Epsilon) without filtering versus 14.87 (Epsilon−) with filtering;
the conservative retained-note accuracy is 96.41%. Both accuracies are
in the zero-bonus band, so the 0.05-dan difference comes from the chart
estimate alone. The review did not definitively classify Makiba as a false
positive, so its adjustment remains.

Anonymous note fixtures cover all three review charts, alongside found
footage. Synthetic regressions verify that 95ms and 100ms jump-jack bursts
remain clean despite their duration, while faster played rates still trigger
detection. Player version 32, detector stamp 7, dan cache 19 and chart sweep
v11 refresh older exclusions and adjusted ratings after deployment.

Verification: 2,818 backend tests and both TypeScript checks passed. The
previous player version remains a compatible compute seed, covered by the
retained-play continuation regression. All six screenshot charts retain
their previously reported dan estimates and eligibility results.

The full 119,865-entry corpus was audited at normal speed and DT. A final
boundary refinement keeps the original 100ms phrase grouping and requires
every gap inside a short repetition to meet its shape's speed floor; rounding
around 92/93ms therefore cannot manufacture short bursts from a long jack.
This only removes v2 burst evidence. All 346 normal-speed and 567 DT entries
with v2 short-jack-stream evidence were rechecked after that refinement,
along with both provisional new detections (which now stay clean).

Relative to v2, 20 excluded charts become eligible at normal speed (13 clean,
seven adjusted); 26 adjusted charts become clean. At DT, 11 excluded and
nine adjusted charts become clean. There are no new exclusions or new
adjustments. The settled-map results remain unchanged: no ranked exclusions
and five loved exclusions at normal speed; the only ranked DT exclusion is
680 BPM Born Slippy [Luetin]. These totals describe detector changes, not
independent human validation of every restored chart. No deployment was run.

### Iksemik pre-commit audit (v3 results; corrected above)

Compared the full pre-session classifier's vibro verdict with the current
classifier on the same note files, at 1.0x playback of each uploaded difficulty.
Of 35 locally known iksemik uploads, 33 had cached files; one additional file
was fetched through the standard osu! client. How to be like cwelington V4
(5687438) remained unavailable. Five of the 34 checked charts change from
excluded to eligible under the vibro policy:

| Chart | Beatmap ID | Current result | Current chart dan |
| --- | ---: | --- | --- |
| abandoned, fortnite 1.3x (343bpm) OD8 | 5441542 | Clean | Epsilon+ |
| abandoned, fortnite 1.4x (370bpm) OD8 | 5441543 | Clean | Zeta+ |
| easy chordjack, fortnite | 5442206 | Clean | Eta |
| How to be like cwelington V4.1, cwelington | 5692177 | Adjusted: 19.714s removed | Eta |
| VAPO VAPO, VAPO | 5847544 | Adjusted: 1.047s removed | Iota |

The four cached restorations already existed in v2; they were not introduced
by the Yawaraka refinement. Dame tu cosita [VIBRO] (5792125) remains excluded:
its 15.7% hold ratio keeps it on the legacy path, so absence from the rice-only
corpus audit must not be interpreted as a clean full-classifier verdict.

VAPO is the highest-priority review candidate: the 1:08–1:16 passage contains
dense overlapping chord rows, many 24–25ms apart, while the current filter
only removes 1:16.875–1:17.922. This may be a false negative in the section
policy. The mapper and title are audit search criteria only; no identity
exception was added. The subsequent user review and v4 correction are above.

### V2 correction verified on 2026-09-08

The user-confirmed found footage (4871104) is now excluded: the repeated-jack
passages cover 57.61% of notes and 40.44% of active time. Their original chart
timestamps are 0:23.938–0:35.724, 0:36.438–0:44.295,
1:15.367–1:27.152 and 1:27.867–1:35.724.

The new rule detects a sustained stream of short repeated shapes, including
fixed jumps with quad accents. Within 64 uninterrupted fast rows, at least
70% must participate in 3–11-hit repetitions and at least 35% must participate
in repeated chords. Ordinary single-finger triples with isolated chord
accents do not satisfy that second requirement. Long walls keep their own
section boundaries instead of expanding through this window.

The actual uploaded chart is OD5 and already fails the separate 4K dan OD5.5
floor. The regression fixture deliberately uses anonymous metadata and OD8;
changing it to OD5 produces the same vibro result. The pattern exclusion
therefore also protects MSD ratings, which do not use that dan OD floor.

Every legitimate chart in the reported regression set keeps the result in
the table above. Tests additionally verify that a formerly cached clean
player verdict is evicted and that a continuation from an older sweep
revision restarts at the beginning.

Verification: 2,798 backend tests, both TypeScript checks, and eight relevant
frontend tests passed on 2026-09-08. No build or deployment was run.

The final v2 audit rescanned the same 119,865 indexed 4K entries at normal
speed and DT, with 88,364 cached rice charts in scope and 40 unavailable files.
At normal speed, no ranked charts are excluded; the same five already-flagged
loved charts remain excluded. Three ranked charts have localized adjustments:
Ankoku Butoukai [J-X], Rush (Cut Ver.) [Titanium], and Fusyoku ressentiment,
fushiyoku no sarugakuza. [Monochrome Insanity]. Relative to the stored base
flags, 2,512 charts become eligible and 24 become newly excluded; none of those
new exclusions are ranked or loved. Eligibility changes are audit results,
not independent confirmation that each old flag was incorrect.

At DT, the only ranked exclusion is still 680 BPM Born Slippy [Luetin].
Dream of Us [Continuum] remains eligible: the repeated-chord requirement
prevents ordinary single-finger triples with chord accents from becoming a
new whole-chart exclusion. This audit applies a hypothetical DT rate to the
corpus; it does not establish which rates players actually cleared.

`live-backend/src/dan/vibro-sections.ts` returns section timestamps, reasons,
coverage and clean/adjusted/excluded status. Adjustment requires no more than
15% of active time and 25% of notes removed, at least 300 remaining notes and
20 seconds of remaining active time. Empty gaps contribute at most one second.
These are conservative initial bounds, not a claim of perfect technique
recognition.

The chart classifier, MinaCalc and Companella use the filtered note input with
timestamps preserved. Player dan reads an adjusted, versioned verdict and the
conservative retained-note accuracy. Structural note-stack eligibility is
checked before filtering. Original score evidence survives recalculation.

Player version 34 and detector stamp 9 recheck retained scores and reconsider
old exclusions. The v12 chart sweep repairs both directions, updates affected
ratings/search entries and recalculates existing DT/HT pairs. The versioned dan
cache invalidates older estimates; legacy 4K DT payloads cannot bypass it.
These repairs run through the existing jobs after deployment. The audit did
not mutate the local or production rating database.

Reproduce the corpus audit from `live-backend/`:

```sh
node --import tsx scripts/dev/audit-vibro.ts --output /tmp/vibro-normal.json
node --import tsx scripts/dev/audit-vibro.ts --rate 1.5 --output /tmp/vibro-dt.json
```

Regression fixtures in `tests/fixtures/vibro-charts.json.gz` contain only note
timings, columns, hold lengths and provenance. Tests cover the reported maps,
sustained-vibro controls, rate-edit equivalence, preserved timestamps,
conservative accuracy, old exclusion restoration and base/rate cache repair.
