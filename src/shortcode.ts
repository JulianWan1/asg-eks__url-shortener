import { randomInt } from "node:crypto";

const ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
const CODE_LENGTH = 7;

// A 7-char base62 code gives 62^7 ≈ 3.5 trillion possibilities, so random
// collisions are vanishingly rare at this scale. We still handle the collision
// case in db-land (unique PK + retry) rather than assuming it can't happen —
// that's the honest way to do it and it's a good habit to show.
export function generateCode(): string {
  let out = "";
  for (let i = 0; i < CODE_LENGTH; i++) {
    out += ALPHABET[randomInt(ALPHABET.length)];
  }
  return out;
}
