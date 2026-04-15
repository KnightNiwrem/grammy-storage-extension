/**
 * Reserved identifiers and limits for the extended storage adapter.
 *
 * @module
 */

/** Discriminator value for all storage envelopes. */
export const STORAGE_ENVELOPE_KIND = "grammy-extended-storage-envelope";

/** Codec identifier for the built-in JSON value codec. */
export const BUILTIN_VALUE_CODEC = "grammy-extended-storage-value";

/** Current version of the built-in value codec. */
export const BUILTIN_VALUE_CODEC_VERSION = 1;

/** Maximum number of decode iterations before the adapter throws. */
export const MAX_DECODE_DEPTH = 100;
