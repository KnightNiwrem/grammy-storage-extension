import type { CodecRecord } from "./envelope.ts";

export type MaybePromise<T> = T | Promise<T>;

/** The result of a codec's `encode` step. */
export type EncodeResult = {
  /** The encoded body bytes. */
  readonly body: Uint8Array;
  /**
   * Plaintext metadata recorded alongside this codec in the envelope.
   * Must be JSON-serializable. Defaults to `{}` when omitted.
   */
  readonly meta?: Record<string, unknown>;
};

/**
 * The read-side half of a codec: enough to decode and expire records of its
 * id. Register one via `decoders` to keep reading rows produced by a codec
 * that is no longer applied on write.
 */
export interface BodyDecoder {
  /** A stable, unique identifier for this codec family. */
  readonly id: string;

  /**
   * Reverses the codec on read, given the record written for it.
   * Must throw if the body cannot be restored.
   */
  decode(
    body: Uint8Array,
    record: CodecRecord,
  ): MaybePromise<Uint8Array>;

  /**
   * Cheap expiry check based solely on the recorded metadata.
   * Returning `true` marks the whole entry as expired: the adapter deletes it
   * and treats it as absent without decoding the body.
   */
  isExpired?(record: CodecRecord): MaybePromise<boolean>;
}

/**
 * A body codec such as compression, encryption, or expiry tracking,
 * applied on write and undone on read.
 */
export interface BodyCodec extends BodyDecoder {
  /** The format version produced by `encode` (e.g. "1.0.0"). */
  readonly version: string;

  /** Encodes the body bytes on write and optionally attaches metadata. */
  encode(body: Uint8Array): MaybePromise<EncodeResult>;
}
