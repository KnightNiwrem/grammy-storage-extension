export {
  BUILTIN_VALUE_CODEC,
  BUILTIN_VALUE_CODEC_VERSION,
  MAX_DECODE_DEPTH,
  STORAGE_ENVELOPE_KIND,
} from "./constants.ts";
export { assertValidEnvelope } from "./envelope.ts";
export type { StorageEnvelope } from "./envelope.ts";
export type {
  MaybePromise,
  StorageEnvelopeCodec,
  StorageValueCodec,
} from "./codec-types.ts";
export { createExtendedStorage } from "./factory.ts";
