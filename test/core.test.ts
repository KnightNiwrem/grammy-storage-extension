import {
  assert,
  assertEquals,
  assertRejects,
  assertStrictEquals,
  assertThrows,
} from "@std/assert";
import { MemorySessionStorage, type StorageAdapter } from "grammy";

import {
  assertValidEnvelope,
  BUILTIN_VALUE_CODEC,
  BUILTIN_VALUE_CODEC_VERSION,
  createExtendedStorage,
  MAX_DECODE_DEPTH,
  STORAGE_ENVELOPE_KIND,
  type StorageEnvelope,
  type StorageEnvelopeCodec,
} from "../src/mod.ts";
import { missingCodec, validEnvelope } from "./helpers.ts";

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

function jsonWrappingCodec(
  codec: string,
  options: {
    encodeAsync?: boolean;
    decodeAsync?: boolean;
    onEncode?: (input: StorageEnvelope) => void;
    onDecode?: (input: StorageEnvelope) => void;
  } = {},
): StorageEnvelopeCodec {
  return {
    codec,
    version: "1.0.0",
    encode(envelope) {
      options.onEncode?.(envelope);
      const encoded = validEnvelope({
        codec,
        version: "1.0.0",
        payload: JSON.stringify(envelope),
      });
      return options.encodeAsync ? Promise.resolve(encoded) : encoded;
    },
    decode(envelope) {
      options.onDecode?.(envelope);
      const decoded = JSON.parse(envelope.payload) as StorageEnvelope;
      return options.decodeAsync ? Promise.resolve(decoded) : decoded;
    },
  };
}

async function rawRead(
  storage: SpyableStorage,
  key: string,
): Promise<StorageEnvelope | undefined> {
  return await storage.read(key);
}

Deno.test("VAL-CONSTR-001 returns a usable StorageAdapter<T> with no codecs", async () => {
  const storage = backing();
  const adapter = createExtendedStorage<{ a: number }>({ storage });

  assertStrictEquals(typeof adapter.read, "function");
  assertStrictEquals(typeof adapter.write, "function");
  assertStrictEquals(typeof adapter.delete, "function");

  await adapter.write("key", { a: 1 });
  assertEquals(await adapter.read("key"), { a: 1 });
});

Deno.test("VAL-CONSTR-002 accepts an empty codecs array", async () => {
  const storage = backing();
  const adapter = createExtendedStorage<{ a: number }>({ storage, codecs: [] });

  await adapter.write("key", { a: 2 });
  assertEquals(await adapter.read("key"), { a: 2 });
});

Deno.test("VAL-CONSTR-003 rejects duplicate codec identifiers", () => {
  const storage = backing();
  const codecA = jsonWrappingCodec("duplicate");
  const codecB = jsonWrappingCodec("duplicate");

  assertThrows(
    () => createExtendedStorage({ storage, codecs: [codecA, codecB] }),
    Error,
    "duplicate",
  );
});

Deno.test("VAL-CONSTR-004 rejects reserved built-in value codec identifier", () => {
  const storage = backing();
  const codec = jsonWrappingCodec(BUILTIN_VALUE_CODEC);

  assertThrows(
    () => createExtendedStorage({ storage, codecs: [codec] }),
    Error,
    BUILTIN_VALUE_CODEC,
  );
});

Deno.test("VAL-CONSTR-005 codec list is exposed to write in declaration order", async () => {
  const storage = backing();
  const adapter = createExtendedStorage({
    storage,
    codecs: [
      jsonWrappingCodec("codec-a"),
      jsonWrappingCodec("codec-b"),
      jsonWrappingCodec("codec-c"),
    ],
  });

  await adapter.write("key", { nested: true });

  assertEquals((await rawRead(storage, "key"))?.codec, "codec-c");
});

Deno.test("VAL-BIVC-001 encodes value as the canonical envelope shape", async () => {
  const storage = backing();
  const adapter = createExtendedStorage({ storage });
  const value = { a: 1, b: ["x", null] };

  await adapter.write("key", value);

  assertEquals(await rawRead(storage, "key"), {
    kind: STORAGE_ENVELOPE_KIND,
    codec: BUILTIN_VALUE_CODEC,
    version: BUILTIN_VALUE_CODEC_VERSION,
    payload: JSON.stringify(value),
  });
});

Deno.test("VAL-BIVC-002 decodes envelope by JSON.parse(payload)", async () => {
  const storage = backing();
  const adapter = createExtendedStorage<{ parsed: boolean }>({ storage });
  await storage.write("key", validEnvelope({ payload: '{"parsed":true}' }));

  assertEquals(await adapter.read("key"), { parsed: true });
});

Deno.test("VAL-BIVC-003 roundtrips JSON-compatible primitives, arrays, and objects", async () => {
  const values = [
    null,
    0,
    42,
    -1.5,
    "",
    "hello",
    true,
    false,
    [1, 2, 3],
    { a: 1, b: ["x", null, { c: true }] },
  ];

  for (const [index, value] of values.entries()) {
    const storage = backing();
    const adapter = createExtendedStorage<unknown>({ storage });
    await adapter.write(`key-${index}`, value);
    assertEquals(await adapter.read(`key-${index}`), value);
  }
});

Deno.test("VAL-BIVC-004 top-level undefined write deletes via storage.delete and never writes", async () => {
  const storage = spyStorage(backing());
  const adapter = createExtendedStorage<unknown>({ storage });

  await adapter.write("key", { exists: true });
  storage.calls.writes.length = 0;
  storage.calls.deletes.length = 0;

  await adapter.write("key", undefined);

  assertEquals(storage.calls.deletes, ["key"]);
  assertEquals(storage.calls.writes.length, 0);
  assertEquals(await rawRead(storage, "key"), undefined);
  assertEquals(await adapter.read("key"), undefined);
});

Deno.test("VAL-BIVC-005 unsupported built-in value codec version on read throws", async () => {
  const storage = backing();
  const adapter = createExtendedStorage({ storage });
  await storage.write("key", validEnvelope({ version: "2.0.0" }));

  await assertRejects(
    async () => {
      await adapter.read("key");
    },
    Error,
    "version",
  );
});

Deno.test("VAL-BIVC-006 built-in decode throws on unparseable JSON payload", async () => {
  const storage = backing();
  const adapter = createExtendedStorage({ storage });
  await storage.write("key", validEnvelope({ payload: "not valid json" }));

  await assertRejects(async () => {
    await adapter.read("key");
  }, SyntaxError);
});

Deno.test("VAL-WRITE-001 single user codec wraps the built-in envelope", async () => {
  const storage = backing();
  let calls = 0;
  let input: StorageEnvelope | undefined;
  const returned = validEnvelope({ codec: "codec-a", payload: "wrapped" });
  const codec: StorageEnvelopeCodec = {
    codec: "codec-a",
    version: "1.0.0",
    encode(envelope) {
      calls++;
      input = envelope;
      return returned;
    },
    decode() {
      return undefined;
    },
  };
  const adapter = createExtendedStorage({ storage, codecs: [codec] });

  await adapter.write("key", { value: 1 });

  assertEquals(calls, 1);
  assertEquals(input?.codec, BUILTIN_VALUE_CODEC);
  assertEquals(await rawRead(storage, "key"), returned);
});

Deno.test("VAL-WRITE-002 multiple codecs apply in declaration order", async () => {
  const storage = backing();
  const seen: string[] = [];
  const adapter = createExtendedStorage({
    storage,
    codecs: [
      jsonWrappingCodec("codec-a", {
        onEncode: (input) => seen.push(input.codec),
      }),
      jsonWrappingCodec("codec-b", {
        onEncode: (input) => seen.push(input.codec),
      }),
      jsonWrappingCodec("codec-c", {
        onEncode: (input) => seen.push(input.codec),
      }),
    ],
  });

  await adapter.write("key", { value: 1 });

  assertEquals(seen, [BUILTIN_VALUE_CODEC, "codec-a", "codec-b"]);
  assertEquals((await rawRead(storage, "key"))?.codec, "codec-c");
});

Deno.test("VAL-WRITE-003 each encode step output is validated before storage mutation", async () => {
  const storage = spyStorage(backing());
  const adapter = createExtendedStorage({
    storage,
    codecs: [{
      codec: "bad-codec",
      version: "1.0.0",
      encode() {
        return {
          kind: "wrong",
          codec: "bad-codec",
          version: "1.0.0",
          payload: "",
        } as unknown as StorageEnvelope;
      },
      decode() {
        return undefined;
      },
    }],
  });

  await assertRejects(
    async () => {
      await adapter.write("key", { value: 1 });
    },
    Error,
    "kind",
  );
  assertEquals(storage.calls.writes.length, 0);
  assertEquals(await rawRead(storage, "key"), undefined);
});

Deno.test("VAL-WRITE-004 async encode is supported sequentially", async () => {
  const storage = backing();
  const order: string[] = [];
  const adapter = createExtendedStorage({
    storage,
    codecs: [
      jsonWrappingCodec("async-a", {
        encodeAsync: true,
        onEncode: () => order.push("a"),
      }),
      jsonWrappingCodec("async-b", {
        encodeAsync: true,
        onEncode: () => order.push("b"),
      }),
    ],
  });

  await adapter.write("key", { value: 1 });

  assertEquals(order, ["a", "b"]);
  assertEquals((await rawRead(storage, "key"))?.codec, "async-b");
});

Deno.test("VAL-WRITE-005 write delegates exactly once to backing storage", async () => {
  const storage = spyStorage(backing());
  const adapter = createExtendedStorage({
    storage,
    codecs: [jsonWrappingCodec("codec-a")],
  });

  await adapter.write("original-key", { value: 1 });

  assertEquals(storage.calls.writes.length, 1);
  assertEquals(storage.calls.writes[0].key, "original-key");
  assertEquals(storage.calls.writes[0].value.codec, "codec-a");
});

Deno.test("VAL-WRITE-006 encode returning undefined throws and does not mutate backing storage", async () => {
  const storage = spyStorage(backing());
  const adapter = createExtendedStorage({
    storage,
    codecs: [{
      codec: "undefined-codec",
      version: "1.0.0",
      encode() {
        return undefined as unknown as StorageEnvelope;
      },
      decode() {
        return undefined;
      },
    }],
  });

  await assertRejects(
    async () => {
      await adapter.write("key", { value: 1 });
    },
    Error,
    "envelope",
  );
  assertEquals(storage.calls.writes.length, 0);
  assertEquals(await rawRead(storage, "key"), undefined);
});

Deno.test("VAL-WRITE-007 validation runs after every encode step in a multi-codec chain", async () => {
  const storage = spyStorage(backing());
  let cCalls = 0;
  const adapter = createExtendedStorage({
    storage,
    codecs: [
      jsonWrappingCodec("codec-a"),
      {
        codec: "codec-b",
        version: "1.0.0",
        encode() {
          return {
            kind: STORAGE_ENVELOPE_KIND,
            codec: "codec-b",
            version: "1.0.0",
          } as StorageEnvelope;
        },
        decode() {
          return undefined;
        },
      },
      {
        ...jsonWrappingCodec("codec-c"),
        encode(envelope) {
          cCalls++;
          return jsonWrappingCodec("codec-c").encode(envelope);
        },
      },
    ],
  });

  await assertRejects(
    async () => {
      await adapter.write("key", { value: 1 });
    },
    Error,
    "payload",
  );
  assertEquals(cCalls, 0);
  assertEquals(storage.calls.writes.length, 0);
});

Deno.test("VAL-WRITE-008 codec mismatch", async () => {
  const storage = spyStorage(backing());
  const adapter = createExtendedStorage({
    storage,
    codecs: [{
      codec: "declared-codec",
      version: "1.0.0",
      encode(envelope) {
        return validEnvelope({
          codec: "wrong-codec",
          version: "1.0.0",
          payload: JSON.stringify(envelope),
        });
      },
      decode() {
        return undefined;
      },
    }],
  });

  await assertRejects(
    async () => {
      await adapter.write("key", { value: 1 });
    },
    Error,
    "declared-codec",
  );
  assertEquals(storage.calls.writes.length, 0);
  assertEquals(await rawRead(storage, "key"), undefined);
});

Deno.test("VAL-WRITE-008 version mismatch", async () => {
  const storage = spyStorage(backing());
  const adapter = createExtendedStorage({
    storage,
    codecs: [{
      codec: "versioned-codec",
      version: "1.0.0",
      encode(envelope) {
        return validEnvelope({
          codec: "versioned-codec",
          version: "2.0.0",
          payload: JSON.stringify(envelope),
        });
      },
      decode() {
        return undefined;
      },
    }],
  });

  await assertRejects(
    async () => {
      await adapter.write("key", { value: 1 });
    },
    Error,
    "versioned-codec",
  );
  assertEquals(storage.calls.writes.length, 0);
  assertEquals(await rawRead(storage, "key"), undefined);
});

Deno.test("VAL-READ-001 returns undefined for missing backing entry without decoding", async () => {
  const storage = backing();
  let decodeCalls = 0;
  const adapter = createExtendedStorage({
    storage,
    codecs: [jsonWrappingCodec("codec-a", { onDecode: () => decodeCalls++ })],
  });

  assertEquals(await adapter.read("missing"), undefined);
  assertEquals(decodeCalls, 0);
});

Deno.test("VAL-READ-002 data-driven dispatch by envelope.codec", async () => {
  const storage = backing();
  let aCalls = 0;
  let bCalls = 0;
  const codecA = jsonWrappingCodec("codec-a", { onDecode: () => aCalls++ });
  const codecB = jsonWrappingCodec("codec-b", { onDecode: () => bCalls++ });
  const adapter = createExtendedStorage({ storage, codecs: [codecA, codecB] });
  await storage.write(
    "key",
    await codecA.encode(validEnvelope({ payload: JSON.stringify("value") })),
  );

  assertEquals(await adapter.read("key"), "value");
  assertEquals(aCalls, 1);
  assertEquals(bCalls, 0);
});

Deno.test("VAL-READ-003 read order is independent of codec declaration order", async () => {
  const storage = backing();
  const codecA = jsonWrappingCodec("codec-a");
  const codecB = jsonWrappingCodec("codec-b");
  const writer = createExtendedStorage({ storage, codecs: [codecA, codecB] });
  const reader = createExtendedStorage({ storage, codecs: [codecB, codecA] });

  await writer.write("key", { value: 1 });

  assertEquals(await reader.read("key"), { value: 1 });
});

Deno.test("VAL-READ-004 unknown codec id throws with the id in the message", async () => {
  const storage = backing();
  const adapter = createExtendedStorage({ storage });
  await storage.write("key", validEnvelope({ codec: "missing-codec" }));

  await assertRejects(
    async () => {
      await adapter.read("key");
    },
    Error,
    "missing-codec",
  );
});

Deno.test("VAL-READ-005 codec decode returning undefined terminates and deletes the key", async () => {
  const storage = spyStorage(backing());
  const adapter = createExtendedStorage({
    storage,
    codecs: [missingCodec("gone-codec")],
  });
  await storage.write(
    "key",
    validEnvelope({ codec: "gone-codec", payload: "" }),
  );
  storage.calls.writes.length = 0;
  storage.calls.deletes.length = 0;

  assertEquals(await adapter.read("key"), undefined);
  assertEquals(storage.calls.deletes, ["key"]);
  assertEquals(await adapter.read("key"), undefined);
});

Deno.test("VAL-READ-006 malformed backing envelope throws", async () => {
  const storage = backing();
  const adapter = createExtendedStorage({ storage });
  await (storage as unknown as StorageAdapter<unknown>).write("key", {
    codec: 42,
  });

  await assertRejects(
    async () => {
      await adapter.read("key");
    },
    Error,
    "envelope",
  );
});

Deno.test("VAL-READ-007 codec returning malformed envelope from decode throws", async () => {
  const storage = backing();
  const adapter = createExtendedStorage({
    storage,
    codecs: [{
      codec: "bad-decode",
      version: "1.0.0",
      encode(envelope) {
        return envelope;
      },
      decode() {
        return {
          kind: STORAGE_ENVELOPE_KIND,
          codec: "",
          version: "1.0.0",
          payload: "",
        } as StorageEnvelope;
      },
    }],
  });
  await storage.write("key", validEnvelope({ codec: "bad-decode" }));

  await assertRejects(
    async () => {
      await adapter.read("key");
    },
    Error,
    "codec",
  );
});

Deno.test("VAL-READ-008 decode-depth guard fires", async () => {
  const storage = backing();
  let calls = 0;
  const selfLoop = validEnvelope({ codec: "loop-codec", payload: "loop" });
  const adapter = createExtendedStorage({
    storage,
    codecs: [{
      codec: "loop-codec",
      version: "1.0.0",
      encode() {
        return selfLoop;
      },
      decode() {
        calls++;
        return selfLoop;
      },
    }],
  });
  await storage.write("key", selfLoop);

  await assertRejects(
    async () => {
      await adapter.read("key");
    },
    Error,
    "depth",
  );
  assert(calls <= MAX_DECODE_DEPTH);
});

Deno.test("VAL-READ-009 async decode is supported", async () => {
  const storage = backing();
  const adapter = createExtendedStorage({
    storage,
    codecs: [jsonWrappingCodec("async-codec", { decodeAsync: true })],
  });

  await adapter.write("key", ["async"]);

  assertEquals(await adapter.read("key"), ["async"]);
});

Deno.test("VAL-READ-010 errors thrown by user codec decode propagate without deleting", async () => {
  const syncStorage = spyStorage(backing());
  const syncError = new Error("sync explode");
  const syncAdapter = createExtendedStorage({
    storage: syncStorage,
    codecs: [{
      codec: "sync-throw",
      version: "1.0.0",
      encode(envelope) {
        return envelope;
      },
      decode() {
        throw syncError;
      },
    }],
  });
  await syncStorage.write("key", validEnvelope({ codec: "sync-throw" }));
  syncStorage.calls.deletes.length = 0;

  await assertRejects(
    async () => {
      await syncAdapter.read("key");
    },
    Error,
    "sync explode",
  );
  assertEquals(syncStorage.calls.deletes.length, 0);

  const asyncStorage = spyStorage(backing());
  const asyncAdapter = createExtendedStorage({
    storage: asyncStorage,
    codecs: [{
      codec: "async-reject",
      version: "1.0.0",
      encode(envelope) {
        return envelope;
      },
      decode() {
        return Promise.reject(new Error("async explode"));
      },
    }],
  });
  await asyncStorage.write("key", validEnvelope({ codec: "async-reject" }));
  asyncStorage.calls.deletes.length = 0;

  await assertRejects(
    async () => {
      await asyncAdapter.read("key");
    },
    Error,
    "async explode",
  );
  assertEquals(asyncStorage.calls.deletes.length, 0);
});

Deno.test("VAL-READ-011 mid-chain decode to undefined triggers single delete", async () => {
  const storage = spyStorage(backing());
  let aCalls = 0;
  let bCalls = 0;
  const codecA: StorageEnvelopeCodec = {
    ...missingCodec("codec-a"),
    decode() {
      aCalls++;
      return undefined;
    },
  };
  const codecB = jsonWrappingCodec("codec-b", { onDecode: () => bCalls++ });
  const adapter = createExtendedStorage({ storage, codecs: [codecA, codecB] });
  const inner = validEnvelope({ codec: "codec-a", payload: "gone" });
  await storage.write("key", await codecB.encode(inner));
  storage.calls.deletes.length = 0;

  assertEquals(await adapter.read("key"), undefined);
  assertEquals(aCalls, 1);
  assertEquals(bCalls, 1);
  assertEquals(storage.calls.deletes, ["key"]);
});

Deno.test("VAL-READ-012 chain of exactly MAX_DECODE_DEPTH user codecs roundtrips successfully", async () => {
  const storage = backing();
  const codecs = Array.from(
    { length: MAX_DECODE_DEPTH },
    (_, index): StorageEnvelopeCodec => {
      const codec = `depth-codec-${index.toString().padStart(3, "0")}`;
      const prefix = `prefix-${index.toString().padStart(3, "0")}:`;

      return {
        codec,
        version: "1.0.0",
        encode(envelope) {
          const codecLength = envelope.codec.length.toString();
          const versionLength = envelope.version.length.toString();
          return validEnvelope({
            codec,
            version: "1.0.0",
            payload:
              `${prefix}${codecLength}:${envelope.codec}${versionLength}:${envelope.version}${envelope.payload}`,
          });
        },
        decode(envelope) {
          assert(envelope.payload.startsWith(prefix));
          let cursor = prefix.length;
          const codecLengthSeparator = envelope.payload.indexOf(":", cursor);
          const codecLength = Number(
            envelope.payload.slice(cursor, codecLengthSeparator),
          );
          const codecStart = codecLengthSeparator + 1;
          const codecEnd = codecStart + codecLength;
          const innerCodec = envelope.payload.slice(codecStart, codecEnd);

          cursor = codecEnd;
          const versionLengthSeparator = envelope.payload.indexOf(":", cursor);
          const versionLength = Number(
            envelope.payload.slice(cursor, versionLengthSeparator),
          );
          const versionStart = versionLengthSeparator + 1;
          const versionEnd = versionStart + versionLength;
          const innerVersion = envelope.payload.slice(versionStart, versionEnd);
          const innerPayload = envelope.payload.slice(versionEnd);

          return validEnvelope({
            codec: innerCodec,
            version: innerVersion,
            payload: innerPayload,
          });
        },
      };
    },
  );
  const adapter = createExtendedStorage({
    storage,
    codecs,
  });
  const value = {
    message: "exact depth boundary",
    nested: { count: MAX_DECODE_DEPTH },
  };

  await adapter.write("key", value);

  assertEquals(await adapter.read("key"), value);
});

Deno.test("VAL-DEL-001 delete delegates directly to backing storage without codecs", async () => {
  const storage = spyStorage(backing());
  let encodeCalls = 0;
  let decodeCalls = 0;
  const adapter = createExtendedStorage({
    storage,
    codecs: [
      jsonWrappingCodec("codec-a", {
        onEncode: () => encodeCalls++,
        onDecode: () => decodeCalls++,
      }),
    ],
  });

  await adapter.delete("key");

  assertEquals(storage.calls.deletes, ["key"]);
  assertEquals(encodeCalls, 0);
  assertEquals(decodeCalls, 0);
});

Deno.test("VAL-ENV-001 rejects non-object values", () => {
  for (const value of [null, "x", 42, true, []]) {
    assertThrows(() => assertValidEnvelope(value), Error, "envelope");
  }
});

Deno.test("VAL-ENV-002 rejects wrong kind", () => {
  assertThrows(
    () =>
      assertValidEnvelope(
        validEnvelope({ kind: "wrong" as StorageEnvelope["kind"] }),
      ),
    Error,
    "kind",
  );
});

Deno.test("VAL-ENV-003 rejects empty or non-string codec", () => {
  for (const codec of [undefined, 42, ""]) {
    assertThrows(
      () => assertValidEnvelope({ ...validEnvelope(), codec }),
      Error,
      "codec",
    );
  }
});

Deno.test("VAL-ENV-004 rejects non-string version", () => {
  for (const version of [undefined, 1]) {
    assertThrows(
      () => assertValidEnvelope({ ...validEnvelope(), version }),
      Error,
      "version",
    );
  }
});

Deno.test("VAL-ENV-005 rejects non-string payload", () => {
  for (const payload of [undefined, 1, null]) {
    assertThrows(
      () => assertValidEnvelope({ ...validEnvelope(), payload }),
      Error,
      "payload",
    );
  }
});

Deno.test("VAL-ENV-006 accepts valid envelopes", () => {
  assertValidEnvelope(validEnvelope());
});

Deno.test("VAL-CROSS-001 full chain roundtrip with real grammY MemorySessionStorage", async () => {
  const storage = backing();
  const adapter = createExtendedStorage({
    storage,
    codecs: [jsonWrappingCodec("base64-like"), jsonWrappingCodec("rot13-like")],
  });
  const values = [{ a: [1, { b: true }] }, ["x", null], "hello", null];

  for (const [index, value] of values.entries()) {
    await adapter.write(`key-${index}`, value);
    assertEquals(await adapter.read(`key-${index}`), value);
  }
});

Deno.test("VAL-CROSS-002 adding an unused codec does not break reads of pre-existing data", async () => {
  const storage = backing();
  const codecA = jsonWrappingCodec("codec-a");
  let bDecodeCalls = 0;
  const codecB = jsonWrappingCodec("codec-b", {
    onDecode: () => bDecodeCalls++,
  });
  const writer = createExtendedStorage({ storage, codecs: [codecA] });
  const reader = createExtendedStorage({ storage, codecs: [codecA, codecB] });

  await writer.write("key", { persisted: true });

  assertEquals(await reader.read("key"), { persisted: true });
  assertEquals(bDecodeCalls, 0);
});

Deno.test("VAL-CROSS-003 read fails informatively when a required codec is missing", async () => {
  const storage = backing();
  const codecA = jsonWrappingCodec("codec-a");
  const codecB = jsonWrappingCodec("codec-b");
  const writer = createExtendedStorage({ storage, codecs: [codecA, codecB] });
  const reader = createExtendedStorage({ storage, codecs: [codecA] });

  await writer.write("key", { persisted: true });

  await assertRejects(
    async () => {
      await reader.read("key");
    },
    Error,
    "codec-b",
  );
});

Deno.test("VAL-CROSS-004 mixed sync and async codecs roundtrip", async () => {
  for (
    const codecs of [
      [
        jsonWrappingCodec("sync-a"),
        jsonWrappingCodec("async-b", { encodeAsync: true, decodeAsync: true }),
      ],
      [
        jsonWrappingCodec("async-a", { encodeAsync: true, decodeAsync: true }),
        jsonWrappingCodec("sync-b"),
      ],
    ]
  ) {
    const storage = backing();
    const adapter = createExtendedStorage({ storage, codecs });

    await adapter.write("key", { mixed: true });

    assertEquals(await adapter.read("key"), { mixed: true });
  }
});
