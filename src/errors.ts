export const EXTENDED_STORAGE_ERROR_CODES = {
  EMPTY_TRANSFORM_KIND: "ERR_EMPTY_TRANSFORM_KIND",
  RESERVED_TRANSFORM_KIND: "ERR_RESERVED_TRANSFORM_KIND",
  DUPLICATE_TRANSFORM_KIND: "ERR_DUPLICATE_TRANSFORM_KIND",
  VALUE_SERIALIZATION: "ERR_VALUE_SERIALIZATION",
  INVALID_ENVELOPE: "ERR_INVALID_ENVELOPE",
  INVALID_TRANSFORM_OUTPUT: "ERR_INVALID_TRANSFORM_OUTPUT",
  UNKNOWN_TRANSFORM: "ERR_UNKNOWN_TRANSFORM",
} as const;

export type ExtendedStorageErrorCode = (typeof EXTENDED_STORAGE_ERROR_CODES)[
  keyof typeof EXTENDED_STORAGE_ERROR_CODES
];

/**
 * Base class for all errors raised by the adapter itself.
 * Errors thrown by transforms, by base64 decoding, by UTF-8 decoding, or by
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
