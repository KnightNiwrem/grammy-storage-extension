import type { StorageTransformRecord } from "./envelope.ts";

export type MaybePromise<T> = T | Promise<T>;

/** The result of a transform's `encode` step. */
export type StorageTransformOutput = {
  /** The transformed body bytes. */
  readonly body: Uint8Array;
  /**
   * Plaintext metadata recorded alongside this transform in the envelope.
   * Must be JSON-serializable. Defaults to `{}` when omitted.
   */
  readonly meta?: Record<string, unknown>;
};

/**
 * The read-side half of a transform: enough to decode and expire records of
 * its kind. Register one via `readOnlyTransforms` to keep reading rows
 * produced by a transform that is no longer applied on write.
 */
export interface StorageReadOnlyTransform {
  /** A stable, unique identifier for this transform family. */
  readonly kind: string;

  /**
   * Reverses the transform on read, given the record written for it.
   * Must throw if the body cannot be restored.
   */
  decode(
    body: Uint8Array,
    record: StorageTransformRecord,
  ): MaybePromise<Uint8Array>;

  /**
   * Cheap expiry check based solely on the recorded metadata.
   * Returning `true` marks the whole entry as expired: the adapter deletes it
   * and treats it as absent without decoding the body.
   */
  isExpired?(record: StorageTransformRecord): MaybePromise<boolean>;
}

/**
 * A body transform such as compression, encryption, or expiry tracking,
 * applied on write and undone on read.
 */
export interface StorageTransform extends StorageReadOnlyTransform {
  /** The format version produced by `encode` (e.g. "1.0.0"). */
  readonly version: string;

  /** Transforms the body bytes on write and optionally attaches metadata. */
  encode(body: Uint8Array): MaybePromise<StorageTransformOutput>;
}
