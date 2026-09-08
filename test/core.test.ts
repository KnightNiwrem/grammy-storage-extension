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
  assertValidEnvelope,
  createExtendedStorage,
  type CreateExtendedStorageOptions,
  EXTENDED_STORAGE_ERROR_CODES,
  ExtendedStorageError,
  PACKAGE_VERSION,
  RESERVED_TRANSFORM_KIND_PREFIX,
  STORAGE_ENVELOPE_KIND,
  type StorageEnvelope,
  type StorageTransform,
  type StorageTransformRecord,
} from "../src/mod.ts";
import {
  gzipTransform,
  readOnlySpy,
  record,
  spyTransform,
  ttlTransform,
  validEnvelope,
} from "./helpers.ts";

type SpyableStorage = StorageAdapter<StorageEnvelope> & {
  read(
    key: string,
  ): StorageEnvelope | undefined | Promise<StorageEnvelope | undefined>;
  write(key: string, value: StorageEnvelope): void | Promise<void>;
  delete(key: string): void | Promise<void>;
};

type SpyCalls = {
  writes: Array<{ key: string; value: StorageEnvelope }>;
  deletes: string[];
};

function backing(): SpyableStorage {
  return new MemorySessionStorage<StorageEnvelope>() as SpyableStorage;
}

function spyStorage(
  storage: SpyableStorage,
): SpyableStorage & { calls: SpyCalls } {
  const originalWrite = storage.write.bind(storage);
  const originalDelete = storage.delete.bind(storage);
  const calls: SpyCalls = { writes: [], deletes: [] };

  storage.write = async (key: string, value: StorageEnvelope) => {
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
): Promise<StorageEnvelope> {
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

Deno.test("VAL-CONSTR-001 returns a usable StorageAdapter<T> with no transforms", async () => {
  const storage = backing();
  const adapter = createExtendedStorage<{ count: number }>({ storage });

  await adapter.write("key", { count: 1 });

  assertEquals(await adapter.read("key"), { count: 1 });
  assertEquals(await rawRead(storage, "key"), {
    kind: STORAGE_ENVELOPE_KIND,
    version: PACKAGE_VERSION,
    transforms: [],
    encoding: "utf8",
    body: '{"count":1}',
  });
});

Deno.test("VAL-CONSTR-002 accepts an empty transforms array", async () => {
  const adapter = createExtendedStorage<number>({
    storage: backing(),
    transforms: [],
  });
  await adapter.write("key", 1);
  assertEquals(await adapter.read("key"), 1);
});

Deno.test("VAL-CONSTR-003 rejects empty transform kinds", () => {
  const error = assertThrows(
    () =>
      createExtendedStorage({
        storage: backing(),
        transforms: [spyTransform("")],
      }),
    ExtendedStorageError,
  );
  assertEquals(error.code, EXTENDED_STORAGE_ERROR_CODES.EMPTY_TRANSFORM_KIND);
});

Deno.test("VAL-CONSTR-004 rejects reserved transform kind prefix", () => {
  const error = assertThrows(
    () =>
      createExtendedStorage({
        storage: backing(),
        transforms: [spyTransform(`${RESERVED_TRANSFORM_KIND_PREFIX}x`)],
      }),
    ExtendedStorageError,
    RESERVED_TRANSFORM_KIND_PREFIX,
  );
  assertEquals(
    error.code,
    EXTENDED_STORAGE_ERROR_CODES.RESERVED_TRANSFORM_KIND,
  );
});

Deno.test("VAL-CONSTR-005 rejects duplicate transform kinds", () => {
  const error = assertThrows(
    () =>
      createExtendedStorage({
        storage: backing(),
        transforms: [spyTransform("dup"), spyTransform("dup")],
      }),
    ExtendedStorageError,
    "dup",
  );
  assertEquals(
    error.code,
    EXTENDED_STORAGE_ERROR_CODES.DUPLICATE_TRANSFORM_KIND,
  );
});

Deno.test("VAL-CONSTR-006 transforms are applied to writes in declaration order", async () => {
  const storage = backing();
  const order: string[] = [];
  const adapter = createExtendedStorage<number>({
    storage,
    transforms: [
      spyTransform("first", { onEncode: () => order.push("first") }),
      spyTransform("second", { onEncode: () => order.push("second") }),
    ],
  });

  await adapter.write("key", 1);

  assertEquals(order, ["first", "second"]);
  assertEquals(
    (await rawRead(storage, "key")).transforms.map((r) => r.kind),
    ["first", "second"],
  );
});

Deno.test("VAL-CONSTR-007 mutating the transforms array after construction does not affect writes", async () => {
  const storage = backing();
  const transforms: StorageTransform[] = [spyTransform("first")];
  const adapter = createExtendedStorage<number>({ storage, transforms });

  transforms.push(spyTransform("second"));
  await adapter.write("key", 1);

  assertEquals(
    (await rawRead(storage, "key")).transforms.map((r) => r.kind),
    ["first"],
  );
});

Deno.test("VAL-CONSTR-008 PACKAGE_VERSION matches the version in deno.json", () => {
  assertStrictEquals(PACKAGE_VERSION, denoConfig.version);
});

// ---------------------------------------------------------------------------
// Body serialization
// ---------------------------------------------------------------------------

Deno.test("VAL-BODY-001 zero-transform write produces a readable utf8 envelope", async () => {
  const storage = spyStorage(backing());
  const adapter = createExtendedStorage<{ a: number }>({ storage });

  await adapter.write("key", { a: 1 });

  assertEquals(storage.calls.writes, [{
    key: "key",
    value: validEnvelope({ body: '{"a":1}' }),
  }]);
});

Deno.test("VAL-BODY-002 read decodes a utf8 body with JSON.parse", async () => {
  const storage = backing();
  const adapter = createExtendedStorage<{ parsed: boolean }>({ storage });
  await storage.write("key", validEnvelope({ body: '{"parsed":true}' }));

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
  await storage.write("key", validEnvelope({ body: "{not json" }));

  await assertRejects(async () => {
    await adapter.read("key");
  }, SyntaxError);
});

Deno.test("VAL-BODY-006 invalid UTF-8 body throws the native decoding error", async () => {
  const storage = backing();
  const adapter = createExtendedStorage({ storage });
  await storage.write(
    "key",
    validEnvelope({
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

Deno.test("VAL-BODY-009 base64 body with zero transforms is decoded by its encoding field", async () => {
  const storage = backing();
  const adapter = createExtendedStorage<number[]>({ storage });
  await storage.write(
    "key",
    validEnvelope({ encoding: "base64", body: base64(utf8.encode("[1,2]")) }),
  );

  assertEquals(await adapter.read("key"), [1, 2]);
});

Deno.test("VAL-BODY-010 invalid base64 body throws the native decoding error", async () => {
  for (
    const [body, ErrorClass] of [["!!!", TypeError], ["0", RangeError]] as const
  ) {
    const storage = backing();
    const adapter = createExtendedStorage({ storage });
    await storage.write("key", validEnvelope({ encoding: "base64", body }));

    await assertRejects(async () => {
      await adapter.read("key");
    }, ErrorClass);
  }
});

// ---------------------------------------------------------------------------
// Write pipeline
// ---------------------------------------------------------------------------

Deno.test("VAL-WRITE-001 single transform records its identity, normalises meta, and base64-encodes the body", async () => {
  const storage = backing();
  const adapter = createExtendedStorage<{ a: number }>({
    storage,
    transforms: [spyTransform("rev", { version: "2.1.0", reverse: true })],
  });

  await adapter.write("key", { a: 1 });

  assertEquals(await rawRead(storage, "key"), {
    kind: STORAGE_ENVELOPE_KIND,
    version: PACKAGE_VERSION,
    transforms: [{ kind: "rev", version: "2.1.0", meta: {} }],
    encoding: "base64",
    body: base64(reversed('{"a":1}')),
  });
});

Deno.test("VAL-WRITE-002 multiple transforms compose in declaration order", async () => {
  const storage = backing();
  const seen: Record<string, Uint8Array> = {};
  const adapter = createExtendedStorage<string>({
    storage,
    transforms: [
      spyTransform("rev", { reverse: true, onEncode: (b) => seen.rev = b }),
      spyTransform("id", { onEncode: (b) => seen.id = b }),
    ],
  });

  await adapter.write("key", "ab");

  assertEquals(seen.rev, utf8.encode('"ab"'));
  assertEquals(seen.id, reversed('"ab"'));
  assertEquals(
    (await rawRead(storage, "key")).transforms.map((r) => r.kind),
    ["rev", "id"],
  );
  assertEquals(await adapter.read("key"), "ab");
});

Deno.test("VAL-WRITE-003 meta returned by encode is recorded on the transform entry", async () => {
  const storage = backing();
  const adapter = createExtendedStorage<number>({
    storage,
    transforms: [spyTransform("tagged", { meta: { tag: "x", n: 2 } })],
  });

  await adapter.write("key", 1);

  assertEquals((await rawRead(storage, "key")).transforms, [
    { kind: "tagged", version: "1.0.0", meta: { tag: "x", n: 2 } },
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
      transforms: [{
        kind: "bad",
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
      EXTENDED_STORAGE_ERROR_CODES.INVALID_TRANSFORM_OUTPUT,
    );
    assertEquals(storage.calls.writes, []);
  }
});

Deno.test("VAL-WRITE-005 async encode is supported and applied sequentially", async () => {
  const storage = backing();
  const order: string[] = [];
  const adapter = createExtendedStorage<string>({
    storage,
    transforms: [
      spyTransform("a", {
        encodeAsync: true,
        reverse: true,
        onEncode: () => order.push("a"),
      }),
      spyTransform("b", { encodeAsync: true, onEncode: () => order.push("b") }),
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
    transforms: [spyTransform("a"), spyTransform("b")],
  });

  await adapter.write("key", 1);

  assertEquals(storage.calls.writes.length, 1);
  assertEquals(storage.calls.writes[0].key, "key");
});

Deno.test("VAL-WRITE-007 a transform failing mid-chain prevents any write", async () => {
  const storage = spyStorage(backing());
  const adapter = createExtendedStorage<number>({
    storage,
    transforms: [
      spyTransform("ok"),
      {
        kind: "boom",
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
  const transform = spyTransform("a", { expired: false });
  const adapter = createExtendedStorage({
    storage: backing(),
    transforms: [transform],
  });

  assertEquals(await adapter.read("missing"), undefined);
  assertEquals(transform.calls, { encode: 0, decode: 0, isExpired: 0 });
});

Deno.test("VAL-READ-002 decode walks the recorded transforms in reverse order", async () => {
  const storage = backing();
  const order: string[] = [];
  const adapter = createExtendedStorage<number>({
    storage,
    transforms: [
      spyTransform("a", { onDecode: () => order.push("a") }),
      spyTransform("b", { onDecode: () => order.push("b") }),
      spyTransform("c", { onDecode: () => order.push("c") }),
    ],
  });
  await adapter.write("key", 1);

  assertEquals(await adapter.read("key"), 1);
  assertEquals(order, ["c", "b", "a"]);
});

Deno.test("VAL-READ-003 read order follows the record, not declaration order", async () => {
  const storage = backing();
  const a = spyTransform("a", { reverse: true });
  const b = spyTransform("b");
  const writer = createExtendedStorage<{ swapped: boolean }>({
    storage,
    transforms: [a, b],
  });
  const reader = createExtendedStorage<{ swapped: boolean }>({
    storage,
    transforms: [b, a],
  });

  await writer.write("key", { swapped: true });

  assertEquals(await reader.read("key"), { swapped: true });
});

Deno.test("VAL-READ-004 unknown transform kind throws with the kind in the message", async () => {
  const storage = backing();
  const adapter = createExtendedStorage({ storage });
  await storage.write(
    "key",
    validEnvelope({ transforms: [record("ghost")] }),
  );

  const error = await assertRejects(
    async () => {
      await adapter.read("key");
    },
    ExtendedStorageError,
    "ghost",
  );
  assertEquals(error.code, EXTENDED_STORAGE_ERROR_CODES.UNKNOWN_TRANSFORM);
});

Deno.test("VAL-READ-005 malformed backing envelope throws", async () => {
  const storage = backing();
  const adapter = createExtendedStorage({ storage });
  await rawWrite(storage, "key", { transforms: 42 });

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
      transforms: [{
        kind: "bad",
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
      EXTENDED_STORAGE_ERROR_CODES.INVALID_TRANSFORM_OUTPUT,
    );
    assertEquals(storage.calls.deletes, []);
  }
});

Deno.test("VAL-READ-007 async decode is supported", async () => {
  const adapter = createExtendedStorage<number[]>({
    storage: backing(),
    transforms: [spyTransform("a", { decodeAsync: true, reverse: true })],
  });
  await adapter.write("key", [1, 2, 3]);

  assertEquals(await adapter.read("key"), [1, 2, 3]);
});

Deno.test("VAL-READ-008 errors thrown by decode propagate without deleting", async () => {
  const storage = spyStorage(backing());
  const adapter = createExtendedStorage<number>({
    storage,
    transforms: [{
      kind: "boom",
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
  let received: StorageTransformRecord | undefined;
  const adapter = createExtendedStorage<number>({
    storage,
    transforms: [
      spyTransform("a", { version: "2.0.0", onDecode: (_, r) => received = r }),
    ],
  });
  await storage.write(
    "key",
    validEnvelope({
      transforms: [record("a", { version: "1.0.0", meta: { legacy: true } })],
      body: "7",
    }),
  );

  assertEquals(await adapter.read("key"), 7);
  assertEquals(received, {
    kind: "a",
    version: "1.0.0",
    meta: { legacy: true },
  });
});

// ---------------------------------------------------------------------------
// Expiry
// ---------------------------------------------------------------------------

Deno.test("VAL-EXPIRE-001 expired entry reads as undefined, is deleted once, and is never decoded", async () => {
  const storage = spyStorage(backing());
  const transform = spyTransform("ttl", { expired: true });
  const adapter = createExtendedStorage<number>({
    storage,
    transforms: [transform],
  });
  await adapter.write("key", 1);
  storage.calls.deletes.length = 0;

  assertEquals(await adapter.read("key"), undefined);

  assertEquals(storage.calls.deletes, ["key"]);
  assertEquals(transform.calls.decode, 0);
  assertEquals(transform.calls.isExpired, 1);
  assertEquals(await storage.read("key"), undefined);
});

Deno.test("VAL-EXPIRE-002 isExpired receives its own record with meta", async () => {
  const storage = backing();
  let received: StorageTransformRecord | undefined;
  const adapter = createExtendedStorage<number>({
    storage,
    transforms: [
      spyTransform("other", { meta: { other: true } }),
      spyTransform("ttl", {
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
    kind: "ttl",
    version: "1.0.0",
    meta: { expiresAt: 5 },
  });
});

Deno.test("VAL-EXPIRE-003 checks run in recorded order and short-circuit on the first true", async () => {
  const storage = backing();
  const order: string[] = [];
  const first = spyTransform("first", {
    expired: () => {
      order.push("first");
      return true;
    },
  });
  const second = spyTransform("second", {
    expired: () => {
      order.push("second");
      return false;
    },
  });
  const adapter = createExtendedStorage<number>({
    storage,
    transforms: [first, second],
  });
  await adapter.write("key", 1);

  assertEquals(await adapter.read("key"), undefined);
  assertEquals(order, ["first"]);
  assertEquals(second.calls.isExpired, 0);
});

Deno.test("VAL-EXPIRE-004 any transform reporting expiry wins", async () => {
  const storage = backing();
  const adapter = createExtendedStorage<number>({
    storage,
    transforms: [
      spyTransform("alive", { expired: false }),
      spyTransform("plain"),
      spyTransform("dead", { expired: true }),
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
    transforms: [
      spyTransform("boom", {
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

Deno.test("VAL-EXPIRE-006 transforms without isExpired are skipped and live entries decode normally", async () => {
  const storage = spyStorage(backing());
  const plain = spyTransform("plain", { reverse: true });
  const alive = spyTransform("alive", { expired: false });
  const adapter = createExtendedStorage<{ live: boolean }>({
    storage,
    transforms: [plain, alive],
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
    transforms: [spyTransform("ttl", { expired: true })],
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
    transforms: [{
      kind: "ttl",
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

Deno.test("VAL-EXPIRE-009 unknown transform kinds are rejected before any expiry check runs", async () => {
  const storage = spyStorage(backing());
  const ttl = spyTransform("ttl", { expired: true });
  const adapter = createExtendedStorage({ storage, transforms: [ttl] });
  await storage.write(
    "key",
    validEnvelope({ transforms: [record("ttl"), record("ghost")] }),
  );

  const error = await assertRejects(
    async () => {
      await adapter.read("key");
    },
    ExtendedStorageError,
    "ghost",
  );
  assertEquals(error.code, EXTENDED_STORAGE_ERROR_CODES.UNKNOWN_TRANSFORM);
  assertEquals(ttl.calls.isExpired, 0);
  assertEquals(storage.calls.deletes, []);
});

// ---------------------------------------------------------------------------
// Read-only transforms
// ---------------------------------------------------------------------------

Deno.test("VAL-RO-001 read-only transforms are validated like write transforms", () => {
  for (
    const [readOnly, code] of [
      [readOnlySpy(""), EXTENDED_STORAGE_ERROR_CODES.EMPTY_TRANSFORM_KIND],
      [
        readOnlySpy(`${RESERVED_TRANSFORM_KIND_PREFIX}legacy`),
        EXTENDED_STORAGE_ERROR_CODES.RESERVED_TRANSFORM_KIND,
      ],
    ] as const
  ) {
    const error = assertThrows(
      () =>
        createExtendedStorage({
          storage: backing(),
          readOnlyTransforms: [readOnly],
        }),
      ExtendedStorageError,
    );
    assertEquals(error.code, code);
  }
});

Deno.test("VAL-RO-002 a kind registered in both lists is rejected as a duplicate", () => {
  const error = assertThrows(
    () =>
      createExtendedStorage({
        storage: backing(),
        transforms: [spyTransform("dup")],
        readOnlyTransforms: [readOnlySpy("dup")],
      }),
    ExtendedStorageError,
    "dup",
  );
  assertEquals(
    error.code,
    EXTENDED_STORAGE_ERROR_CODES.DUPLICATE_TRANSFORM_KIND,
  );
});

Deno.test("VAL-RO-003 read-only transforms are never applied on write", async () => {
  const storage = backing();
  const full = spyTransform("full", { expired: false });
  const adapter = createExtendedStorage<number>({
    storage,
    transforms: [spyTransform("active")],
    readOnlyTransforms: [readOnlySpy("legacy"), full],
  });

  await adapter.write("key", 1);

  assertEquals(
    (await rawRead(storage, "key")).transforms.map((r) => r.kind),
    ["active"],
  );
  assertEquals(full.calls.encode, 0);
});

Deno.test("VAL-RO-004 rows produced by a retired transform stay readable and are rewritten without it", async () => {
  const storage = backing();
  const keep = spyTransform("keep");
  const retired = spyTransform("retired", { reverse: true, meta: { v: 1 } });
  const oldAdapter = createExtendedStorage<{ migrated: boolean }>({
    storage,
    transforms: [keep, retired],
  });
  await oldAdapter.write("key", { migrated: false });

  let seen: StorageTransformRecord | undefined;
  const legacy = readOnlySpy("retired", {
    reverse: true,
    onDecode: (_, r) => seen = r,
  });
  const newAdapter = createExtendedStorage<{ migrated: boolean }>({
    storage,
    transforms: [keep],
    readOnlyTransforms: [legacy],
  });

  assertEquals(await newAdapter.read("key"), { migrated: false });
  assertEquals(legacy.calls.decode, 1);
  assertEquals(seen, { kind: "retired", version: "1.0.0", meta: { v: 1 } });

  await newAdapter.write("key", { migrated: true });
  assertEquals(
    (await rawRead(storage, "key")).transforms.map((r) => r.kind),
    ["keep"],
  );

  const finalAdapter = createExtendedStorage<{ migrated: boolean }>({
    storage,
    transforms: [keep],
  });
  assertEquals(await finalAdapter.read("key"), { migrated: true });
});

Deno.test("VAL-RO-005 isExpired on a read-only transform expires the row for read and has", async () => {
  const storage = spyStorage(backing());
  const writer = createExtendedStorage<number>({
    storage,
    transforms: [spyTransform("ttl", { meta: { dead: true } })],
  });
  await writer.write("a", 1);
  await writer.write("b", 2);
  storage.calls.deletes.length = 0;

  const legacy = readOnlySpy("ttl", { expired: (r) => r.meta.dead === true });
  const reader = createExtendedStorage<number>({
    storage,
    readOnlyTransforms: [legacy],
  });

  assertEquals(await reader.read("a"), undefined);
  assertEquals(await reader.has!("b"), false);
  assertEquals(storage.calls.deletes, ["a", "b"]);
  assertEquals(legacy.calls.decode, 0);
});

// ---------------------------------------------------------------------------
// Deletion
// ---------------------------------------------------------------------------

Deno.test("VAL-DEL-001 delete delegates directly to backing storage without transforms", async () => {
  const storage = spyStorage(backing());
  const transform = spyTransform("a", { expired: false });
  const adapter = createExtendedStorage<number>({
    storage,
    transforms: [transform],
  });
  await adapter.write("key", 1);

  await adapter.delete("key");

  assertEquals(storage.calls.deletes, ["key"]);
  assertEquals(transform.calls.decode, 0);
  assertEquals(transform.calls.isExpired, 0);
  assertEquals(await storage.read("key"), undefined);
});

// ---------------------------------------------------------------------------
// Envelope validation
// ---------------------------------------------------------------------------

function assertInvalidEnvelope(value: unknown, message?: string): void {
  const error = assertThrows(
    () => assertValidEnvelope(value),
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

Deno.test("VAL-ENV-002 rejects wrong kind", () => {
  assertInvalidEnvelope({ ...validEnvelope(), kind: "other" }, "kind");
  assertInvalidEnvelope({ ...validEnvelope(), kind: undefined }, "kind");
});

Deno.test("VAL-ENV-003 rejects non-string version", () => {
  assertInvalidEnvelope({ ...validEnvelope(), version: 1 }, "version");
});

Deno.test("VAL-ENV-004 rejects transforms that are not an array", () => {
  for (const transforms of [undefined, null, {}, "a"]) {
    assertInvalidEnvelope(
      { ...validEnvelope(), transforms },
      "transforms",
    );
  }
});

Deno.test("VAL-ENV-005 rejects malformed transform records", () => {
  const cases: Array<[unknown, string]> = [
    [null, "transform at index 0"],
    [[], "transform at index 0"],
    ["a", "transform at index 0"],
    [{ ...record("a"), kind: "" }, "kind at index 0"],
    [{ ...record("a"), kind: 1 }, "kind at index 0"],
    [{ ...record("a"), version: 1 }, "version at index 0"],
    [{ ...record("a"), meta: undefined }, "meta at index 0"],
    [{ ...record("a"), meta: null }, "meta at index 0"],
    [{ ...record("a"), meta: [] }, "meta at index 0"],
    [{ ...record("a"), meta: "m" }, "meta at index 0"],
  ];
  for (const [bad, message] of cases) {
    assertInvalidEnvelope({ ...validEnvelope(), transforms: [bad] }, message);
  }
  assertInvalidEnvelope(
    { ...validEnvelope(), transforms: [record("a"), null] },
    "transform at index 1",
  );
});

Deno.test("VAL-ENV-006 rejects unknown encodings", () => {
  for (const encoding of [undefined, "hex", "UTF8", 1]) {
    assertInvalidEnvelope({ ...validEnvelope(), encoding }, "encoding");
  }
});

Deno.test("VAL-ENV-007 rejects non-string body", () => {
  for (const body of [undefined, null, 1, new Uint8Array()]) {
    assertInvalidEnvelope({ ...validEnvelope(), body }, "body");
  }
});

Deno.test("VAL-ENV-008 accepts valid envelopes and ignores extra properties", () => {
  assertValidEnvelope(validEnvelope());
  assertValidEnvelope(validEnvelope({
    encoding: "base64",
    transforms: [record("a"), record("b", { meta: { n: 1 } })],
  }));
  assertValidEnvelope({ ...validEnvelope(), extra: true });
});

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

Deno.test("VAL-EXPORT-001 exposes the public package API surface", () => {
  const options: CreateExtendedStorageOptions = { storage: backing() };
  assert(options.storage);

  assertEquals(Object.keys(publicApi).sort(), [
    "EXTENDED_STORAGE_ERROR_CODES",
    "ExtendedStorageError",
    "PACKAGE_VERSION",
    "RESERVED_TRANSFORM_KIND_PREFIX",
    "STORAGE_ENVELOPE_KIND",
    "assertValidEnvelope",
    "createExtendedStorage",
  ]);
  assertEquals(publicApi.EXTENDED_STORAGE_ERROR_CODES, {
    EMPTY_TRANSFORM_KIND: "ERR_EMPTY_TRANSFORM_KIND",
    RESERVED_TRANSFORM_KIND: "ERR_RESERVED_TRANSFORM_KIND",
    DUPLICATE_TRANSFORM_KIND: "ERR_DUPLICATE_TRANSFORM_KIND",
    VALUE_SERIALIZATION: "ERR_VALUE_SERIALIZATION",
    INVALID_ENVELOPE: "ERR_INVALID_ENVELOPE",
    INVALID_TRANSFORM_OUTPUT: "ERR_INVALID_TRANSFORM_OUTPUT",
    UNKNOWN_TRANSFORM: "ERR_UNKNOWN_TRANSFORM",
  });
  assertStrictEquals(
    publicApi.STORAGE_ENVELOPE_KIND,
    "grammy-extended-storage-envelope",
  );
  assertStrictEquals(
    publicApi.RESERVED_TRANSFORM_KIND_PREFIX,
    "grammy-extended-storage-",
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
    transforms: [gzipTransform(), ttlTransform("ttl", 60_000)],
  });
  const key = "session:1";
  const session: Session = { items: [1, { flag: true }] };

  await adapter.write(key, session);
  assertEquals(await adapter.read(key), session);

  const stored = await rawRead(storage, key);
  assertEquals(stored.encoding, "base64");
  assertEquals(stored.transforms.map((r) => r.kind), ["gzip", "ttl"]);
  // JSON text is '{"items":[1,{"flag":true}]}': 27 UTF-8 bytes.
  assertEquals(stored.transforms[0].meta, { rawLength: 27 });
  assertEquals(typeof stored.transforms[1].meta.expiresAt, "number");
});

Deno.test("VAL-CROSS-002 adding an unused transform does not break reads of pre-existing data", async () => {
  const storage = backing();
  const a = spyTransform("a", { reverse: true });
  const b = spyTransform("b", { expired: true });
  const writer = createExtendedStorage<{ persisted: boolean }>({
    storage,
    transforms: [a],
  });
  const reader = createExtendedStorage<{ persisted: boolean }>({
    storage,
    transforms: [a, b],
  });

  await writer.write("key", { persisted: true });

  assertEquals(await reader.read("key"), { persisted: true });
  assertEquals(b.calls, { encode: 0, decode: 0, isExpired: 0 });
});

Deno.test("VAL-CROSS-003 read fails informatively when a required transform is missing", async () => {
  const storage = backing();
  const a = spyTransform("a");
  const b = spyTransform("b");
  const writer = createExtendedStorage<{ persisted: boolean }>({
    storage,
    transforms: [a, b],
  });
  const reader = createExtendedStorage<{ persisted: boolean }>({
    storage,
    transforms: [a],
  });

  await writer.write("key", { persisted: true });

  const error = await assertRejects(
    async () => {
      await reader.read("key");
    },
    ExtendedStorageError,
    "b",
  );
  assertEquals(error.code, EXTENDED_STORAGE_ERROR_CODES.UNKNOWN_TRANSFORM);
});

Deno.test("VAL-CROSS-004 mixed sync and async transforms roundtrip", async () => {
  for (
    const transforms of [
      [
        spyTransform("sync-a", { reverse: true }),
        spyTransform("async-b", { encodeAsync: true, decodeAsync: true }),
      ],
      [
        spyTransform("async-a", {
          encodeAsync: true,
          decodeAsync: true,
          reverse: true,
        }),
        spyTransform("sync-b"),
      ],
    ]
  ) {
    const adapter = createExtendedStorage<{ mixed: boolean }>({
      storage: backing(),
      transforms,
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
    transforms: [gzipTransform(), ttlTransform("ttl", 100, () => now)],
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
