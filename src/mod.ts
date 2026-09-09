export { ENVELOPE_DISCRIMINATOR } from "./constants.ts";
export { PACKAGE_VERSION } from "./version.ts";
export { assertValidSerializedEnvelope } from "./envelope.ts";
export type {
  CodecRecord,
  SerializedEnvelope,
  StorageBodyEncoding,
} from "./envelope.ts";
export {
  EXTENDED_STORAGE_ERROR_CODES,
  ExtendedStorageError,
} from "./errors.ts";
export type { ExtendedStorageErrorCode } from "./errors.ts";
export type {
  BodyCodec,
  BodyDecoder,
  EncodeResult,
  MaybePromise,
} from "./codec.ts";
export { createExtendedStorage } from "./create-extended-storage.ts";
export type {
  CreateExtendedStorageOptions,
} from "./create-extended-storage.ts";
