// v9: LN kNN reference set extended with the curated benchmark corpus (ln.ts);
// out-of-corpus charts no longer over-rate through the ln-pressure regression.
// v10: upstream leoblack fix for the 4K LN interval table (osumania_map_analyser
// PR #38): the 4.963-5.213 band had an inverted LN 6 mid/low range.
// v11: Companella wired (companella.ts). The RC half of 4K LN-hybrid charts
// under 9 Sunny stars now comes from the ONNX model instead of the Sunny
// fallback, which moves roughly a fifth of cached 4K estimates.
// v12: leoblack re-pinned at upstream 261e76f. Sunny SR now matches the
// authoritative C# osu-author-port (stepInterp exact-match, LN tails in the
// percentile weights, first note dropped), shifting cached estimates near
// interval boundaries; LN-weighted charts move the most.
export const DAN_ESTIMATE_CACHE_VERSION = 12;
