// Keep in sync with the other pack-limits.ts (frontend/live backend).
export const PACK_MAX_BASE_CARDS = 10;
// Random player Eternal, own completion Eternal, and one milestone.
export const PACK_MAX_PLAYER_CARDS = PACK_MAX_BASE_CARDS + 3;
// Own completion and milestone share the opener's player id.
export const PACK_MAX_PLAYER_IDS = PACK_MAX_BASE_CARDS + 2;
// Regular team bonus, random Eternal team, and team completion Eternal.
export const PACK_MAX_CARDS = PACK_MAX_PLAYER_CARDS + 3;
