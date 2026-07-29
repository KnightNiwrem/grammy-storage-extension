export const STORAGE_ENVELOPE_KIND =
  "grammy-extended-storage-envelope" as const;
export const VALUE_CODEC_ID = "grammy-extended-storage-value" as const;
export const VALUE_CODEC_VERSION = "1.0.0" as const;
// Retained for backward compatibility only; the effective read depth limit
// is resolved at construction time (see CreateExtendedStorageOptions).
export const MAX_DECODE_DEPTH = 100 as const;
