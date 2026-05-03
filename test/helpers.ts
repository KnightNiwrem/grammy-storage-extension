import {
  BUILTIN_VALUE_CODEC,
  BUILTIN_VALUE_CODEC_VERSION,
  STORAGE_ENVELOPE_KIND,
  type StorageEnvelope,
  type StorageEnvelopeCodec,
} from "../src/mod.ts";

export function validEnvelope(
  overrides: Partial<StorageEnvelope> = {},
): StorageEnvelope {
  return {
    kind: STORAGE_ENVELOPE_KIND,
    codec: BUILTIN_VALUE_CODEC,
    version: BUILTIN_VALUE_CODEC_VERSION,
    payload: JSON.stringify({ ok: true }),
    ...overrides,
  };
}

export function missingCodec(codec: string): StorageEnvelopeCodec {
  return {
    codec,
    version: "1.0.0",
    encode(envelope) {
      return validEnvelope({
        codec,
        version: "1.0.0",
        payload: JSON.stringify(envelope),
      });
    },
    decode() {
      return undefined;
    },
  };
}
