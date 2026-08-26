// Single cache version for both sides. Until this module was deduplicated the
// frontend kept its own copy that had drifted one behind (12 vs 13) while
// describing the same four changes under lower numbers, so a bump applied to
// one cache silently missed the other. The higher number won: keeping 13 leaves
// the backend's stored estimates valid and costs the frontend one recompute.
//
// v10: LN kNN reference set extended with the curated benchmark corpus (ln.ts);
// out-of-corpus charts no longer over-rate through the ln-pressure regression.
// v11: upstream leoblack fix for the 4K LN interval table (osumania_map_analyser
// PR #38): the 4.963-5.213 band had an inverted LN 6 mid/low range, so cached
// estimates in that window carry wrong labels.
// v12: Companella wired (companella.ts). The RC half of 4K LN-hybrid charts
// under 9 Sunny stars now comes from the ONNX model instead of the Sunny
// fallback, which moves roughly a fifth of cached 4K estimates.
// v13: leoblack re-pinned at upstream 261e76f. Sunny SR now matches the
// authoritative C# osu-author-port (stepInterp exact-match, LN tails in the
// percentile weights, first note dropped), shifting cached estimates near
// interval boundaries; LN-weighted charts move the most.
// v14: leoblack re-pinned at upstream 214aedd. Roxy is now high-difficulty-only
// (final numeric outside 11..17 routes to Azusa), its output is blended 0.4
// toward Azusa, and its meta model was retrained (ordinal target), so every
// cached 4K RC estimate that Mixed sends through Roxy/Azusa can move. The
// MinaCalc 40->100 skill-cap patch also lands here; it only moves charts that
// had a skillset pinned at 40.
// v15: 4K LN routing handed to leoblack's LN interval table (chart-classifier),
// with the in-house kNN kept only below that table's LN 5 floor, and the LN
// ladder opened up to its real top of 17 (16 Yokaze, 17 Yeehee) instead of
// clamping labels at 15. Every cached 4K LN estimate that came from the kNN can
// move, in both directions, and the ones that were pinned at 15 gain their real
// level.
export const DAN_ESTIMATE_CACHE_VERSION = 15;
