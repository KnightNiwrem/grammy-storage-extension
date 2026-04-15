/**
 * Extended storage adapter for grammY.
 *
 * @example
 * ```ts
 * import { createExtendedStorage } from "@niwrem/grammy-storage-extension";
 *
 * const storage = createExtendedStorage<MySession>({
 *   storage: backingAdapter,
 *   codecs: [myCompressionCodec],
 * });
 * ```
 *
 * @module
 */

export type {
  StorageEnvelope,
  StorageEnvelopeCodec,
  StorageValueCodec,
} from "./types.ts";

export {
  BUILTIN_VALUE_CODEC,
  BUILTIN_VALUE_CODEC_VERSION,
  MAX_DECODE_DEPTH,
  STORAGE_ENVELOPE_KIND,
} from "./constants.ts";

export { assertValidEnvelope } from "./validation.ts";

export {
  createExtendedStorage,
  type ExtendedStorageOptions,
} from "./extended_storage.ts";
