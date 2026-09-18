// Single cache version for both sides. Until this module was deduplicated the
// frontend kept its own copy that had drifted one behind (12 vs 13) while
// describing the same four changes under lower numbers, so a bump applied to
// one cache silently missed the other. The higher number won: keeping 13 leaves
// the backend's stored estimates valid and costs the frontend one recompute.
//
// v19 (current): 4K-only independent LN artifacts and effective-hold identity.
// Other keymodes retain their legacy LN calculation.
//
// v15: 4K LN routing handed to leoblack's LN interval table
// (chart-classifier), with the in-house kNN kept only below that table's LN 5
// floor, and the LN ladder opened up to its real top of 17 (16 Yokaze, 17
// Yeehee) instead of clamping labels at 15. Every cached 4K LN estimate that
// came from the kNN can move, in both directions, and the ones that were pinned
// at 15 gain their real level.
// Earlier bumps: `git log -S DAN_ESTIMATE_CACHE_VERSION`.
// v16: localized 4K rice vibro is removed before rating, including
// short fixed-pair/irregular jack windows and dense chord repetitions. Also
// includes LeoBlack's low-band Azusa/Companella fusion. These changes ship as
// one cache invalidation from production v15.
// v17: ordinary chart estimates rate every note. Localized vibro adjustment
// is reserved for player ratings and cached as its own internal chart variant.
// v18: refresh rate metadata and player variants for accompanied longjacks.
// Ordinary full-chart difficulty calculations themselves remain unchanged.
// v19: refresh repeated-burst coverage and the remaining-material variants.
// v20: enable marathon correction before Mixed routing and Companella fusion.
// Only 4K charts with original note spans over five minutes can move.
// v21: 4K-only independent LN artifacts and effective-hold identity.
// Other keymodes retain their legacy LN calculation.
// v22: tap-covered 4K holds do not become LN from geometric head overlap.
// v23: near-window chained 4K holds retain LN rearticulation work.
// v24: tap-covered chains contribute difficulty but cannot establish LN identity.
// v25: refresh player-adjusted verdicts after the articulated-chordjack and
// mixed-repetition fix. A stale terminal verdict must not suppress a restored
// clear, and the retained-note variants must use the new section boundaries.
// v26: refresh player-adjusted verdicts for the locked-pair reading and the
// body-repeat exclusion bar. Charts that leave the adjusted pool must stop
// serving a retained-note variant, and the ones that stay must use the new
// section boundaries.
// v27: refresh verdicts for the four-key cycle arm, which finds walls written
// as rotating chords and jumptrills.
// v28: 4K LN identity admits chain-dense windows (effective v5) and the LN
// rating follows rate like native MSD (LN v8); rate estimates carry both.
export const DAN_ESTIMATE_CACHE_VERSION = 28;
