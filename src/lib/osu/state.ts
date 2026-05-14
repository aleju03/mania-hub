import type {
  OsuScore,
  OsuUser
} from "../types";
import type { OscScore } from "./internal-types";

export const userRecentPlaysPromiseCache = new Map<number, Promise<OsuScore[]>>();
export const userPromiseCache = new Map<string, Promise<OsuUser>>();
export const userScoresListPromiseCache = new Map<string, Promise<OsuScore[]>>();
export const rankHistoryPromiseCache = new Map<number, Promise<number[] | null>>();
export const bestScoresWindowPromiseCache = new Map<string, Promise<OsuScore[]>>();
export const oscRecentScoresPromiseCache = new Map<string, Promise<OscScore[]>>();
