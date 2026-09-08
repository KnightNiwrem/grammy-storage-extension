import {
  PACKAGE_VERSION,
  STORAGE_ENVELOPE_KIND,
  type StorageEnvelope,
  type StorageReadOnlyTransform,
  type StorageTransform,
  type StorageTransformRecord,
} from "../src/mod.ts";

export function validEnvelope(
  overrides: Partial<StorageEnvelope> = {},
): StorageEnvelope {
  return {
    kind: STORAGE_ENVELOPE_KIND,
    version: PACKAGE_VERSION,
    transforms: [],
    encoding: "utf8",
    body: JSON.stringify({ ok: true }),
    ...overrides,
  };
}

export function record(
  kind: string,
  overrides: Partial<StorageTransformRecord> = {},
): StorageTransformRecord {
  return { kind, version: "1.0.0", meta: {}, ...overrides };
}

export type SpyTransformOptions = {
  version?: string;
  /** Fixed meta attached on encode. */
  meta?: Record<string, unknown>;
  /** Reverse the bytes so ordering is observable. Defaults to identity. */
  reverse?: boolean;
  encodeAsync?: boolean;
  decodeAsync?: boolean;
  /** Attach an `isExpired` predicate. A boolean is returned as-is. */
  expired?: boolean | ((record: StorageTransformRecord) => boolean);
  onEncode?: (body: Uint8Array) => void;
  onDecode?: (body: Uint8Array, record: StorageTransformRecord) => void;
};

export type SpyTransform = StorageTransform & {
  calls: { encode: number; decode: number; isExpired: number };
};

export function spyTransform(
  kind: string,
  options: SpyTransformOptions = {},
): SpyTransform {
  const calls = { encode: 0, decode: 0, isExpired: 0 };
  const apply = (bytes: Uint8Array): Uint8Array =>
    options.reverse ? Uint8Array.from(bytes).reverse() : bytes;

  const transform: StorageTransform = {
    kind,
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
    transform.isExpired = (record) => {
      calls.isExpired++;
      return typeof expired === "function" ? expired(record) : expired;
    };
  }

  return Object.assign(transform, { calls });
}

export function ttlTransform(
  kind: string,
  ttlMs: number,
  now: () => number = Date.now,
): StorageTransform {
  return {
    kind,
    version: "1.0.0",
    encode(body) {
      return { body, meta: { expiresAt: now() + ttlMs } };
    },
    decode(body) {
      return body;
    },
    isExpired(record) {
      const expiresAt = record.meta.expiresAt;
      return typeof expiresAt === "number" && now() >= expiresAt;
    },
  };
}

async function pipeThrough(
  bytes: Uint8Array,
  stream: ReadableWritablePair<Uint8Array, BufferSource>,
): Promise<Uint8Array> {
  const source = new Blob([bytes as BlobPart]).stream().pipeThrough(stream);
  return new Uint8Array(await new Response(source).arrayBuffer());
}

export function gzipTransform(kind = "gzip"): StorageTransform {
  return {
    kind,
    version: "1.0.0",
    async encode(body) {
      return {
        body: await pipeThrough(body, new CompressionStream("gzip")),
        meta: { rawLength: body.byteLength },
      };
    },
    decode(body) {
      return pipeThrough(body, new DecompressionStream("gzip"));
    },
  };
}

export type ReadOnlySpy = StorageReadOnlyTransform & {
  calls: { decode: number; isExpired: number };
};

/** A decode-only transform with no `encode`, for `readOnlyTransforms`. */
export function readOnlySpy(
  kind: string,
  options: {
    reverse?: boolean;
    expired?: boolean | ((record: StorageTransformRecord) => boolean);
    onDecode?: (body: Uint8Array, record: StorageTransformRecord) => void;
  } = {},
): ReadOnlySpy {
  const calls = { decode: 0, isExpired: 0 };
  const transform: StorageReadOnlyTransform = {
    kind,
    decode(body, record) {
      calls.decode++;
      options.onDecode?.(body, record);
      return options.reverse ? Uint8Array.from(body).reverse() : body;
    },
  };
  if (options.expired !== undefined) {
    const expired = options.expired;
    transform.isExpired = (record) => {
      calls.isExpired++;
      return typeof expired === "function" ? expired(record) : expired;
    };
  }
  return Object.assign(transform, { calls });
}
