// Keep in sync with the other pack-limits.ts (frontend/live backend).
export const PACK_MAX_BASE_CARDS = 10;
// Chain pulls deal up to this many extra ordinary cards (shared/pack-run.ts).
export const PACK_MAX_CHAIN_CARDS = 3;
// Random player Eternal, own completion Eternal, and one milestone.
export const PACK_MAX_PLAYER_CARDS = PACK_MAX_BASE_CARDS + PACK_MAX_CHAIN_CARDS + 3;
// Own completion and milestone share the opener's player id.
export const PACK_MAX_PLAYER_IDS = PACK_MAX_BASE_CARDS + PACK_MAX_CHAIN_CARDS + 2;
// Regular team bonus and random Eternal team. Keep one legacy slot for
// pending hands dealt before team completion became a pool-only unlock.
export const PACK_MAX_CARDS = PACK_MAX_PLAYER_CARDS + 3;
