export const EXTENDED_STORAGE_ERROR_CODES = {
  INVALID_CODEC_ID: "ERR_INVALID_CODEC_ID",
  DUPLICATE_CODEC_ID: "ERR_DUPLICATE_CODEC_ID",
  VALUE_SERIALIZATION: "ERR_VALUE_SERIALIZATION",
  INVALID_ENVELOPE: "ERR_INVALID_ENVELOPE",
  INVALID_CODEC_OUTPUT: "ERR_INVALID_CODEC_OUTPUT",
  UNKNOWN_CODEC: "ERR_UNKNOWN_CODEC",
} as const;

export type ExtendedStorageErrorCode = (typeof EXTENDED_STORAGE_ERROR_CODES)[
  keyof typeof EXTENDED_STORAGE_ERROR_CODES
];

/**
 * Base class for all errors raised by the adapter itself.
 * Errors thrown by codecs, by base64 decoding, by UTF-8 decoding, or by
 * `JSON.parse` propagate unchanged.
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
