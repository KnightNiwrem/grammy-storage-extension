import {
  assert,
  assertEquals,
  assertRejects,
  assertStrictEquals,
  assertThrows,
} from "@std/assert";
import { MemorySessionStorage, type StorageAdapter } from "grammy";

import denoConfig from "../deno.json" with { type: "json" };
import * as publicApi from "../src/mod.ts";
import {
  assertValidSerializedEnvelope,
  type BodyCodec,
  type CodecRecord,
  createExtendedStorage,
  type CreateExtendedStorageOptions,
  ENVELOPE_DISCRIMINATOR,
  EXTENDED_STORAGE_ERROR_CODES,
  ExtendedStorageError,
  PACKAGE_VERSION,
  type SerializedEnvelope,
} from "../src/mod.ts";
import {
  gzipCodec,
  readOnlySpy,
  record,
  spyCodec,
  ttlCodec,
  validSerializedEnvelope,
} from "./helpers.ts";

type SpyableStorage = StorageAdapter<SerializedEnvelope> & {
  read(
    key: string,
  ): SerializedEnvelope | undefined | Promise<SerializedEnvelope | undefined>;
  write(key: string, value: SerializedEnvelope): void | Promise<void>;
  delete(key: string): void | Promise<void>;
};

type SpyCalls = {
  writes: Array<{ key: string; value: SerializedEnvelope }>;
  deletes: string[];
};

function backing(): SpyableStorage {
  return new MemorySessionStorage<SerializedEnvelope>() as SpyableStorage;
}

function spyStorage(
  storage: SpyableStorage,
): SpyableStorage & { calls: SpyCalls } {
  const originalWrite = storage.write.bind(storage);
  const originalDelete = storage.delete.bind(storage);
  const calls: SpyCalls = { writes: [], deletes: [] };

  storage.write = async (key: string, value: SerializedEnvelope) => {
    calls.writes.push({ key, value });
    await originalWrite(key, value);
  };
  storage.delete = async (key: string) => {
    calls.deletes.push(key);
    await originalDelete(key);
  };

  return Object.assign(storage, { calls });
}

async function rawWrite(
  storage: SpyableStorage,
  key: string,
  value: unknown,
): Promise<void> {
  await (storage as unknown as StorageAdapter<unknown>).write(key, value);
}

async function rawRead(
  storage: SpyableStorage,
  key: string,
): Promise<SerializedEnvelope> {
  const envelope = await storage.read(key);
  if (envelope === undefined) {
    throw new Error(`Fixture key "${key}" missing from storage`);
  }
  return envelope;
}

const utf8 = new TextEncoder();
const base64 = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes));
const reversed = (text: string): Uint8Array => utf8.encode(text).reverse();

// ---------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------

Deno.test("VAL-CONSTR-001 returns a usable StorageAdapter<T> with no codecs", async () => {
  const storage = backing();
  const adapter = createExtendedStorage<{ count: number }>({ storage });

  await adapter.write("key", { count: 1 });

  assertEquals(await adapter.read("key"), { count: 1 });
  assertEquals(await rawRead(storage, "key"), {
    discriminator: ENVELOPE_DISCRIMINATOR,
    version: PACKAGE_VERSION,
    codecs: [],
    encoding: "utf8",
    body: '{"count":1}',
  });
});

Deno.test("VAL-CONSTR-002 accepts an empty codecs array", async () => {
  const adapter = createExtendedStorage<number>({
    storage: backing(),
    codecs: [],
  });
  await adapter.write("key", 1);
  assertEquals(await adapter.read("key"), 1);
});

Deno.test("VAL-CONSTR-003 rejects an empty codec id", () => {
  const error = assertThrows(
    () =>
      createExtendedStorage({
        storage: backing(),
        codecs: [spyCodec("")],
      }),
    ExtendedStorageError,
  );
  assertEquals(error.code, EXTENDED_STORAGE_ERROR_CODES.INVALID_CODEC_ID);
});

Deno.test("VAL-CONSTR-004 rejects a non-string codec id", () => {
  // A length-only guard would crash on null/undefined and let a non-string id
  // into the registry; the guard must reject any non-primitive-string value.
  for (const badId of [undefined, null, 1, true, {}, [], Symbol("s")]) {
    const error = assertThrows(
      () =>
        createExtendedStorage({
          storage: backing(),
          codecs: [{
            id: badId as never,
            version: "1.0.0",
            encode: (b) => ({ body: b }),
            decode: (b) => b,
          }],
        }),
      ExtendedStorageError,
    );
    assertEquals(error.code, EXTENDED_STORAGE_ERROR_CODES.INVALID_CODEC_ID);
  }
});

Deno.test("VAL-CONSTR-005 rejects duplicate codec ids", () => {
  const error = assertThrows(
    () =>
      createExtendedStorage({
        storage: backing(),
        codecs: [spyCodec("dup"), spyCodec("dup")],
      }),
    ExtendedStorageError,
    "dup",
  );
  assertEquals(
    error.code,
    EXTENDED_STORAGE_ERROR_CODES.DUPLICATE_CODEC_ID,
  );
});

Deno.test("VAL-CONSTR-006 codecs are applied to writes in declaration order", async () => {
  const storage = backing();
  const order: string[] = [];
  const adapter = createExtendedStorage<number>({
    storage,
    codecs: [
      spyCodec("first", { onEncode: () => order.push("first") }),
      spyCodec("second", { onEncode: () => order.push("second") }),
    ],
  });

  await adapter.write("key", 1);

  assertEquals(order, ["first", "second"]);
  assertEquals(
    (await rawRead(storage, "key")).codecs.map((r) => r.id),
    ["first", "second"],
  );
});

Deno.test("VAL-CONSTR-007 mutating the codecs array after construction does not affect writes", async () => {
  const storage = backing();
  const codecs: BodyCodec[] = [spyCodec("first")];
  const adapter = createExtendedStorage<number>({ storage, codecs });

  codecs.push(spyCodec("second"));
  await adapter.write("key", 1);

  assertEquals(
    (await rawRead(storage, "key")).codecs.map((r) => r.id),
    ["first"],
  );
});

Deno.test("VAL-CONSTR-008 PACKAGE_VERSION matches the version in deno.json", () => {
  assertStrictEquals(PACKAGE_VERSION, denoConfig.version);
});

// ---------------------------------------------------------------------------
// Body serialization
// ---------------------------------------------------------------------------

Deno.test("VAL-BODY-001 zero-codec write produces a readable utf8 envelope", async () => {
  const storage = spyStorage(backing());
  const adapter = createExtendedStorage<{ a: number }>({ storage });

  await adapter.write("key", { a: 1 });

  assertEquals(storage.calls.writes, [{
    key: "key",
    value: validSerializedEnvelope({ body: '{"a":1}' }),
  }]);
});

Deno.test("VAL-BODY-002 read decodes a utf8 body with JSON.parse", async () => {
  const storage = backing();
  const adapter = createExtendedStorage<{ parsed: boolean }>({ storage });
  await storage.write(
    "key",
    validSerializedEnvelope({ body: '{"parsed":true}' }),
  );

  assertEquals(await adapter.read("key"), { parsed: true });
});

Deno.test("VAL-BODY-003 roundtrips JSON-compatible primitives, arrays, and objects", async () => {
  // The domain under test is any JSON-serializable value, so the adapter's
  // application type is exactly that union rather than an opaque `unknown`.
  type JsonValue =
    | null
    | boolean
    | number
    | string
    | JsonValue[]
    | { [key: string]: JsonValue };

  const cases: ReadonlyArray<{ key: string; value: JsonValue }> = [
    { key: "null", value: null },
    { key: "boolean", value: true },
    { key: "integer", value: 0 },
    { key: "negative-float", value: -1.5 },
    { key: "empty-string", value: "" },
    { key: "unicode-string", value: "héllo ✓" },
    { key: "empty-array", value: [] },
    { key: "heterogeneous-array", value: [1, "two", null, { three: 3 }] },
    { key: "empty-object", value: {} },
    { key: "nested-object", value: { nested: { deep: [{ x: 1 }] } } },
  ];

  const adapter = createExtendedStorage<JsonValue>({ storage: backing() });
  for (const { key, value } of cases) {
    await adapter.write(key, value);
    assertEquals(await adapter.read(key), value, `roundtrip for ${key}`);
  }
});

Deno.test("VAL-BODY-004 top-level undefined write deletes via storage.delete and never writes", async () => {
  const storage = spyStorage(backing());
  // The domain includes `undefined`, whose write is the delete path under test.
  const adapter = createExtendedStorage<number | undefined>({ storage });
  await adapter.write("key", 1);
  storage.calls.writes.length = 0;

  await adapter.write("key", undefined);

  assertEquals(storage.calls.deletes, ["key"]);
  assertEquals(storage.calls.writes, []);
  assertEquals(await adapter.read("key"), undefined);
});

Deno.test("VAL-BODY-005 unparseable JSON body throws the native parse error", async () => {
  const storage = backing();
  const adapter = createExtendedStorage({ storage });
  await storage.write("key", validSerializedEnvelope({ body: "{not json" }));

  await assertRejects(async () => {
    await adapter.read("key");
  }, SyntaxError);
});

Deno.test("VAL-BODY-006 invalid UTF-8 body throws the native decoding error", async () => {
  const storage = backing();
  const adapter = createExtendedStorage({ storage });
  await storage.write(
    "key",
    validSerializedEnvelope({
      encoding: "base64",
      body: base64(new Uint8Array([0xff, 0xfe])),
    }),
  );

  await assertRejects(async () => {
    await adapter.read("key");
  }, TypeError);
});

Deno.test("VAL-BODY-007 unserializable value throws and does not write", async () => {
  const storage = spyStorage(backing());
  // A bigint has no JSON representation: JSON.stringify throws on it, so the
  // write must surface VALUE_SERIALIZATION and store nothing.
  const adapter = createExtendedStorage<{ big: bigint }>({ storage });

  const error = await assertRejects(
    async () => {
      await adapter.write("key", { big: 1n });
    },
    ExtendedStorageError,
  );
  assertEquals(error.code, EXTENDED_STORAGE_ERROR_CODES.VALUE_SERIALIZATION);
  assert(error.cause instanceof TypeError);
  assertEquals(storage.calls.writes, []);
});

Deno.test("VAL-BODY-008 value that stringifies to undefined throws a typed error", async () => {
  const storage = spyStorage(backing());
  // A function stringifies to `undefined` rather than JSON, which the write
  // path must reject as VALUE_SERIALIZATION instead of storing a row.
  const adapter = createExtendedStorage<() => number>({ storage });

  const error = await assertRejects(
    async () => {
      await adapter.write("key", () => 1);
    },
    ExtendedStorageError,
  );
  assertEquals(error.code, EXTENDED_STORAGE_ERROR_CODES.VALUE_SERIALIZATION);
  assertEquals(storage.calls.writes, []);
});

Deno.test("VAL-BODY-009 base64 body with zero codecs is decoded by its encoding field", async () => {
  const storage = backing();
  const adapter = createExtendedStorage<number[]>({ storage });
  await storage.write(
    "key",
    validSerializedEnvelope({
      encoding: "base64",
      body: base64(utf8.encode("[1,2]")),
    }),
  );

  assertEquals(await adapter.read("key"), [1, 2]);
});

Deno.test("VAL-BODY-010 invalid base64 body throws the native decoding error", async () => {
  for (
    const [body, ErrorClass] of [["!!!", TypeError], ["0", RangeError]] as const
  ) {
    const storage = backing();
    const adapter = createExtendedStorage({ storage });
    await storage.write(
      "key",
      validSerializedEnvelope({ encoding: "base64", body }),
    );

    await assertRejects(async () => {
      await adapter.read("key");
    }, ErrorClass);
  }
});

// ---------------------------------------------------------------------------
// Write pipeline
// ---------------------------------------------------------------------------

Deno.test("VAL-WRITE-001 single codec records its identity, normalises meta, and base64-encodes the body", async () => {
  const storage = backing();
  const adapter = createExtendedStorage<{ a: number }>({
    storage,
    codecs: [spyCodec("rev", { version: "2.1.0", reverse: true })],
  });

  await adapter.write("key", { a: 1 });

  assertEquals(await rawRead(storage, "key"), {
    discriminator: ENVELOPE_DISCRIMINATOR,
    version: PACKAGE_VERSION,
    codecs: [{ id: "rev", version: "2.1.0", meta: {} }],
    encoding: "base64",
    body: base64(reversed('{"a":1}')),
  });
});

Deno.test("VAL-WRITE-002 multiple codecs compose in declaration order", async () => {
  const storage = backing();
  const seen: Record<string, Uint8Array> = {};
  const adapter = createExtendedStorage<string>({
    storage,
    codecs: [
      spyCodec("rev", { reverse: true, onEncode: (b) => seen.rev = b }),
      spyCodec("id", { onEncode: (b) => seen.id = b }),
    ],
  });

  await adapter.write("key", "ab");

  assertEquals(seen.rev, utf8.encode('"ab"'));
  assertEquals(seen.id, reversed('"ab"'));
  assertEquals(
    (await rawRead(storage, "key")).codecs.map((r) => r.id),
    ["rev", "id"],
  );
  assertEquals(await adapter.read("key"), "ab");
});

Deno.test("VAL-WRITE-003 meta returned by encode is recorded on the codec entry", async () => {
  const storage = backing();
  const adapter = createExtendedStorage<number>({
    storage,
    codecs: [spyCodec("tagged", { meta: { tag: "x", n: 2 } })],
  });

  await adapter.write("key", 1);

  assertEquals((await rawRead(storage, "key")).codecs, [
    { id: "tagged", version: "1.0.0", meta: { tag: "x", n: 2 } },
  ]);
});

Deno.test("VAL-WRITE-004 invalid encode output throws before any storage mutation", async () => {
  const outputs: unknown[] = [
    undefined,
    null,
    "text",
    { body: "not bytes" },
    { body: [1, 2] },
    { body: new Uint8Array(), meta: [] },
    { body: new Uint8Array(), meta: null },
    { body: new Uint8Array(), meta: "x" },
  ];

  for (const output of outputs) {
    const storage = spyStorage(backing());
    const adapter = createExtendedStorage<number>({
      storage,
      codecs: [{
        id: "bad",
        version: "1.0.0",
        encode: () => output as never,
        decode: (b) => b,
      }],
    });

    const error = await assertRejects(
      async () => {
        await adapter.write("key", 1);
      },
      ExtendedStorageError,
      '"bad"',
    );
    assertEquals(
      error.code,
      EXTENDED_STORAGE_ERROR_CODES.INVALID_CODEC_OUTPUT,
    );
    assertEquals(storage.calls.writes, []);
  }
});

Deno.test("VAL-WRITE-005 async encode is supported and applied sequentially", async () => {
  const storage = backing();
  const order: string[] = [];
  const adapter = createExtendedStorage<string>({
    storage,
    codecs: [
      spyCodec("a", {
        encodeAsync: true,
        reverse: true,
        onEncode: () => order.push("a"),
      }),
      spyCodec("b", { encodeAsync: true, onEncode: () => order.push("b") }),
    ],
  });

  await adapter.write("key", "v");

  assertEquals(order, ["a", "b"]);
  assertEquals(await adapter.read("key"), "v");
});

Deno.test("VAL-WRITE-006 write delegates exactly once to backing storage", async () => {
  const storage = spyStorage(backing());
  const adapter = createExtendedStorage<number>({
    storage,
    codecs: [spyCodec("a"), spyCodec("b")],
  });

  await adapter.write("key", 1);

  assertEquals(storage.calls.writes.length, 1);
  assertEquals(storage.calls.writes[0].key, "key");
});

Deno.test("VAL-WRITE-007 a codec failing mid-chain prevents any write", async () => {
  const storage = spyStorage(backing());
  const adapter = createExtendedStorage<number>({
    storage,
    codecs: [
      spyCodec("ok"),
      {
        id: "boom",
        version: "1.0.0",
        encode: () => {
          throw new Error("encode failed");
        },
        decode: (b) => b,
      },
    ],
  });

  await assertRejects(
    async () => {
      await adapter.write("key", 1);
    },
    Error,
    "encode failed",
  );
  assertEquals(storage.calls.writes, []);
});

// ---------------------------------------------------------------------------
// Read pipeline
// ---------------------------------------------------------------------------

Deno.test("VAL-READ-001 returns undefined for a missing backing entry without decoding", async () => {
  const codec = spyCodec("a", { expired: false });
  const adapter = createExtendedStorage({
    storage: backing(),
    codecs: [codec],
  });

  assertEquals(await adapter.read("missing"), undefined);
  assertEquals(codec.calls, { encode: 0, decode: 0, isExpired: 0 });
});

Deno.test("VAL-READ-002 decode walks the recorded codecs in reverse order", async () => {
  const storage = backing();
  const order: string[] = [];
  const adapter = createExtendedStorage<number>({
    storage,
    codecs: [
      spyCodec("a", { onDecode: () => order.push("a") }),
      spyCodec("b", { onDecode: () => order.push("b") }),
      spyCodec("c", { onDecode: () => order.push("c") }),
    ],
  });
  await adapter.write("key", 1);

  assertEquals(await adapter.read("key"), 1);
  assertEquals(order, ["c", "b", "a"]);
});

Deno.test("VAL-READ-003 read order follows the record, not declaration order", async () => {
  const storage = backing();
  const a = spyCodec("a", { reverse: true });
  const b = spyCodec("b");
  const writer = createExtendedStorage<{ swapped: boolean }>({
    storage,
    codecs: [a, b],
  });
  const reader = createExtendedStorage<{ swapped: boolean }>({
    storage,
    codecs: [b, a],
  });

  await writer.write("key", { swapped: true });

  assertEquals(await reader.read("key"), { swapped: true });
});

Deno.test("VAL-READ-004 unknown codec id throws with the id in the message", async () => {
  const storage = backing();
  const adapter = createExtendedStorage({ storage });
  await storage.write(
    "key",
    validSerializedEnvelope({ codecs: [record("ghost")] }),
  );

  const error = await assertRejects(
    async () => {
      await adapter.read("key");
    },
    ExtendedStorageError,
    "ghost",
  );
  assertEquals(error.code, EXTENDED_STORAGE_ERROR_CODES.UNKNOWN_CODEC);
});

Deno.test("VAL-READ-005 malformed backing envelope throws", async () => {
  const storage = backing();
  const adapter = createExtendedStorage({ storage });
  await rawWrite(storage, "key", { codecs: 42 });

  const error = await assertRejects(
    async () => {
      await adapter.read("key");
    },
    ExtendedStorageError,
    "envelope",
  );
  assertEquals(error.code, EXTENDED_STORAGE_ERROR_CODES.INVALID_ENVELOPE);
});

Deno.test("VAL-READ-006 decode returning a non-Uint8Array throws", async () => {
  for (const output of [undefined, null, "text", [1], new ArrayBuffer(2)]) {
    const storage = spyStorage(backing());
    const adapter = createExtendedStorage<number>({
      storage,
      codecs: [{
        id: "bad",
        version: "1.0.0",
        encode: (b) => ({ body: b }),
        decode: () => output as never,
      }],
    });
    await adapter.write("key", 1);
    storage.calls.deletes.length = 0;

    const error = await assertRejects(
      async () => {
        await adapter.read("key");
      },
      ExtendedStorageError,
      '"bad"',
    );
    assertEquals(
      error.code,
      EXTENDED_STORAGE_ERROR_CODES.INVALID_CODEC_OUTPUT,
    );
    assertEquals(storage.calls.deletes, []);
  }
});

Deno.test("VAL-READ-007 async decode is supported", async () => {
  const adapter = createExtendedStorage<number[]>({
    storage: backing(),
    codecs: [spyCodec("a", { decodeAsync: true, reverse: true })],
  });
  await adapter.write("key", [1, 2, 3]);

  assertEquals(await adapter.read("key"), [1, 2, 3]);
});

Deno.test("VAL-READ-008 errors thrown by decode propagate without deleting", async () => {
  const storage = spyStorage(backing());
  const adapter = createExtendedStorage<number>({
    storage,
    codecs: [{
      id: "boom",
      version: "1.0.0",
      encode: (b) => ({ body: b }),
      decode: () => {
        throw new Error("decode failed");
      },
    }],
  });
  await adapter.write("key", 1);
  storage.calls.deletes.length = 0;

  await assertRejects(
    async () => {
      await adapter.read("key");
    },
    Error,
    "decode failed",
  );
  assertEquals(storage.calls.deletes, []);
  assert((await storage.read("key")) !== undefined);
});

Deno.test("VAL-READ-009 decode receives the stored record, including historical version and meta", async () => {
  const storage = backing();
  let received: CodecRecord | undefined;
  const adapter = createExtendedStorage<number>({
    storage,
    codecs: [
      spyCodec("a", { version: "2.0.0", onDecode: (_, r) => received = r }),
    ],
  });
  await storage.write(
    "key",
    validSerializedEnvelope({
      codecs: [record("a", { version: "1.0.0", meta: { legacy: true } })],
      body: "7",
    }),
  );

  assertEquals(await adapter.read("key"), 7);
  assertEquals(received, {
    id: "a",
    version: "1.0.0",
    meta: { legacy: true },
  });
});

// ---------------------------------------------------------------------------
// Expiry
// ---------------------------------------------------------------------------

Deno.test("VAL-EXPIRE-001 expired entry reads as undefined, is deleted once, and is never decoded", async () => {
  const storage = spyStorage(backing());
  const codec = spyCodec("ttl", { expired: true });
  const adapter = createExtendedStorage<number>({
    storage,
    codecs: [codec],
  });
  await adapter.write("key", 1);
  storage.calls.deletes.length = 0;

  assertEquals(await adapter.read("key"), undefined);

  assertEquals(storage.calls.deletes, ["key"]);
  assertEquals(codec.calls.decode, 0);
  assertEquals(codec.calls.isExpired, 1);
  assertEquals(await storage.read("key"), undefined);
});

Deno.test("VAL-EXPIRE-002 isExpired receives its own record with meta", async () => {
  const storage = backing();
  let received: CodecRecord | undefined;
  const adapter = createExtendedStorage<number>({
    storage,
    codecs: [
      spyCodec("other", { meta: { other: true } }),
      spyCodec("ttl", {
        meta: { expiresAt: 5 },
        expired: (r) => {
          received = r;
          return false;
        },
      }),
    ],
  });
  await adapter.write("key", 1);

  assertEquals(await adapter.read("key"), 1);
  assertEquals(received, {
    id: "ttl",
    version: "1.0.0",
    meta: { expiresAt: 5 },
  });
});

Deno.test("VAL-EXPIRE-003 checks run in recorded order and short-circuit on the first true", async () => {
  const storage = backing();
  const order: string[] = [];
  const first = spyCodec("first", {
    expired: () => {
      order.push("first");
      return true;
    },
  });
  const second = spyCodec("second", {
    expired: () => {
      order.push("second");
      return false;
    },
  });
  const adapter = createExtendedStorage<number>({
    storage,
    codecs: [first, second],
  });
  await adapter.write("key", 1);

  assertEquals(await adapter.read("key"), undefined);
  assertEquals(order, ["first"]);
  assertEquals(second.calls.isExpired, 0);
});

Deno.test("VAL-EXPIRE-004 any codec reporting expiry wins", async () => {
  const storage = backing();
  const adapter = createExtendedStorage<number>({
    storage,
    codecs: [
      spyCodec("alive", { expired: false }),
      spyCodec("plain"),
      spyCodec("dead", { expired: true }),
    ],
  });
  await adapter.write("key", 1);

  assertEquals(await adapter.read("key"), undefined);
  assertEquals(await storage.read("key"), undefined);
});

Deno.test("VAL-EXPIRE-005 a throwing isExpired propagates and does not delete", async () => {
  const storage = spyStorage(backing());
  const adapter = createExtendedStorage<number>({
    storage,
    codecs: [
      spyCodec("boom", {
        expired: () => {
          throw new Error("check failed");
        },
      }),
    ],
  });
  await adapter.write("key", 1);
  storage.calls.deletes.length = 0;

  await assertRejects(
    async () => {
      await adapter.read("key");
    },
    Error,
    "check failed",
  );
  assertEquals(storage.calls.deletes, []);
});

Deno.test("VAL-EXPIRE-006 codecs without isExpired are skipped and live entries decode normally", async () => {
  const storage = spyStorage(backing());
  const plain = spyCodec("plain", { reverse: true });
  const alive = spyCodec("alive", { expired: false });
  const adapter = createExtendedStorage<{ live: boolean }>({
    storage,
    codecs: [plain, alive],
  });
  await adapter.write("key", { live: true });
  storage.calls.deletes.length = 0;

  assertEquals(await adapter.read("key"), { live: true });
  assertEquals(alive.calls.isExpired, 1);
  assertEquals(plain.calls.decode, 1);
  assertEquals(storage.calls.deletes, []);
});

Deno.test("VAL-EXPIRE-007 cleanup delete failure does not propagate", async () => {
  const storage = backing();
  const adapter = createExtendedStorage<number>({
    storage,
    codecs: [spyCodec("ttl", { expired: true })],
  });
  await adapter.write("key", 1);
  storage.delete = () => {
    throw new Error("delete failed");
  };

  assertEquals(await adapter.read("key"), undefined);
});

Deno.test("VAL-EXPIRE-008 async isExpired is supported", async () => {
  const storage = backing();
  const adapter = createExtendedStorage<number>({
    storage,
    codecs: [{
      id: "ttl",
      version: "1.0.0",
      encode: (b) => ({ body: b }),
      decode: (b) => b,
      isExpired: () => Promise.resolve(true),
    }],
  });
  await adapter.write("key", 1);

  assertEquals(await adapter.read("key"), undefined);
  assertEquals(await storage.read("key"), undefined);
});

Deno.test("VAL-EXPIRE-009 unknown codec ids are rejected before any expiry check runs", async () => {
  const storage = spyStorage(backing());
  const ttl = spyCodec("ttl", { expired: true });
  const adapter = createExtendedStorage({ storage, codecs: [ttl] });
  await storage.write(
    "key",
    validSerializedEnvelope({ codecs: [record("ttl"), record("ghost")] }),
  );

  const error = await assertRejects(
    async () => {
      await adapter.read("key");
    },
    ExtendedStorageError,
    "ghost",
  );
  assertEquals(error.code, EXTENDED_STORAGE_ERROR_CODES.UNKNOWN_CODEC);
  assertEquals(ttl.calls.isExpired, 0);
  assertEquals(storage.calls.deletes, []);
});

// ---------------------------------------------------------------------------
// Read-only codecs
// ---------------------------------------------------------------------------

Deno.test("VAL-RO-001 decoders are validated like write codecs", () => {
  const badIds: readonly unknown[] = ["", undefined, null, 1, {}];
  for (const badId of badIds) {
    const error = assertThrows(
      () =>
        createExtendedStorage({
          storage: backing(),
          decoders: [{ id: badId as never, decode: (b) => b }],
        }),
      ExtendedStorageError,
    );
    assertEquals(error.code, EXTENDED_STORAGE_ERROR_CODES.INVALID_CODEC_ID);
  }
});

Deno.test("VAL-RO-002 an id registered in both lists is rejected as a duplicate", () => {
  const error = assertThrows(
    () =>
      createExtendedStorage({
        storage: backing(),
        codecs: [spyCodec("dup")],
        decoders: [readOnlySpy("dup")],
      }),
    ExtendedStorageError,
    "dup",
  );
  assertEquals(
    error.code,
    EXTENDED_STORAGE_ERROR_CODES.DUPLICATE_CODEC_ID,
  );
});

Deno.test("VAL-RO-003 read-only codecs are never applied on write", async () => {
  const storage = backing();
  const full = spyCodec("full", { expired: false });
  const adapter = createExtendedStorage<number>({
    storage,
    codecs: [spyCodec("active")],
    decoders: [readOnlySpy("legacy"), full],
  });

  await adapter.write("key", 1);

  assertEquals(
    (await rawRead(storage, "key")).codecs.map((r) => r.id),
    ["active"],
  );
  assertEquals(full.calls.encode, 0);
});

Deno.test("VAL-RO-004 rows produced by a retired codec stay readable and are rewritten without it", async () => {
  const storage = backing();
  const keep = spyCodec("keep");
  const retired = spyCodec("retired", { reverse: true, meta: { v: 1 } });
  const oldAdapter = createExtendedStorage<{ migrated: boolean }>({
    storage,
    codecs: [keep, retired],
  });
  await oldAdapter.write("key", { migrated: false });

  let seen: CodecRecord | undefined;
  const legacy = readOnlySpy("retired", {
    reverse: true,
    onDecode: (_, r) => seen = r,
  });
  const newAdapter = createExtendedStorage<{ migrated: boolean }>({
    storage,
    codecs: [keep],
    decoders: [legacy],
  });

  assertEquals(await newAdapter.read("key"), { migrated: false });
  assertEquals(legacy.calls.decode, 1);
  assertEquals(seen, { id: "retired", version: "1.0.0", meta: { v: 1 } });

  await newAdapter.write("key", { migrated: true });
  assertEquals(
    (await rawRead(storage, "key")).codecs.map((r) => r.id),
    ["keep"],
  );

  const finalAdapter = createExtendedStorage<{ migrated: boolean }>({
    storage,
    codecs: [keep],
  });
  assertEquals(await finalAdapter.read("key"), { migrated: true });
});

Deno.test("VAL-RO-005 isExpired on a read-only codec expires the row for read and has", async () => {
  const storage = spyStorage(backing());
  const writer = createExtendedStorage<number>({
    storage,
    codecs: [spyCodec("ttl", { meta: { dead: true } })],
  });
  await writer.write("a", 1);
  await writer.write("b", 2);
  storage.calls.deletes.length = 0;

  const legacy = readOnlySpy("ttl", { expired: (r) => r.meta.dead === true });
  const reader = createExtendedStorage<number>({
    storage,
    decoders: [legacy],
  });

  assertEquals(await reader.read("a"), undefined);
  assertEquals(await reader.has!("b"), false);
  assertEquals(storage.calls.deletes, ["a", "b"]);
  assertEquals(legacy.calls.decode, 0);
});

// ---------------------------------------------------------------------------
// Deletion
// ---------------------------------------------------------------------------

Deno.test("VAL-DEL-001 delete delegates directly to backing storage without codecs", async () => {
  const storage = spyStorage(backing());
  const codec = spyCodec("a", { expired: false });
  const adapter = createExtendedStorage<number>({
    storage,
    codecs: [codec],
  });
  await adapter.write("key", 1);

  await adapter.delete("key");

  assertEquals(storage.calls.deletes, ["key"]);
  assertEquals(codec.calls.decode, 0);
  assertEquals(codec.calls.isExpired, 0);
  assertEquals(await storage.read("key"), undefined);
});

// ---------------------------------------------------------------------------
// Envelope validation
// ---------------------------------------------------------------------------

function assertInvalidEnvelope(value: unknown, message?: string): void {
  const error = assertThrows(
    () => assertValidSerializedEnvelope(value),
    ExtendedStorageError,
    message,
  );
  assertEquals(error.code, EXTENDED_STORAGE_ERROR_CODES.INVALID_ENVELOPE);
}

Deno.test("VAL-ENV-001 rejects non-object values", () => {
  for (const value of [undefined, null, 1, "x", [], () => {}]) {
    assertInvalidEnvelope(value, "non-null object");
  }
});

Deno.test("VAL-ENV-002 rejects wrong discriminator", () => {
  assertInvalidEnvelope(
    { ...validSerializedEnvelope(), discriminator: "other" },
    "discriminator",
  );
  assertInvalidEnvelope(
    { ...validSerializedEnvelope(), discriminator: undefined },
    "discriminator",
  );
});

Deno.test("VAL-ENV-003 rejects non-string version", () => {
  assertInvalidEnvelope(
    { ...validSerializedEnvelope(), version: 1 },
    "version",
  );
});

Deno.test("VAL-ENV-004 rejects codecs that are not an array", () => {
  for (const codecs of [undefined, null, {}, "a"]) {
    assertInvalidEnvelope(
      { ...validSerializedEnvelope(), codecs },
      "codecs",
    );
  }
});

Deno.test("VAL-ENV-005 rejects malformed codec records", () => {
  const cases: Array<[unknown, string]> = [
    [null, "codec at index 0"],
    [[], "codec at index 0"],
    ["a", "codec at index 0"],
    [{ ...record("a"), id: "" }, "id at index 0"],
    [{ ...record("a"), id: 1 }, "id at index 0"],
    [{ ...record("a"), version: 1 }, "version at index 0"],
    [{ ...record("a"), meta: undefined }, "meta at index 0"],
    [{ ...record("a"), meta: null }, "meta at index 0"],
    [{ ...record("a"), meta: [] }, "meta at index 0"],
    [{ ...record("a"), meta: "m" }, "meta at index 0"],
  ];
  for (const [bad, message] of cases) {
    assertInvalidEnvelope(
      { ...validSerializedEnvelope(), codecs: [bad] },
      message,
    );
  }
  assertInvalidEnvelope(
    { ...validSerializedEnvelope(), codecs: [record("a"), null] },
    "codec at index 1",
  );
});

Deno.test("VAL-ENV-006 rejects unknown encodings", () => {
  for (const encoding of [undefined, "hex", "UTF8", 1]) {
    assertInvalidEnvelope(
      { ...validSerializedEnvelope(), encoding },
      "encoding",
    );
  }
});

Deno.test("VAL-ENV-007 rejects non-string body", () => {
  for (const body of [undefined, null, 1, new Uint8Array()]) {
    assertInvalidEnvelope({ ...validSerializedEnvelope(), body }, "body");
  }
});

Deno.test("VAL-ENV-008 accepts valid envelopes and ignores extra properties", () => {
  assertValidSerializedEnvelope(validSerializedEnvelope());
  assertValidSerializedEnvelope(validSerializedEnvelope({
    encoding: "base64",
    codecs: [record("a"), record("b", { meta: { n: 1 } })],
  }));
  assertValidSerializedEnvelope({ ...validSerializedEnvelope(), extra: true });
});

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

Deno.test("VAL-EXPORT-001 exposes the public package API surface", () => {
  const options: CreateExtendedStorageOptions = { storage: backing() };
  assert(options.storage);

  assertEquals(Object.keys(publicApi).sort(), [
    "ENVELOPE_DISCRIMINATOR",
    "EXTENDED_STORAGE_ERROR_CODES",
    "ExtendedStorageError",
    "PACKAGE_VERSION",
    "assertValidSerializedEnvelope",
    "createExtendedStorage",
  ]);
  assertEquals(publicApi.EXTENDED_STORAGE_ERROR_CODES, {
    INVALID_CODEC_ID: "ERR_INVALID_CODEC_ID",
    DUPLICATE_CODEC_ID: "ERR_DUPLICATE_CODEC_ID",
    VALUE_SERIALIZATION: "ERR_VALUE_SERIALIZATION",
    INVALID_ENVELOPE: "ERR_INVALID_ENVELOPE",
    INVALID_CODEC_OUTPUT: "ERR_INVALID_CODEC_OUTPUT",
    UNKNOWN_CODEC: "ERR_UNKNOWN_CODEC",
  });
  assertStrictEquals(
    publicApi.ENVELOPE_DISCRIMINATOR,
    "grammy-storage-extension",
  );
});

// ---------------------------------------------------------------------------
// Cross-cutting
// ---------------------------------------------------------------------------

Deno.test("VAL-CROSS-001 gzip + ttl chain roundtrips on real grammY MemorySessionStorage", async () => {
  interface Session {
    items: [number, { flag: boolean }];
  }
  const storage = backing();
  const adapter = createExtendedStorage<Session>({
    storage,
    codecs: [gzipCodec(), ttlCodec("ttl", 60_000)],
  });
  const key = "session:1";
  const session: Session = { items: [1, { flag: true }] };

  await adapter.write(key, session);
  assertEquals(await adapter.read(key), session);

  const stored = await rawRead(storage, key);
  assertEquals(stored.encoding, "base64");
  assertEquals(stored.codecs.map((r) => r.id), ["gzip", "ttl"]);
  // JSON text is '{"items":[1,{"flag":true}]}': 27 UTF-8 bytes.
  assertEquals(stored.codecs[0].meta, { rawLength: 27 });
  assertEquals(typeof stored.codecs[1].meta.expiresAt, "number");
});

Deno.test("VAL-CROSS-002 adding an unused codec does not break reads of pre-existing data", async () => {
  const storage = backing();
  const a = spyCodec("a", { reverse: true });
  const b = spyCodec("b", { expired: true });
  const writer = createExtendedStorage<{ persisted: boolean }>({
    storage,
    codecs: [a],
  });
  const reader = createExtendedStorage<{ persisted: boolean }>({
    storage,
    codecs: [a, b],
  });

  await writer.write("key", { persisted: true });

  assertEquals(await reader.read("key"), { persisted: true });
  assertEquals(b.calls, { encode: 0, decode: 0, isExpired: 0 });
});

Deno.test("VAL-CROSS-003 read fails informatively when a required codec is missing", async () => {
  const storage = backing();
  const a = spyCodec("a");
  const b = spyCodec("b");
  const writer = createExtendedStorage<{ persisted: boolean }>({
    storage,
    codecs: [a, b],
  });
  const reader = createExtendedStorage<{ persisted: boolean }>({
    storage,
    codecs: [a],
  });

  await writer.write("key", { persisted: true });

  const error = await assertRejects(
    async () => {
      await reader.read("key");
    },
    ExtendedStorageError,
    "b",
  );
  assertEquals(error.code, EXTENDED_STORAGE_ERROR_CODES.UNKNOWN_CODEC);
});

Deno.test("VAL-CROSS-004 mixed sync and async codecs roundtrip", async () => {
  for (
    const codecs of [
      [
        spyCodec("sync-a", { reverse: true }),
        spyCodec("async-b", { encodeAsync: true, decodeAsync: true }),
      ],
      [
        spyCodec("async-a", {
          encodeAsync: true,
          decodeAsync: true,
          reverse: true,
        }),
        spyCodec("sync-b"),
      ],
    ]
  ) {
    const adapter = createExtendedStorage<{ mixed: boolean }>({
      storage: backing(),
      codecs,
    });

    await adapter.write("key", { mixed: true });

    assertEquals(await adapter.read("key"), { mixed: true });
  }
});

Deno.test("VAL-CROSS-005 expired ttl rows are invisible to has, readAllKeys and read, and are deleted", async () => {
  const storage = backing();
  let now = 1_000;
  const adapter = createExtendedStorage<number>({
    storage,
    codecs: [gzipCodec(), ttlCodec("ttl", 100, () => now)],
  });
  await adapter.write("fresh", 1);
  now = 1_050;
  await adapter.write("later", 2);
  now = 1_120; // "fresh" expired at 1_100, "later" expires at 1_150

  assertEquals(await adapter.has!("fresh"), false);
  assertEquals(await storage.read("fresh"), undefined);
  assertEquals(await adapter.has!("later"), true);

  const keys: string[] = [];
  for await (const key of adapter.readAllKeys!()) keys.push(key);
  assertEquals(keys, ["later"]);

  now = 1_200;
  assertEquals(await adapter.read("later"), undefined);
  assertEquals(await storage.read("later"), undefined);
});
