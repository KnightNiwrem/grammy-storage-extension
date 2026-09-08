import { STORAGE_ENVELOPE_KIND } from "./constants.ts";
import {
  EXTENDED_STORAGE_ERROR_CODES,
  ExtendedStorageError,
} from "./errors.ts";

/** How the envelope `body` string encodes the underlying bytes. */
export type StorageBodyEncoding = "utf8" | "base64";

/** One entry in the ordered list of transforms applied to an envelope body. */
export type StorageTransformRecord = {
  readonly kind: string;
  readonly version: string;
  readonly meta: Readonly<Record<string, unknown>>;
};

/** The standardized container stored physically in the database. */
export type StorageEnvelope = {
  readonly kind: typeof STORAGE_ENVELOPE_KIND;
  readonly version: string;
  readonly transforms: readonly StorageTransformRecord[];
  readonly encoding: StorageBodyEncoding;
  readonly body: string;
};

export function isPlainObject(
  value: unknown,
): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalid(message: string): ExtendedStorageError {
  return new ExtendedStorageError(
    EXTENDED_STORAGE_ERROR_CODES.INVALID_ENVELOPE,
    message,
  );
}

export function assertValidEnvelope(
  value: unknown,
): asserts value is StorageEnvelope {
  if (!isPlainObject(value)) {
    throw invalid("Invalid envelope: expected a non-null object");
  }

  if (value.kind !== STORAGE_ENVELOPE_KIND) {
    throw invalid("Invalid envelope kind");
  }
  if (typeof value.version !== "string") {
    throw invalid("Invalid envelope version");
  }
  if (!Array.isArray(value.transforms)) {
    throw invalid("Invalid envelope transforms: expected an array");
  }
  for (let i = 0; i < value.transforms.length; i++) {
    const record: unknown = value.transforms[i];
    if (!isPlainObject(record)) {
      throw invalid(`Invalid envelope transform at index ${i}`);
    }
    if (typeof record.kind !== "string" || record.kind.length === 0) {
      throw invalid(`Invalid envelope transform kind at index ${i}`);
    }
    if (typeof record.version !== "string") {
      throw invalid(`Invalid envelope transform version at index ${i}`);
    }
    if (!isPlainObject(record.meta)) {
      throw invalid(`Invalid envelope transform meta at index ${i}`);
    }
  }
  if (value.encoding !== "utf8" && value.encoding !== "base64") {
    throw invalid("Invalid envelope encoding");
  }
  if (typeof value.body !== "string") {
    throw invalid("Invalid envelope body");
  }
}
