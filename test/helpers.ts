import {
  type BodyCodec,
  type BodyDecoder,
  type CodecRecord,
  ENVELOPE_DISCRIMINATOR,
  PACKAGE_VERSION,
  type SerializedEnvelope,
} from "../src/mod.ts";

export function validSerializedEnvelope(
  overrides: Partial<SerializedEnvelope> = {},
): SerializedEnvelope {
  return {
    discriminator: ENVELOPE_DISCRIMINATOR,
    version: PACKAGE_VERSION,
    codecs: [],
    encoding: "utf8",
    body: JSON.stringify({ ok: true }),
    ...overrides,
  };
}

export function record(
  id: string,
  overrides: Partial<CodecRecord> = {},
): CodecRecord {
  return { id, version: "1.0.0", meta: {}, ...overrides };
}

export type SpyCodecOptions = {
  version?: string;
  /** Fixed meta attached on encode. */
  meta?: Record<string, unknown>;
  /** Reverse the bytes so ordering is observable. Defaults to identity. */
  reverse?: boolean;
  encodeAsync?: boolean;
  decodeAsync?: boolean;
  /** Attach an `isExpired` predicate. A boolean is returned as-is. */
  expired?: boolean | ((record: CodecRecord) => boolean);
  onEncode?: (body: Uint8Array) => void;
  onDecode?: (body: Uint8Array, record: CodecRecord) => void;
};

export type SpyCodec = BodyCodec & {
  calls: { encode: number; decode: number; isExpired: number };
};

export function spyCodec(
  id: string,
  options: SpyCodecOptions = {},
): SpyCodec {
  const calls = { encode: 0, decode: 0, isExpired: 0 };
  const apply = (bytes: Uint8Array): Uint8Array =>
    options.reverse ? Uint8Array.from(bytes).reverse() : bytes;

  const codec: BodyCodec = {
    id,
    version: options.version ?? "1.0.0",
    encode(body) {
      calls.encode++;
      options.onEncode?.(body);
      const output = { body: apply(body), meta: options.meta };
      return options.encodeAsync ? Promise.resolve(output) : output;
    },
    decode(body, record) {
      calls.decode++;
      options.onDecode?.(body, record);
      const output = apply(body);
      return options.decodeAsync ? Promise.resolve(output) : output;
    },
  };

  if (options.expired !== undefined) {
    const expired = options.expired;
    codec.isExpired = (record) => {
      calls.isExpired++;
      return typeof expired === "function" ? expired(record) : expired;
    };
  }

  return Object.assign(codec, { calls });
}

// The gzip and ttl codecs are the canonical worked examples in `examples/`.
// Re-export thin wrappers here so the test suite exercises the same code the
// README documents, and call sites keep their (id, ttlMs, now) signatures.
import { gzip } from "../examples/gzip.ts";
import { ttl } from "../examples/ttl.ts";

export function ttlCodec(
  id: string,
  ttlMs: number,
  now: () => number = Date.now,
): BodyCodec {
  return ttl(ttlMs, id, now);
}

export function gzipCodec(id = "gzip"): BodyCodec {
  return gzip(id);
}

export type ReadOnlySpy = BodyDecoder & {
  calls: { decode: number; isExpired: number };
};

/** A decode-only codec with no `encode`, for `decoders`. */
export function readOnlySpy(
  id: string,
  options: {
    reverse?: boolean;
    expired?: boolean | ((record: CodecRecord) => boolean);
    onDecode?: (body: Uint8Array, record: CodecRecord) => void;
  } = {},
): ReadOnlySpy {
  const calls = { decode: 0, isExpired: 0 };
  const decoder: BodyDecoder = {
    id,
    decode(body, record) {
      calls.decode++;
      options.onDecode?.(body, record);
      return options.reverse ? Uint8Array.from(body).reverse() : body;
    },
  };
  if (options.expired !== undefined) {
    const expired = options.expired;
    decoder.isExpired = (record) => {
      calls.isExpired++;
      return typeof expired === "function" ? expired(record) : expired;
    };
  }
  return Object.assign(decoder, { calls });
}
