/** Random bytes from the platform: `crypto.getRandomValues` in Node, `expo-crypto` on a phone. */
export type RandomBytes = (length: number) => Uint8Array;

/**
 * A UUIDv7: 48 bits of milliseconds, then randomness (RFC 9562).
 *
 * The id of every change the phone makes, and the server's key for applying it
 * once. Time-ordered ids keep the server's index compact; nothing relies on the
 * time in them being right, because the phone's clock may not be — uniqueness
 * comes from the 74 random bits.
 */
export function uuidv7(milliseconds: number, random: RandomBytes): string {
  const bytes = random(16);
  if (bytes.length !== 16) {
    throw new Error('uuidv7 needs 16 random bytes');
  }
  let time = Math.max(0, Math.floor(milliseconds));
  for (let index = 5; index >= 0; index -= 1) {
    bytes[index] = time % 256;
    time = Math.floor(time / 256);
  }
  bytes[6] = (bytes[6]! & 0x0f) | 0x70;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
