/**
 * Worked example: a time-to-live (TTL) transform.
 *
 * A metadata-only {@link StorageTransform}: it stamps each write with an expiry
 * timestamp and reports the entry as expired once that time passes. The body is
 * never rewritten, and the `isExpired` check reads the plaintext `meta` only —
 * so `has` and `readAllKeys` never decode the body to decide expiry.
 *
 * The `now` clock is injectable so tests can drive expiry deterministically;
 * it defaults to `Date.now`.
 */
import type { StorageTransform } from "../src/mod.ts";

export function ttl(
  ttlMilliseconds: number,
  kind = "example:ttl",
  now: () => number = () => Date.now(),
): StorageTransform {
  if (!Number.isFinite(ttlMilliseconds) || ttlMilliseconds <= 0) {
    throw new RangeError(
      `ttl requires a positive duration, got ${ttlMilliseconds}`,
    );
  }
  return {
    kind,
    version: "1.0.0",
    encode: (body) => ({
      body,
      meta: { expiresAt: now() + ttlMilliseconds },
    }),
    decode: (body) => body,
    // Reads the plaintext meta only; the body is never decoded for this check.
    isExpired: (record) => {
      const expiresAtMilliseconds = record.meta.expiresAt;
      // Malformed stored metadata must not silently pass as a live entry.
      if (!Number.isFinite(expiresAtMilliseconds)) {
        throw new Error(
          `${record.kind}: invalid meta.expiresAt ${
            JSON.stringify(expiresAtMilliseconds)
          }`,
        );
      }
      return now() >= (expiresAtMilliseconds as number);
    },
  };
}
