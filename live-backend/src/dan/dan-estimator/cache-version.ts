// v10: LN kNN reference set extended with the curated benchmark corpus (ln.ts);
// out-of-corpus charts no longer over-rate through the ln-pressure regression.
// v11: upstream leoblack fix for the 4K LN interval table (osumania_map_analyser
// PR #38): the 4.963-5.213 band had an inverted LN 6 mid/low range, so cached
// estimates in that window carry wrong labels.
export const DAN_ESTIMATE_CACHE_VERSION = 11;
