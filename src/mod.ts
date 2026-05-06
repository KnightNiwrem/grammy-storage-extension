export {
  MAX_DECODE_DEPTH,
  STORAGE_ENVELOPE_KIND,
  VALUE_CODEC_ID,
  VALUE_CODEC_VERSION,
} from "./constants.ts";
export { assertValidEnvelope } from "./envelope.ts";
export type { StorageEnvelope } from "./envelope.ts";
export type { MaybePromise, StorageEnvelopeCodec } from "./codec.ts";
export { createExtendedStorage } from "./create-extended-storage.ts";
export type {
  CreateExtendedStorageOptions,
} from "./create-extended-storage.ts";
