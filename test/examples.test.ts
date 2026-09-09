import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import { MemorySessionStorage } from "grammy";

import {
  type CodecRecord,
  createExtendedStorage,
  type SerializedEnvelope,
} from "../src/mod.ts";
import { gzip } from "../examples/gzip.ts";
import { ttl } from "../examples/ttl.ts";

function backing(): MemorySessionStorage<SerializedEnvelope> {
  return new MemorySessionStorage<SerializedEnvelope>();
}

async function rawRead(
  storage: MemorySessionStorage<SerializedEnvelope>,
  key: string,
): Promise<SerializedEnvelope> {
  const envelope = await storage.read(key);
  if (envelope === undefined) {
    throw new Error(`Fixture key "${key}" missing from storage`);
  }
  return envelope;
}

const record = (
  overrides: Partial<CodecRecord> = {},
): CodecRecord => ({
  id: "example:gzip",
  version: "1.0.0",
  meta: {},
  ...overrides,
});

// ---------------------------------------------------------------------------
// examples/gzip.ts
// ---------------------------------------------------------------------------

Deno.test("EX-GZIP-001 roundtrips the body verbatim and stamps meta.rawLength", async () => {
  const storage = backing();
  const adapter = createExtendedStorage<string>({
    storage,
    codecs: [gzip()],
  });
  const messageKey = "message:greeting";
  const message = "hello";

  await adapter.write(messageKey, message);
  assertEquals(await adapter.read(messageKey), message);

  const stored = await rawRead(storage, messageKey);
  assertEquals(stored.codecs.map((r) => r.id), ["example:gzip"]);
  // The JSON text of "hello" is '"hello"': seven UTF-8 bytes with the quotes.
  assertEquals(stored.codecs[0].meta, { rawLength: 7 });
});

Deno.test("EX-GZIP-002 decode throws on an unsupported record version", async () => {
  const codec = gzip();
  const { body } = await codec.encode(new TextEncoder().encode("payload"));

  await assertRejects(
    () => Promise.resolve(codec.decode(body, record({ version: "2.0.0" }))),
    Error,
    "unsupported record version 2.0.0",
  );
});

Deno.test("EX-GZIP-003 decode throws on a tampered meta.rawLength", async () => {
  const codec = gzip();
  const { body } = await codec.encode(new TextEncoder().encode("payload"));

  // Non-numeric rawLength is rejected before the length check.
  await assertRejects(
    () =>
      Promise.resolve(
        codec.decode(body, record({ meta: { rawLength: "7" } })),
      ),
    Error,
    "invalid meta.rawLength",
  );

  // Numeric but wrong length is caught by the decoded-length comparison.
  await assertRejects(
    () =>
      Promise.resolve(
        codec.decode(body, record({ meta: { rawLength: 999 } })),
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
    codecs: [ttl(60_000, "example:ttl", () => 1_000)],
  });
  const key = "chat:1";
  const session: SessionData = { count: 1 };

  await adapter.write(key, session);

  const stored = await rawRead(storage, key);
  assertEquals(stored.codecs[0].meta, { expiresAt: 61_000 });
  // Body is untouched: reading it back yields the original value.
  assertEquals(await adapter.read(key), session);
});

Deno.test("EX-TTL-003 an expired row reads back undefined and is deleted", async () => {
  const storage = backing();
  let now = 1_000;
  const adapter = createExtendedStorage<SessionData>({
    storage,
    codecs: [ttl(100, "example:ttl", () => now)],
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
    codecs: [ttl(100, "example:ttl", () => 1_000)],
  });
  const key = "chat:1";
  await adapter.write(key, { count: 1 });

  // The application value stays well-typed; only the stored envelope metadata
  // is corrupted, simulating a non-finite expiry written by an earlier build.
  const stored = await rawRead(storage, key);
  await storage.write(key, {
    ...stored,
    codecs: [{ ...stored.codecs[0], meta: { expiresAt: "soon" } }],
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
    codecs: [gzip(), ttl(60_000, "example:ttl", () => now)],
  });
  const key = "chat:1";
  const session: SessionData = { count: 1 };

  await adapter.write(key, session);
  assertEquals(await adapter.read(key), session);

  const stored = await rawRead(storage, key);
  assertEquals(stored.encoding, "base64");
  assertEquals(stored.codecs.map((r) => r.id), [
    "example:gzip",
    "example:ttl",
  ]);
  assert(typeof stored.codecs[0].meta.rawLength === "number");
  assertEquals(stored.codecs[1].meta.expiresAt, 61_000);

  now = 61_000; // written at t=1_000, so it expires at 61_000
  assertEquals(await adapter.read(key), undefined);
});
