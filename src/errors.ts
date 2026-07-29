export const EXTENDED_STORAGE_ERROR_CODES = {
  EMPTY_CODEC_ID: "ERR_EMPTY_CODEC_ID",
  RESERVED_CODEC_ID: "ERR_RESERVED_CODEC_ID",
  DUPLICATE_CODEC_ID: "ERR_DUPLICATE_CODEC_ID",
  INVALID_MAX_DECODE_DEPTH: "ERR_INVALID_MAX_DECODE_DEPTH",
  VALUE_SERIALIZATION: "ERR_VALUE_SERIALIZATION",
  INVALID_ENVELOPE: "ERR_INVALID_ENVELOPE",
  CODEC_IDENTITY_MISMATCH: "ERR_CODEC_IDENTITY_MISMATCH",
  UNSUPPORTED_VALUE_VERSION: "ERR_UNSUPPORTED_VALUE_VERSION",
  UNKNOWN_CODEC: "ERR_UNKNOWN_CODEC",
  DECODE_DEPTH_EXCEEDED: "ERR_DECODE_DEPTH_EXCEEDED",
} as const;

export type ExtendedStorageErrorCode = (typeof EXTENDED_STORAGE_ERROR_CODES)[
  keyof typeof EXTENDED_STORAGE_ERROR_CODES
];

/**
 * Base class for all errors raised by the adapter itself.
 * Errors thrown by custom codecs or by `JSON.parse` propagate unchanged.
 */
export class ExtendedStorageError extends Error {
  readonly code: ExtendedStorageErrorCode;

  constructor(
    code: ExtendedStorageErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ExtendedStorageError";
    this.code = code;
  }
}
