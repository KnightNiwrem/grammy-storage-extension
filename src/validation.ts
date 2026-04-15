/**
 * Envelope validation utilities.
 *
 * @module
 */

import { STORAGE_ENVELOPE_KIND } from "./constants.ts";
import type { StorageEnvelope } from "./types.ts";

/**
 * Asserts that `value` is a structurally valid {@link StorageEnvelope}.
 *
 * Throws with a descriptive message when any invariant is violated.
 */
export function assertValidEnvelope(
  value: unknown,
): asserts value is StorageEnvelope {
  if (typeof value !== "object" || value === null) {
    throw new Error("Invalid envelope");
  }
  const v = value as Record<string, unknown>;
  if (v.kind !== STORAGE_ENVELOPE_KIND) {
    throw new Error("Invalid envelope kind");
  }
  if (typeof v.codec !== "string" || v.codec.length === 0) {
    throw new Error("Invalid envelope codec");
  }
  if (!Number.isInteger(v.version) || (v.version as number) < 0) {
    throw new Error("Invalid envelope version");
  }
  if (typeof v.payload !== "string") {
    throw new Error("Invalid envelope payload");
  }
}
