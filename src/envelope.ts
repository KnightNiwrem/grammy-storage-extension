import { bytesToText, decodeBody, encodeBody } from "./body.ts";
import { ENVELOPE_DISCRIMINATOR } from "./constants.ts";
import {
  EXTENDED_STORAGE_ERROR_CODES,
  ExtendedStorageError,
} from "./errors.ts";

/** How the serialized envelope `body` string encodes the underlying bytes. */
export type StorageBodyEncoding = "utf8" | "base64";

/** One entry in the ordered list of codecs applied to an envelope body. */
export type CodecRecord = {
  readonly id: string;
  readonly version: string;
  readonly meta: Readonly<Record<string, unknown>>;
};

/**
 * The in-memory working form the codec pipeline operates on. Internal to the
 * adapter and intentionally **not** exported (see spec §1, §3): a library user
 * only ever sees the persisted {@link SerializedEnvelope}.
 *
 * Its `body` is raw bytes, so — unlike the serialized form — it carries no
 * `encoding` field: bytes need no encoding descriptor. The adapter builds one on
 * write by advancing it a codec at a time (replacing `body`, appending a
 * {@link CodecRecord}), and reconstructs one on read for the reverse body pass.
 */
export type Envelope = {
  readonly discriminator: typeof ENVELOPE_DISCRIMINATOR;
  readonly version: string;
  readonly codecs: readonly CodecRecord[];
  readonly body: Uint8Array;
};

/** The standardized container stored physically in the database. */
export type SerializedEnvelope = {
  readonly discriminator: typeof ENVELOPE_DISCRIMINATOR;
  readonly version: string;
  readonly codecs: readonly CodecRecord[];
  readonly encoding: StorageBodyEncoding;
  readonly body: string;
};

/**
 * Serializes the internal {@link Envelope} working form for physical storage,
 * encoding its `body` bytes as the given string `encoding` (see spec §5.2).
 */
export function serializeEnvelope(
  envelope: Envelope,
  encoding: StorageBodyEncoding,
): SerializedEnvelope {
  return {
    discriminator: envelope.discriminator,
    version: envelope.version,
    codecs: envelope.codecs,
    encoding,
    body: encoding === "utf8"
      ? bytesToText(envelope.body)
      : encodeBody(envelope.body),
  };
}

/**
 * Reconstructs the internal {@link Envelope} working form from a validated
 * {@link SerializedEnvelope}, decoding its `body` string back to bytes
 * according to the stored `encoding` (see spec §10). Base64/UTF-8 decoding
 * errors propagate unchanged.
 */
export function deserializeEnvelope(
  serialized: SerializedEnvelope,
): Envelope {
  return {
    discriminator: serialized.discriminator,
    version: serialized.version,
    codecs: serialized.codecs,
    body: decodeBody(serialized.body, serialized.encoding),
  };
}

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

export function assertValidSerializedEnvelope(
  value: unknown,
): asserts value is SerializedEnvelope {
  if (!isPlainObject(value)) {
    throw invalid("Invalid envelope: expected a non-null object");
  }

  if (value.discriminator !== ENVELOPE_DISCRIMINATOR) {
    throw invalid("Invalid envelope discriminator");
  }
  if (typeof value.version !== "string") {
    throw invalid("Invalid envelope version");
  }
  if (!Array.isArray(value.codecs)) {
    throw invalid("Invalid envelope codecs: expected an array");
  }
  for (let i = 0; i < value.codecs.length; i++) {
    const record: unknown = value.codecs[i];
    if (!isPlainObject(record)) {
      throw invalid(`Invalid envelope codec at index ${i}`);
    }
    if (typeof record.id !== "string" || record.id.length === 0) {
      throw invalid(`Invalid envelope codec id at index ${i}`);
    }
    if (typeof record.version !== "string") {
      throw invalid(`Invalid envelope codec version at index ${i}`);
    }
    if (!isPlainObject(record.meta)) {
      throw invalid(`Invalid envelope codec meta at index ${i}`);
    }
  }
  if (value.encoding !== "utf8" && value.encoding !== "base64") {
    throw invalid("Invalid envelope encoding");
  }
  if (typeof value.body !== "string") {
    throw invalid("Invalid envelope body");
  }
}
