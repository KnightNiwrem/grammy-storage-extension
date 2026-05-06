import type { StorageEnvelope } from "./envelope.ts";

export type MaybePromise<T> = T | Promise<T>;

export interface StorageEnvelopeCodec {
  readonly codec: string;
  readonly version: string;
  encode(envelope: StorageEnvelope): MaybePromise<StorageEnvelope>;
  decode(envelope: StorageEnvelope): MaybePromise<StorageEnvelope | undefined>;
}

export interface StorageValueCodec<T> {
  readonly codec: string;
  readonly version: string;
  encode(value: T): MaybePromise<StorageEnvelope>;
  decode(envelope: StorageEnvelope): MaybePromise<T | undefined>;
}
