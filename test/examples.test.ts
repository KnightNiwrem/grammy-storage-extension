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

// ---------------------------------------------------------------------------
// examples/gzip.ts
// ---------------------------------------------------------------------------

Deno.test("EX-GZIP-001 roundtrips representative values and stamps meta.rawLength", async () => {
  const storage = backing();
  const adapter = createExtendedStorage<unknown>({
    storage,
    transforms: [gzip()],
  });
  const values = [{ a: [1, { b: true }] }, ["x", null], "hello", null];

  for (const [index, value] of values.entries()) {
    await adapter.write(`key-${index}`, value);
    assertEquals(await adapter.read(`key-${index}`), value);
  }

  const stored = await rawRead(storage, "key-2"); // "hello" -> JSON `"hello"`
  assertEquals(stored.transforms.map((r) => r.kind), ["example:gzip"]);
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

Deno.test("EX-TTL-001 rejects a non-positive duration at construction", () => {
  assertThrows(() => ttl(0), RangeError, "positive duration");
  assertThrows(() => ttl(-1), RangeError, "positive duration");
  assertThrows(() => ttl(Number.NaN), RangeError, "positive duration");
});

Deno.test("EX-TTL-002 stamps meta.expiresAt and is metadata-only", async () => {
  const storage = backing();
  const adapter = createExtendedStorage<unknown>({
    storage,
    transforms: [ttl(60_000, "example:ttl", () => 1_000)],
  });

  await adapter.write("key", { count: 1 });

  const stored = await rawRead(storage, "key");
  assertEquals(stored.transforms[0].meta, { expiresAt: 61_000 });
  // Body is untouched: reading it back yields the original value.
  assertEquals(await adapter.read("key"), { count: 1 });
});

Deno.test("EX-TTL-003 an expired row reads back undefined and is deleted", async () => {
  const storage = backing();
  let now = 1_000;
  const adapter = createExtendedStorage<unknown>({
    storage,
    transforms: [ttl(100, "example:ttl", () => now)],
  });
  await adapter.write("key", { count: 1 });

  assertEquals(await adapter.read("key"), { count: 1 }); // before expiry

  now = 1_100; // expiresAt was 1_100; now >= expiresAt
  assertEquals(await adapter.read("key"), undefined);
  assertEquals(await storage.read("key"), undefined); // row swept from backing
});

Deno.test("EX-TTL-004 isExpired throws on malformed meta.expiresAt", async () => {
  const storage = backing();
  const adapter = createExtendedStorage<unknown>({
    storage,
    transforms: [ttl(100, "example:ttl", () => 1_000)],
  });
  await adapter.write("key", { count: 1 });

  // Rewrite the stored envelope with a non-finite expiry to simulate corruption.
  const stored = await rawRead(storage, "key");
  await storage.write("key", {
    ...stored,
    transforms: [{ ...stored.transforms[0], meta: { expiresAt: "soon" } }],
  });

  await assertRejects(
    async () => {
      await adapter.read("key");
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
  const adapter = createExtendedStorage<unknown>({
    storage,
    transforms: [gzip(), ttl(60_000, "example:ttl", () => now)],
  });
  const values = [{ a: [1, { b: true }] }, ["x", null], "hello", null];

  for (const [index, value] of values.entries()) {
    await adapter.write(`key-${index}`, value);
    assertEquals(await adapter.read(`key-${index}`), value);
  }

  const stored = await rawRead(storage, "key-0");
  assertEquals(stored.encoding, "base64");
  assertEquals(stored.transforms.map((r) => r.kind), [
    "example:gzip",
    "example:ttl",
  ]);
  assert(typeof stored.transforms[0].meta.rawLength === "number");
  assertEquals(stored.transforms[1].meta.expiresAt, 61_000);

  now = 61_000; // everything written at t=1_000 expires at 61_000
  assertEquals(await adapter.read("key-0"), undefined);
});
