import { STORAGE_ENVELOPE_KIND } from "./constants.ts";
import {
  EXTENDED_STORAGE_ERROR_CODES,
  ExtendedStorageError,
} from "./errors.ts";

export type StorageEnvelope = {
  readonly kind: typeof STORAGE_ENVELOPE_KIND;
  readonly codec: string;
  readonly version: string;
  readonly payload: string;
};

export function assertValidEnvelope(
  value: unknown,
): asserts value is StorageEnvelope {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ExtendedStorageError(
      EXTENDED_STORAGE_ERROR_CODES.INVALID_ENVELOPE,
      "Invalid envelope: expected a non-null object",
    );
  }

  const envelope = value as Record<string, unknown>;

  if (envelope.kind !== STORAGE_ENVELOPE_KIND) {
    throw new ExtendedStorageError(
      EXTENDED_STORAGE_ERROR_CODES.INVALID_ENVELOPE,
      "Invalid envelope kind",
    );
  }
  if (typeof envelope.codec !== "string" || envelope.codec.length === 0) {
    throw new ExtendedStorageError(
      EXTENDED_STORAGE_ERROR_CODES.INVALID_ENVELOPE,
      "Invalid envelope codec",
    );
  }
  if (typeof envelope.version !== "string") {
    throw new ExtendedStorageError(
      EXTENDED_STORAGE_ERROR_CODES.INVALID_ENVELOPE,
      "Invalid envelope version",
    );
  }
  if (typeof envelope.payload !== "string") {
    throw new ExtendedStorageError(
      EXTENDED_STORAGE_ERROR_CODES.INVALID_ENVELOPE,
      "Invalid envelope payload",
    );
  }
}
