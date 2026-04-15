import { assertEquals, assertRejects, assertThrows } from "@std/assert";

import {
  BUILTIN_VALUE_CODEC,
  BUILTIN_VALUE_CODEC_VERSION,
  createExtendedStorage,
  MAX_DECODE_DEPTH,
  STORAGE_ENVELOPE_KIND,
  type StorageAdapter,
  type StorageEnvelope,
  type StorageEnvelopeCodec,
} from "./mod.ts";

class MemoryStorage<T> implements StorageAdapter<T> {
  readonly values = new Map<string, T>();

  read(key: string): T | undefined {
    return this.values.get(key);
  }

  write(key: string, value: T): void {
    this.values.set(key, value);
  }

  delete(key: string): void {
    this.values.delete(key);
  }

  has(key: string): boolean {
    return this.values.has(key);
  }

  *readAllKeys(): Iterable<string> {
    yield* this.values.keys();
  }

  *readAllValues(): Iterable<T> {
    yield* this.values.values();
  }

  *readAllEntries(): Iterable<[string, T]> {
    yield* this.values.entries();
  }
}

Deno.test("write wraps value codec and outer codecs in declaration order", async () => {
  const storage = new MemoryStorage<StorageEnvelope>();
  const seen: StorageEnvelope[] = [];

  const codecA: StorageEnvelopeCodec = {
    codec: "codec-a",
    version: 2,
    encode(envelope) {
      seen.push(envelope);
      return wrapEnvelope(this.codec, this.version, envelope);
    },
    decode(envelope) {
      return unwrapEnvelope(this.codec, envelope);
    },
  };

  const codecB: StorageEnvelopeCodec = {
    codec: "codec-b",
    version: 5,
    encode(envelope) {
      seen.push(envelope);
      return wrapEnvelope(this.codec, this.version, envelope);
    },
    decode(envelope) {
      return unwrapEnvelope(this.codec, envelope);
    },
  };

  const adapter = createExtendedStorage<number>({
    storage,
    codecs: [codecA, codecB],
  });

  await adapter.write("answer", 42);

  assertEquals(seen, [
    {
      kind: STORAGE_ENVELOPE_KIND,
      codec: BUILTIN_VALUE_CODEC,
      version: BUILTIN_VALUE_CODEC_VERSION,
      payload: "42",
    },
    {
      kind: STORAGE_ENVELOPE_KIND,
      codec: "codec-a",
      version: 2,
      payload: JSON.stringify({
        kind: STORAGE_ENVELOPE_KIND,
        codec: BUILTIN_VALUE_CODEC,
        version: BUILTIN_VALUE_CODEC_VERSION,
        payload: "42",
      }),
    },
  ]);

  assertEquals(storage.values.get("answer"), {
    kind: STORAGE_ENVELOPE_KIND,
    codec: "codec-b",
    version: 5,
    payload: JSON.stringify({
      kind: STORAGE_ENVELOPE_KIND,
      codec: "codec-a",
      version: 2,
      payload: JSON.stringify({
        kind: STORAGE_ENVELOPE_KIND,
        codec: BUILTIN_VALUE_CODEC,
        version: BUILTIN_VALUE_CODEC_VERSION,
        payload: "42",
      }),
    }),
  });
});

Deno.test("read routes by codec id and ignores declaration order", async () => {
  const storage = new MemoryStorage<StorageEnvelope>();
  const adapter = createExtendedStorage<{ ok: boolean }>({
    storage,
    codecs: [
      namedCodec("inner", 1),
      namedCodec("outer", 1),
    ],
  });

  storage.values.set(
    "item",
    wrapEnvelope(
      "outer",
      1,
      wrapEnvelope("inner", 1, {
        kind: STORAGE_ENVELOPE_KIND,
        codec: BUILTIN_VALUE_CODEC,
        version: BUILTIN_VALUE_CODEC_VERSION,
        payload: JSON.stringify({ ok: true }),
      }),
    ),
  );

  assertEquals(await adapter.read("item"), { ok: true });
  assertEquals(await adapter.read("missing"), undefined);
});

Deno.test("delete delegates to backing storage", async () => {
  const storage = new MemoryStorage<StorageEnvelope>();
  const adapter = createExtendedStorage<number>({ storage });

  await adapter.write("key", 1);
  await adapter.delete("key");

  assertEquals(storage.values.has("key"), false);
});

Deno.test("has uses decoded semantics instead of forwarding backing has", async () => {
  const storage = new MemoryStorage<StorageEnvelope>();
  const adapter = createExtendedStorage<number>({
    storage,
    codecs: [{
      codec: "logical-absence",
      version: 1,
      encode(envelope) {
        return wrapEnvelope(this.codec, this.version, envelope);
      },
      decode() {
        return undefined;
      },
    }],
  });

  await adapter.write("key", 1);

  assertEquals(storage.has("key"), true);
  assertEquals(await adapter.has?.("key"), false);
});

Deno.test("bulk methods filter out logically absent values", async () => {
  const storage = new MemoryStorage<StorageEnvelope>();
  const adapter = createExtendedStorage<number>({
    storage,
    codecs: [{
      codec: "maybe",
      version: 1,
      encode(envelope) {
        return wrapEnvelope(this.codec, this.version, envelope);
      },
      decode(envelope) {
        const inner = unwrapEnvelope(this.codec, envelope);
        if (inner?.payload === "0") {
          return undefined;
        }
        return inner;
      },
    }],
  });

  await adapter.write("zero", 0);
  await adapter.write("one", 1);

  assertEquals(await collect(adapter.readAllKeys?.()), ["one"]);
  assertEquals(await collect(adapter.readAllValues?.()), [1]);
  assertEquals(await collect(adapter.readAllEntries?.()), [["one", 1]]);
});

Deno.test("constructor rejects duplicate and reserved codec identifiers", () => {
  const storage = new MemoryStorage<StorageEnvelope>();
  const duplicate = namedCodec("dup", 1);

  assertThrows(
    () =>
      createExtendedStorage({
        storage,
        codecs: [duplicate, namedCodec("dup", 2)],
      }),
    Error,
    "Duplicate storage envelope codec",
  );

  assertThrows(
    () =>
      createExtendedStorage({
        storage,
        codecs: [namedCodec(BUILTIN_VALUE_CODEC, 1)],
      }),
    Error,
    "reserved",
  );
});

Deno.test("read rejects invalid envelopes, unknown codecs, and bad builtin versions", async () => {
  const storage = new MemoryStorage<StorageEnvelope>();
  const adapter = createExtendedStorage<number>({ storage });

  storage.values.set("invalid", { codec: "x" } as StorageEnvelope);
  await assertRejects(
    () => Promise.resolve(adapter.read("invalid")),
    Error,
    "Invalid envelope",
  );

  storage.values.set("unknown", {
    kind: STORAGE_ENVELOPE_KIND,
    codec: "unknown",
    version: 1,
    payload: "",
  });
  await assertRejects(
    () => Promise.resolve(adapter.read("unknown")),
    Error,
    "Unknown storage envelope codec",
  );

  storage.values.set("bad-version", {
    kind: STORAGE_ENVELOPE_KIND,
    codec: BUILTIN_VALUE_CODEC,
    version: BUILTIN_VALUE_CODEC_VERSION + 1,
    payload: "1",
  });
  await assertRejects(
    () => Promise.resolve(adapter.read("bad-version")),
    Error,
    "Unsupported built-in value codec version",
  );
});

Deno.test("read rejects invalid codec output and caps decode depth", async () => {
  const storage = new MemoryStorage<StorageEnvelope>();
  const adapter = createExtendedStorage<number>({
    storage,
    codecs: [{
      codec: "loop",
      version: 1,
      encode(envelope) {
        return wrapEnvelope(this.codec, this.version, envelope);
      },
      decode() {
        return {
          kind: STORAGE_ENVELOPE_KIND,
          codec: "loop",
          version: 1,
          payload: "still-looping",
        };
      },
    }],
  });

  storage.values.set("loop", {
    kind: STORAGE_ENVELOPE_KIND,
    codec: "loop",
    version: 1,
    payload: "x",
  });

  await assertRejects(
    () => Promise.resolve(adapter.read("loop")),
    Error,
    `${MAX_DECODE_DEPTH}`,
  );

  const invalidAdapter = createExtendedStorage<number>({
    storage,
    codecs: [{
      codec: "invalid-next",
      version: 1,
      encode(envelope) {
        return wrapEnvelope(this.codec, this.version, envelope);
      },
      decode() {
        return { bad: true } as unknown as StorageEnvelope;
      },
    }],
  });

  storage.values.set("invalid-next", {
    kind: STORAGE_ENVELOPE_KIND,
    codec: "invalid-next",
    version: 1,
    payload: "x",
  });

  await assertRejects(
    () => Promise.resolve(invalidAdapter.read("invalid-next")),
    Error,
    "Invalid envelope",
  );
});

Deno.test("write rejects unsupported top-level undefined and invalid codec encode output", async () => {
  const storage = new MemoryStorage<StorageEnvelope>();
  const adapter = createExtendedStorage<undefined>({ storage });

  await assertRejects(
    () => Promise.resolve(adapter.write("undefined", undefined)),
    Error,
    "top-level undefined",
  );

  const invalidEncodeAdapter = createExtendedStorage<number>({
    storage,
    codecs: [{
      codec: "bad-encode",
      version: 1,
      encode() {
        return {
          kind: STORAGE_ENVELOPE_KIND,
          codec: "",
          version: 1,
          payload: "x",
        };
      },
      decode(envelope) {
        return unwrapEnvelope(this.codec, envelope);
      },
    }],
  });

  await assertRejects(
    () => Promise.resolve(invalidEncodeAdapter.write("bad", 1)),
    Error,
    "Invalid envelope codec",
  );
});

function namedCodec(codec: string, version: number): StorageEnvelopeCodec {
  return {
    codec,
    version,
    encode(envelope) {
      return wrapEnvelope(codec, version, envelope);
    },
    decode(envelope) {
      return unwrapEnvelope(codec, envelope);
    },
  };
}

function wrapEnvelope(
  codec: string,
  version: number,
  envelope: StorageEnvelope,
): StorageEnvelope {
  return {
    kind: STORAGE_ENVELOPE_KIND,
    codec,
    version,
    payload: JSON.stringify(envelope),
  };
}

function unwrapEnvelope(
  codec: string,
  envelope: StorageEnvelope,
): StorageEnvelope {
  if (envelope.codec !== codec) {
    throw new Error(`Unexpected envelope for codec ${codec}`);
  }

  return JSON.parse(envelope.payload) as StorageEnvelope;
}

async function collect<T>(
  values: Iterable<T> | AsyncIterable<T> | undefined,
): Promise<T[]> {
  if (values === undefined) {
    return [];
  }

  const collected: T[] = [];
  for await (const value of values) {
    collected.push(value);
  }
  return collected;
}
