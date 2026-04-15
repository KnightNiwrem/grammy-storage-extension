/**
 * Core types for the extended storage adapter.
 *
 * @module
 */

/**
 * An envelope wrapping a value or another envelope for storage.
 *
 * Every persisted value is wrapped in at least one envelope. Codecs produce
 * and consume envelopes, each identified by the `codec` that last wrapped it.
 */
export type StorageEnvelope = {
  kind: "grammy-extended-storage-envelope";
  codec: string;
  version: number;
  payload: string;
};

/**
 * A codec that wraps and unwraps {@link StorageEnvelope} values.
 *
 * Envelope codecs form a composable chain: each codec accepts an inner
 * envelope and produces an outer envelope on write, and reverses the
 * process on read.
 */
export interface StorageEnvelopeCodec {
  readonly codec: string;
  readonly version: number;
  encode(
    envelope: StorageEnvelope,
  ): Promise<StorageEnvelope> | StorageEnvelope;
  decode(
    envelope: StorageEnvelope,
  ): Promise<StorageEnvelope | undefined> | StorageEnvelope | undefined;
}

/**
 * The terminal codec that converts between `T` and a {@link StorageEnvelope}.
 *
 * This interface is used internally by the built-in value codec and is
 * exposed for documentation purposes.
 */
export interface StorageValueCodec<T> {
  readonly codec: string;
  readonly version: number;
  encode(value: T): Promise<StorageEnvelope> | StorageEnvelope;
  decode(
    envelope: StorageEnvelope,
  ): Promise<T | undefined> | T | undefined;
}
