import { randomBytes, randomInt } from "node:crypto";

/* Uniform float in [0, 1), drawn from the OS CSPRNG rather than Math.random.
   Math.random is a shared, seedable-looking PRNG whose stream is the same one
   every other call site on the process draws from; that is fine for animation
   jitter and wrong for anything a player would profit from predicting. Shaped
   as `() => number` so it drops straight into the `rng` parameters the pack
   features already take, and tests keep injecting their own deterministic one.

   53 bits of mantissa from 7 bytes, the same construction V8 uses, so the
   distribution is uniform rather than the subtly biased `bytes / 2**56`. */
export function secureRandom(): number {
  const bytes = randomBytes(7);
  let value = bytes[0]! & 0x1f; // 5 bits: 5 + 6*8 = 53
  for (let index = 1; index < 7; index += 1) value = value * 256 + bytes[index]!;
  return value / 2 ** 53;
}

/* Uniform integer in [0, max), rejection-sampled by node:crypto so the modulo
   bias of `Math.floor(random() * max)` never reaches an id alphabet. */
export function secureRandomInt(max: number): number {
  if (!Number.isInteger(max) || max <= 0) throw new RangeError("max must be a positive integer");
  return randomInt(max);
}

/* Draws `length` characters from `alphabet` without modulo bias. */
export function secureRandomId(alphabet: string, length: number): string {
  let id = "";
  for (let index = 0; index < length; index += 1) id += alphabet[secureRandomInt(alphabet.length)];
  return id;
}
