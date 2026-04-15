import {
  assertEquals,
  assertRejects,
  assertThrows,
} from "@std/assert";
import type { StorageAdapter } from "grammy";
import {
  BUILTIN_VALUE_CODEC,
  BUILTIN_VALUE_CODEC_VERSION,
  createExtendedStorage,
  STORAGE_ENVELOPE_KIND,
} from "../src/mod.ts";
import type { StorageEnvelope, StorageEnvelopeCodec } from "../src/mod.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** In-memory backing store for StorageEnvelope. */
function createMemoryStorage(): StorageAdapter<StorageEnvelope> & {
  data: Map<string, StorageEnvelope>;
} {
  const data = new Map<string, StorageEnvelope>();
  return {
    data,
    read: (key) => data.get(key),
    write: (key, value) => {
      data.set(key, value);
    },
    delete: (key) => {
      data.delete(key);
    },
    has: (key) => data.has(key),
    readAllKeys: () => data.keys(),
    readAllValues: () => data.values(),
    readAllEntries: () => data.entries(),
  };
}

/** A trivial pass-through codec that wraps the inner envelope as JSON. */
function createJsonWrapCodec(
  id: string,
  ver = 1,
): StorageEnvelopeCodec {
  return {
    codec: id,
    version: ver,
    encode(envelope: StorageEnvelope): StorageEnvelope {
      return {
        kind: STORAGE_ENVELOPE_KIND,
        codec: id,
        version: ver,
        payload: JSON.stringify(envelope),
      };
    },
    decode(envelope: StorageEnvelope): StorageEnvelope {
      return JSON.parse(envelope.payload) as StorageEnvelope;
    },
  };
}

// ---------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------

Deno.test("createExtendedStorage returns adapter with core methods", () => {
  const adapter = createExtendedStorage<string>({
    storage: createMemoryStorage(),
  });
  assertEquals(typeof adapter.read, "function");
  assertEquals(typeof adapter.write, "function");
  assertEquals(typeof adapter.delete, "function");
});

Deno.test("construction throws on duplicate codec identifier", () => {
  const c1 = createJsonWrapCodec("dup");
  const c2 = createJsonWrapCodec("dup");
  assertThrows(
    () =>
      createExtendedStorage<string>({
        storage: createMemoryStorage(),
        codecs: [c1, c2],
      }),
    Error,
    'Duplicate codec identifier: "dup"',
  );
});

Deno.test("construction throws on reserved codec identifier", () => {
  const c: StorageEnvelopeCodec = {
    codec: BUILTIN_VALUE_CODEC,
    version: 1,
    encode: (e) => e,
    decode: (e) => e,
  };
  assertThrows(
    () =>
      createExtendedStorage<string>({
        storage: createMemoryStorage(),
        codecs: [c],
      }),
    Error,
    "reserved",
  );
});

// ---------------------------------------------------------------------------
// Write & Read — no codecs
// ---------------------------------------------------------------------------

Deno.test("round-trips a primitive value with no codecs", async () => {
  const backing = createMemoryStorage();
  const adapter = createExtendedStorage<number>({ storage: backing });

  await adapter.write("k1", 42);
  const result = await adapter.read("k1");
  assertEquals(result, 42);
});

Deno.test("round-trips an object value with no codecs", async () => {
  const backing = createMemoryStorage();
  const adapter = createExtendedStorage<{ a: number }>({ storage: backing });

  await adapter.write("k1", { a: 1 });
  assertEquals(await adapter.read("k1"), { a: 1 });
});

Deno.test("read returns undefined for missing key", async () => {
  const adapter = createExtendedStorage<string>({
    storage: createMemoryStorage(),
  });
  assertEquals(await adapter.read("nope"), undefined);
});

// ---------------------------------------------------------------------------
// Write & Read — with codecs
// ---------------------------------------------------------------------------

Deno.test("round-trips through a single codec", async () => {
  const backing = createMemoryStorage();
  const adapter = createExtendedStorage<string>({
    storage: backing,
    codecs: [createJsonWrapCodec("wrap-a")],
  });

  await adapter.write("k", "hello");
  assertEquals(await adapter.read("k"), "hello");

  // Verify the stored envelope is wrapped by "wrap-a"
  const stored = backing.data.get("k")!;
  assertEquals(stored.codec, "wrap-a");
});

Deno.test("round-trips through multiple codecs", async () => {
  const backing = createMemoryStorage();
  const adapter = createExtendedStorage<string>({
    storage: backing,
    codecs: [createJsonWrapCodec("inner"), createJsonWrapCodec("outer")],
  });

  await adapter.write("k", "world");
  assertEquals(await adapter.read("k"), "world");

  // Outermost codec is the last in the array
  const stored = backing.data.get("k")!;
  assertEquals(stored.codec, "outer");
});

// ---------------------------------------------------------------------------
// Delete
// ---------------------------------------------------------------------------

Deno.test("delete removes a key", async () => {
  const backing = createMemoryStorage();
  const adapter = createExtendedStorage<number>({ storage: backing });

  await adapter.write("k", 1);
  await adapter.delete("k");
  assertEquals(await adapter.read("k"), undefined);
});

// ---------------------------------------------------------------------------
// Codec returning undefined on decode
// ---------------------------------------------------------------------------

Deno.test("codec returning undefined terminates read with undefined", async () => {
  const codec: StorageEnvelopeCodec = {
    codec: "maybe",
    version: 1,
    encode(envelope) {
      return {
        kind: STORAGE_ENVELOPE_KIND,
        codec: "maybe",
        version: 1,
        payload: JSON.stringify(envelope),
      };
    },
    decode(_envelope) {
      return undefined;
    },
  };

  const adapter = createExtendedStorage<string>({
    storage: createMemoryStorage(),
    codecs: [codec],
  });

  await adapter.write("k", "data");
  assertEquals(await adapter.read("k"), undefined);
});

// ---------------------------------------------------------------------------
// Error conditions
// ---------------------------------------------------------------------------

Deno.test("read throws on unknown codec in stored envelope", async () => {
  const backing = createMemoryStorage();
  backing.data.set("k", {
    kind: STORAGE_ENVELOPE_KIND,
    codec: "unknown-codec",
    version: 1,
    payload: "{}",
  });

  const adapter = createExtendedStorage<string>({ storage: backing });
  await assertRejects(
    async () => await adapter.read("k"),
    Error,
    "Unknown storage envelope codec",
  );
});

Deno.test("read throws on invalid envelope in backing storage", async () => {
  const backing = createMemoryStorage();
  // Force a bad value in
  (backing.data as Map<string, unknown>).set("k", { kind: "bad" });

  const adapter = createExtendedStorage<string>({ storage: backing });
  await assertRejects(async () => await adapter.read("k"), Error, "Invalid envelope");
});

Deno.test("read throws on unsupported built-in value codec version", async () => {
  const backing = createMemoryStorage();
  backing.data.set("k", {
    kind: STORAGE_ENVELOPE_KIND,
    codec: BUILTIN_VALUE_CODEC,
    version: 999,
    payload: '"hi"',
  });

  const adapter = createExtendedStorage<string>({ storage: backing });
  await assertRejects(
    async () => await adapter.read("k"),
    Error,
    "Unsupported built-in value codec version",
  );
});

Deno.test("write throws when codec emits wrong codec id", async () => {
  const badCodec: StorageEnvelopeCodec = {
    codec: "honest",
    version: 1,
    encode(_envelope) {
      return {
        kind: STORAGE_ENVELOPE_KIND,
        codec: "liar",
        version: 1,
        payload: "{}",
      };
    },
    decode: (e) => e,
  };

  const adapter = createExtendedStorage<string>({
    storage: createMemoryStorage(),
    codecs: [badCodec],
  });
  await assertRejects(
    async () => await adapter.write("k", "v"),
    Error,
    "unexpected codec id",
  );
});

Deno.test("write throws when codec emits wrong version", async () => {
  const badCodec: StorageEnvelopeCodec = {
    codec: "mismatch",
    version: 1,
    encode(_envelope) {
      return {
        kind: STORAGE_ENVELOPE_KIND,
        codec: "mismatch",
        version: 99,
        payload: "{}",
      };
    },
    decode: (e) => e,
  };

  const adapter = createExtendedStorage<string>({
    storage: createMemoryStorage(),
    codecs: [badCodec],
  });
  await assertRejects(
    async () => await adapter.write("k", "v"),
    Error,
    "unexpected version",
  );
});

// ---------------------------------------------------------------------------
// Max decode depth
// ---------------------------------------------------------------------------

Deno.test("read throws when max decode depth exceeded", async () => {
  // A codec that always returns an envelope pointing back to itself
  const loopCodec: StorageEnvelopeCodec = {
    codec: "loop",
    version: 1,
    encode(envelope) {
      return {
        kind: STORAGE_ENVELOPE_KIND,
        codec: "loop",
        version: 1,
        payload: JSON.stringify(envelope),
      };
    },
    decode(_envelope) {
      return {
        kind: STORAGE_ENVELOPE_KIND,
        codec: "loop",
        version: 1,
        payload: "{}",
      };
    },
  };

  const backing = createMemoryStorage();
  const adapter = createExtendedStorage<string>({
    storage: backing,
    codecs: [loopCodec],
  });

  await adapter.write("k", "val");
  await assertRejects(
    async () => await adapter.read("k"),
    Error,
    "Maximum decode depth exceeded",
  );
});

// ---------------------------------------------------------------------------
// Optional methods — has
// ---------------------------------------------------------------------------

Deno.test("has returns false for missing key", async () => {
  const adapter = createExtendedStorage<string>({
    storage: createMemoryStorage(),
  });
  assertEquals(await adapter.has!("x"), false);
});

Deno.test("has returns true for existing key", async () => {
  const adapter = createExtendedStorage<string>({
    storage: createMemoryStorage(),
  });
  await adapter.write("x", "val");
  assertEquals(await adapter.has!("x"), true);
});

Deno.test("has returns false when codec decode returns undefined", async () => {
  const codec: StorageEnvelopeCodec = {
    codec: "absent",
    version: 1,
    encode(envelope) {
      return {
        kind: STORAGE_ENVELOPE_KIND,
        codec: "absent",
        version: 1,
        payload: JSON.stringify(envelope),
      };
    },
    decode() {
      return undefined;
    },
  };

  const adapter = createExtendedStorage<string>({
    storage: createMemoryStorage(),
    codecs: [codec],
  });
  await adapter.write("x", "val");
  assertEquals(await adapter.has!("x"), false);
});

// ---------------------------------------------------------------------------
// Optional methods — readAllKeys
// ---------------------------------------------------------------------------

Deno.test("readAllKeys yields only keys with decodable values", async () => {
  const backing = createMemoryStorage();
  const adapter = createExtendedStorage<number>({ storage: backing });

  await adapter.write("a", 1);
  await adapter.write("b", 2);

  const keys: string[] = [];
  for await (const key of adapter.readAllKeys!()) {
    keys.push(key);
  }
  keys.sort();
  assertEquals(keys, ["a", "b"]);
});

// ---------------------------------------------------------------------------
// Optional methods — readAllValues / readAllEntries
// ---------------------------------------------------------------------------

Deno.test("readAllValues yields decoded values", async () => {
  const backing = createMemoryStorage();
  const adapter = createExtendedStorage<number>({ storage: backing });

  await adapter.write("a", 10);
  await adapter.write("b", 20);

  const values: number[] = [];
  for await (const v of adapter.readAllValues!()) {
    values.push(v);
  }
  values.sort();
  assertEquals(values, [10, 20]);
});

Deno.test("readAllEntries yields decoded entries", async () => {
  const backing = createMemoryStorage();
  const adapter = createExtendedStorage<number>({ storage: backing });

  await adapter.write("a", 10);
  await adapter.write("b", 20);

  const entries: [string, number][] = [];
  for await (const e of adapter.readAllEntries!()) {
    entries.push(e);
  }
  entries.sort((a, b) => a[0].localeCompare(b[0]));
  assertEquals(entries, [["a", 10], ["b", 20]]);
});

// ---------------------------------------------------------------------------
// Envelope shape written to backing storage
// ---------------------------------------------------------------------------

Deno.test("stored envelope has correct shape with no codecs", async () => {
  const backing = createMemoryStorage();
  const adapter = createExtendedStorage<string>({ storage: backing });

  await adapter.write("k", "test");
  const stored = backing.data.get("k")!;

  assertEquals(stored.kind, STORAGE_ENVELOPE_KIND);
  assertEquals(stored.codec, BUILTIN_VALUE_CODEC);
  assertEquals(stored.version, BUILTIN_VALUE_CODEC_VERSION);
  assertEquals(stored.payload, '"test"');
});

// ---------------------------------------------------------------------------
// Bulk methods absent when backing doesn't support them
// ---------------------------------------------------------------------------

Deno.test("readAllKeys is absent when backing lacks it", () => {
  const backing: StorageAdapter<StorageEnvelope> = {
    read: () => undefined,
    write: () => {},
    delete: () => {},
  };
  const adapter = createExtendedStorage<string>({ storage: backing });
  assertEquals(adapter.readAllKeys, undefined);
});

Deno.test("readAllValues/readAllEntries absent when backing lacks readAllEntries", () => {
  const backing: StorageAdapter<StorageEnvelope> = {
    read: () => undefined,
    write: () => {},
    delete: () => {},
  };
  const adapter = createExtendedStorage<string>({ storage: backing });
  assertEquals(adapter.readAllValues, undefined);
  assertEquals(adapter.readAllEntries, undefined);
});

// ---------------------------------------------------------------------------
// Async codec support
// ---------------------------------------------------------------------------

Deno.test("supports async encode and decode in codecs", async () => {
  const asyncCodec: StorageEnvelopeCodec = {
    codec: "async-wrap",
    version: 1,
    async encode(envelope: StorageEnvelope): Promise<StorageEnvelope> {
      await new Promise((r) => setTimeout(r, 1));
      return {
        kind: STORAGE_ENVELOPE_KIND,
        codec: "async-wrap",
        version: 1,
        payload: JSON.stringify(envelope),
      };
    },
    async decode(
      envelope: StorageEnvelope,
    ): Promise<StorageEnvelope> {
      await new Promise((r) => setTimeout(r, 1));
      return JSON.parse(envelope.payload) as StorageEnvelope;
    },
  };

  const adapter = createExtendedStorage<number>({
    storage: createMemoryStorage(),
    codecs: [asyncCodec],
  });

  await adapter.write("k", 7);
  assertEquals(await adapter.read("k"), 7);
});
