import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import { MemorySessionStorage } from "grammy";

import {
  createExtendedStorage,
  type StorageEnvelope,
  type StorageTransformRecord,
} from "../src/mod.ts";
import { gzip } from "../examples/gzip.ts";
import { ttl } from "../examples/ttl.ts";

function backing(): MemorySessionStorage<StorageEnvelope> {
  return new MemorySessionStorage<StorageEnvelope>();
}

async function rawRead(
  storage: MemorySessionStorage<StorageEnvelope>,
  key: string,
): Promise<StorageEnvelope> {
  const envelope = await storage.read(key);
  if (envelope === undefined) {
    throw new Error(`Fixture key "${key}" missing from storage`);
  }
  return envelope;
}

const record = (
  overrides: Partial<StorageTransformRecord> = {},
): StorageTransformRecord => ({
  kind: "example:gzip",
  version: "1.0.0",
  meta: {},
  ...overrides,
});

/** A representative session value paired with the key it is stored under. */
type RoundtripCase<T> = {
  readonly name: string;
  readonly key: string;
  readonly value: T;
};

// ---------------------------------------------------------------------------
// examples/gzip.ts
// ---------------------------------------------------------------------------

Deno.test("EX-GZIP-001 roundtrips a representative value of each JSON shape", async () => {
  // gzip roundtrips the body verbatim, so each case declares the concrete
  // application type its adapter stores. A storage value need not be an object.
  const objectCase: RoundtripCase<{ items: [number, { flag: boolean }] }> = {
    name: "nested object",
    key: "profile:nested",
    value: { items: [1, { flag: true }] },
  };
  const arrayCase: RoundtripCase<Array<string | null>> = {
    name: "array with null element",
    key: "tags:mixed",
    value: ["x", null],
  };
  const stringCase: RoundtripCase<string> = {
    name: "plain string",
    key: "message:greeting",
    value: "hello",
  };
  const nullCase: RoundtripCase<null> = {
    name: "null value",
    key: "cleared:slot",
    value: null,
  };

  const objectStorage = backing();
  const objectAdapter = createExtendedStorage<
    { items: [number, { flag: boolean }] }
  >({ storage: objectStorage, transforms: [gzip()] });
  await objectAdapter.write(objectCase.key, objectCase.value);
  assertEquals(await objectAdapter.read(objectCase.key), objectCase.value);

  const arrayStorage = backing();
  const arrayAdapter = createExtendedStorage<Array<string | null>>({
    storage: arrayStorage,
    transforms: [gzip()],
  });
  await arrayAdapter.write(arrayCase.key, arrayCase.value);
  assertEquals(await arrayAdapter.read(arrayCase.key), arrayCase.value);

  const nullStorage = backing();
  const nullAdapter = createExtendedStorage<null>({
    storage: nullStorage,
    transforms: [gzip()],
  });
  await nullAdapter.write(nullCase.key, nullCase.value);
  assertEquals(await nullAdapter.read(nullCase.key), nullCase.value);

  // The string case also verifies the gzip metadata for its own known value,
  // so the assertion references the same key and value used to write it.
  const messageStorage = backing();
  const messageAdapter = createExtendedStorage<string>({
    storage: messageStorage,
    transforms: [gzip()],
  });
  await messageAdapter.write(stringCase.key, stringCase.value);
  assertEquals(await messageAdapter.read(stringCase.key), stringCase.value);

  const stored = await rawRead(messageStorage, stringCase.key);
  assertEquals(stored.transforms.map((r) => r.kind), ["example:gzip"]);
  // The JSON text of "hello" is '"hello"': seven UTF-8 bytes with the quotes.
  assertEquals(stored.transforms[0].meta, { rawLength: 7 });
});

Deno.test("EX-GZIP-002 decode throws on an unsupported record version", async () => {
  const transform = gzip();
  const { body } = await transform.encode(new TextEncoder().encode("payload"));

  await assertRejects(
    () => Promise.resolve(transform.decode(body, record({ version: "2.0.0" }))),
    Error,
    "unsupported record version 2.0.0",
  );
});

Deno.test("EX-GZIP-003 decode throws on a tampered meta.rawLength", async () => {
  const transform = gzip();
  const { body } = await transform.encode(new TextEncoder().encode("payload"));

  // Non-numeric rawLength is rejected before the length check.
  await assertRejects(
    () =>
      Promise.resolve(
        transform.decode(body, record({ meta: { rawLength: "7" } })),
      ),
    Error,
    "invalid meta.rawLength",
  );

  // Numeric but wrong length is caught by the decoded-length comparison.
  await assertRejects(
    () =>
      Promise.resolve(
        transform.decode(body, record({ meta: { rawLength: 999 } })),
      ),
    Error,
    "expected 999",
  );
});

// ---------------------------------------------------------------------------
// examples/ttl.ts
// ---------------------------------------------------------------------------

interface SessionData {
  count: number;
}

Deno.test("EX-TTL-001 rejects a non-positive duration at construction", () => {
  assertThrows(() => ttl(0), RangeError, "positive duration");
  assertThrows(() => ttl(-1), RangeError, "positive duration");
  assertThrows(() => ttl(Number.NaN), RangeError, "positive duration");
});

Deno.test("EX-TTL-002 stamps meta.expiresAt and is metadata-only", async () => {
  const storage = backing();
  const adapter = createExtendedStorage<SessionData>({
    storage,
    transforms: [ttl(60_000, "example:ttl", () => 1_000)],
  });
  const key = "chat:1";
  const session: SessionData = { count: 1 };

  await adapter.write(key, session);

  const stored = await rawRead(storage, key);
  assertEquals(stored.transforms[0].meta, { expiresAt: 61_000 });
  // Body is untouched: reading it back yields the original value.
  assertEquals(await adapter.read(key), session);
});

Deno.test("EX-TTL-003 an expired row reads back undefined and is deleted", async () => {
  const storage = backing();
  let now = 1_000;
  const adapter = createExtendedStorage<SessionData>({
    storage,
    transforms: [ttl(100, "example:ttl", () => now)],
  });
  const key = "chat:1";
  const session: SessionData = { count: 1 };
  await adapter.write(key, session);

  assertEquals(await adapter.read(key), session); // before expiry

  now = 1_100; // expiresAt was 1_100; now >= expiresAt
  assertEquals(await adapter.read(key), undefined);
  assertEquals(await storage.read(key), undefined); // row swept from backing
});

Deno.test("EX-TTL-004 isExpired throws on malformed meta.expiresAt", async () => {
  const storage = backing();
  const adapter = createExtendedStorage<SessionData>({
    storage,
    transforms: [ttl(100, "example:ttl", () => 1_000)],
  });
  const key = "chat:1";
  await adapter.write(key, { count: 1 });

  // The application value stays well-typed; only the stored envelope metadata
  // is corrupted, simulating a non-finite expiry written by an earlier build.
  const stored = await rawRead(storage, key);
  await storage.write(key, {
    ...stored,
    transforms: [{ ...stored.transforms[0], meta: { expiresAt: "soon" } }],
  });

  await assertRejects(
    async () => {
      await adapter.read(key);
    },
    Error,
    "invalid meta.expiresAt",
  );
});

// ---------------------------------------------------------------------------
// gzip + ttl chained
// ---------------------------------------------------------------------------

Deno.test("EX-CHAIN-001 gzip + ttl roundtrip on real grammY MemorySessionStorage", async () => {
  const storage = backing();
  let now = 1_000;
  const adapter = createExtendedStorage<SessionData>({
    storage,
    transforms: [gzip(), ttl(60_000, "example:ttl", () => now)],
  });
  const key = "chat:1";
  const session: SessionData = { count: 1 };

  await adapter.write(key, session);
  assertEquals(await adapter.read(key), session);

  const stored = await rawRead(storage, key);
  assertEquals(stored.encoding, "base64");
  assertEquals(stored.transforms.map((r) => r.kind), [
    "example:gzip",
    "example:ttl",
  ]);
  assert(typeof stored.transforms[0].meta.rawLength === "number");
  assertEquals(stored.transforms[1].meta.expiresAt, 61_000);

  now = 61_000; // written at t=1_000, so it expires at 61_000
  assertEquals(await adapter.read(key), undefined);
});
