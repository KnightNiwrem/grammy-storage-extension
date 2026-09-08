import { assert, assertEquals, assertStrictEquals } from "@std/assert";
import { MemorySessionStorage, type StorageAdapter } from "grammy";

import { createExtendedStorage, type StorageEnvelope } from "../src/mod.ts";
import {
  record,
  type SpyTransform,
  spyTransform,
  validEnvelope,
} from "./helpers.ts";

type FlexibleIterable<T> = Iterable<T> | AsyncIterable<T>;

type FlexibleStorage = StorageAdapter<StorageEnvelope> & {
  read(
    key: string,
  ): StorageEnvelope | undefined | Promise<StorageEnvelope | undefined>;
  write(key: string, value: StorageEnvelope): void | Promise<void>;
  delete(key: string): void | Promise<void>;
  has?: (key: string) => boolean | Promise<boolean>;
  readAllKeys?: () => FlexibleIterable<string>;
  readAllValues?: () => FlexibleIterable<StorageEnvelope>;
  readAllEntries?: () => FlexibleIterable<[string, StorageEnvelope]>;
};

function backing(): FlexibleStorage {
  return new MemorySessionStorage<StorageEnvelope>() as FlexibleStorage;
}

function setMethods(
  storage: FlexibleStorage,
  methods: Partial<FlexibleStorage>,
): FlexibleStorage {
  Object.assign(storage as unknown as Record<string, unknown>, methods);
  return storage;
}

/**
 * The application value the optional-method fixtures store. Two intentionally
 * different live shapes prove the machinery is agnostic to the application
 * value; naming the union lets the writer and every reader share one contract
 * instead of each erasing it to `unknown`.
 */
type FixtureValue = { value: number } | string[];

/** Transforms shared by every fixture: a body-changing one and an expiry one. */
function fixtureTransforms(): { rev: SpyTransform; ttl: SpyTransform } {
  return {
    rev: spyTransform("rev", { reverse: true }),
    ttl: spyTransform("ttl", {
      expired: (r) => r.meta.dead === true,
    }),
  };
}

/**
 * Writes "a" and "b" as live entries and "gone" as an expired entry
 * (its ttl record carries `meta.dead = true`).
 */
async function writeOptionalFixtures(
  storage: FlexibleStorage,
  transforms: { rev: SpyTransform; ttl: SpyTransform },
): Promise<{
  entries: Array<[string, StorageEnvelope]>;
  keys: string[];
  values: StorageEnvelope[];
}> {
  const writer = createExtendedStorage<FixtureValue>({
    storage,
    transforms: [transforms.rev, transforms.ttl],
  });
  await writer.write("a", { value: 1 });
  await storage.write(
    "gone",
    validEnvelope({
      transforms: [record("ttl", { meta: { dead: true } })],
      body: "0",
    }),
  );
  await writer.write("b", ["two"]);

  const entries: Array<[string, StorageEnvelope]> = [];
  for (const key of ["a", "gone", "b"]) {
    const envelope = await storage.read(key);
    if (envelope === undefined) {
      throw new Error(`Fixture key "${key}" missing from storage`);
    }
    entries.push([key, envelope]);
  }

  return {
    entries,
    keys: entries.map(([key]) => key),
    values: entries.map(([, value]) => value),
  };
}

async function collectAsync<T>(iterable: FlexibleIterable<T>): Promise<T[]> {
  const values: T[] = [];
  for await (const value of iterable) {
    values.push(value);
  }
  return values;
}

function readsOf(storage: FlexibleStorage): { count: number } {
  const originalRead = storage.read.bind(storage);
  const calls = { count: 0 };
  storage.read = (key: string) => {
    calls.count++;
    return originalRead(key);
  };
  return calls;
}

// ---------------------------------------------------------------------------
// has
// ---------------------------------------------------------------------------

Deno.test("VAL-OPT-001 has reports live entries without decoding the body", async () => {
  const storage = backing();
  const transforms = fixtureTransforms();
  await writeOptionalFixtures(storage, transforms);
  transforms.rev.calls.decode = 0;
  const adapter = createExtendedStorage<FixtureValue>({
    storage,
    transforms: [transforms.rev, transforms.ttl],
  });

  assertEquals(await adapter.has!("a"), true);
  assertEquals(await adapter.has!("missing"), false);
  assertEquals(transforms.rev.calls.decode, 0);
});

Deno.test("VAL-OPT-002 has reports expired entries as absent and cleans them up", async () => {
  const storage = backing();
  const transforms = fixtureTransforms();
  await writeOptionalFixtures(storage, transforms);
  const adapter = createExtendedStorage<FixtureValue>({
    storage,
    transforms: [transforms.rev, transforms.ttl],
  });

  assertEquals(await adapter.has!("gone"), false);
  assertEquals(await storage.read("gone"), undefined);
  assertEquals(transforms.rev.calls.decode, 0);
});

Deno.test("VAL-OPT-003 has does not forward to the backing has", async () => {
  const storage = backing();
  const transforms = fixtureTransforms();
  await writeOptionalFixtures(storage, transforms);
  let backingHasCalls = 0;
  setMethods(storage, {
    has: () => {
      backingHasCalls++;
      return true;
    },
  });
  const adapter = createExtendedStorage<FixtureValue>({
    storage,
    transforms: [transforms.rev, transforms.ttl],
  });

  assertEquals(await adapter.has!("gone"), false);
  assertEquals(await adapter.has!("missing"), false);
  assertEquals(backingHasCalls, 0);
});

Deno.test("VAL-OPT-004 has is exposed when the backing adapter does not expose has", async () => {
  const storage = backing();
  setMethods(storage, { has: undefined });
  const adapter = createExtendedStorage<number>({ storage });
  await adapter.write("a", 1);

  assertEquals(typeof adapter.has, "function");
  assertEquals(await adapter.has!("a"), true);
});

// ---------------------------------------------------------------------------
// readAllKeys
// ---------------------------------------------------------------------------

Deno.test("VAL-OPT-005 readAllKeys from entries yields live keys without decoding bodies", async () => {
  const storage = backing();
  const transforms = fixtureTransforms();
  const fixtures = await writeOptionalFixtures(storage, transforms);
  setMethods(storage, {
    readAllKeys: undefined,
    readAllValues: undefined,
    readAllEntries: () => fixtures.entries,
  });
  const adapter = createExtendedStorage<FixtureValue>({
    storage,
    transforms: [transforms.rev, transforms.ttl],
  });

  assertEquals(await collectAsync(adapter.readAllKeys!()), ["a", "b"]);
  assertEquals(transforms.rev.calls.decode, 0);
  assertEquals(await storage.read("gone"), undefined);
});

Deno.test("VAL-OPT-006 readAllKeys from keys uses has per key", async () => {
  const storage = backing();
  const transforms = fixtureTransforms();
  const fixtures = await writeOptionalFixtures(storage, transforms);
  setMethods(storage, {
    readAllKeys: () => fixtures.keys,
    readAllValues: undefined,
    readAllEntries: undefined,
  });
  const adapter = createExtendedStorage<FixtureValue>({
    storage,
    transforms: [transforms.rev, transforms.ttl],
  });

  assertEquals(await collectAsync(adapter.readAllKeys!()), ["a", "b"]);
  assertEquals(transforms.rev.calls.decode, 0);
  assertEquals(await storage.read("gone"), undefined);
});

Deno.test("VAL-OPT-007 readAllKeys is omitted without all-key or all-entry capability", () => {
  const storage = setMethods(backing(), {
    readAllKeys: undefined,
    readAllEntries: undefined,
  });
  const adapter = createExtendedStorage({ storage });

  assertStrictEquals(adapter.readAllKeys, undefined);
});

// ---------------------------------------------------------------------------
// readAllValues
// ---------------------------------------------------------------------------

Deno.test("VAL-OPT-008 readAllValues from entries yields decoded live values and cleans up expired keys", async () => {
  const storage = backing();
  const transforms = fixtureTransforms();
  const fixtures = await writeOptionalFixtures(storage, transforms);
  setMethods(storage, {
    readAllKeys: undefined,
    readAllValues: undefined,
    readAllEntries: () => fixtures.entries,
  });
  const adapter = createExtendedStorage<FixtureValue>({
    storage,
    transforms: [transforms.rev, transforms.ttl],
  });

  assertEquals(await collectAsync(adapter.readAllValues!()), [
    { value: 1 },
    ["two"],
  ]);
  assertEquals(await storage.read("gone"), undefined);
});

Deno.test("VAL-OPT-009 readAllValues from values filters expired entries but cannot clean them up", async () => {
  const storage = backing();
  const transforms = fixtureTransforms();
  const fixtures = await writeOptionalFixtures(storage, transforms);
  setMethods(storage, {
    readAllKeys: undefined,
    readAllValues: () => fixtures.values,
    readAllEntries: undefined,
  });
  const adapter = createExtendedStorage<FixtureValue>({
    storage,
    transforms: [transforms.rev, transforms.ttl],
  });

  assertEquals(await collectAsync(adapter.readAllValues!()), [
    { value: 1 },
    ["two"],
  ]);
  assert((await storage.read("gone")) !== undefined);
});

Deno.test("VAL-OPT-010 readAllValues from keys reads each key and cleans up expired keys", async () => {
  const storage = backing();
  const transforms = fixtureTransforms();
  const fixtures = await writeOptionalFixtures(storage, transforms);
  setMethods(storage, {
    readAllKeys: () => fixtures.keys,
    readAllValues: undefined,
    readAllEntries: undefined,
  });
  const adapter = createExtendedStorage<FixtureValue>({
    storage,
    transforms: [transforms.rev, transforms.ttl],
  });
  const reads = readsOf(storage);

  assertEquals(await collectAsync(adapter.readAllValues!()), [
    { value: 1 },
    ["two"],
  ]);
  assertEquals(reads.count, 3);
  assertEquals(await storage.read("gone"), undefined);
});

Deno.test("VAL-OPT-010b readAllValues is omitted without values, entries, or keys", () => {
  const storage = setMethods(backing(), {
    readAllKeys: undefined,
    readAllValues: undefined,
    readAllEntries: undefined,
  });
  const adapter = createExtendedStorage({ storage });

  assertStrictEquals(adapter.readAllValues, undefined);
});

Deno.test("VAL-OPT-010c readAllValues prefers backing readAllValues over keys", async () => {
  const storage = backing();
  const transforms = fixtureTransforms();
  const fixtures = await writeOptionalFixtures(storage, transforms);
  const calls = { keys: 0, values: 0 };
  setMethods(storage, {
    readAllKeys: () => {
      calls.keys++;
      return fixtures.keys;
    },
    readAllValues: () => {
      calls.values++;
      return fixtures.values;
    },
    readAllEntries: undefined,
  });
  const adapter = createExtendedStorage<FixtureValue>({
    storage,
    transforms: [transforms.rev, transforms.ttl],
  });

  await collectAsync(adapter.readAllValues!());

  assertEquals(calls, { keys: 0, values: 1 });
});

// ---------------------------------------------------------------------------
// readAllEntries
// ---------------------------------------------------------------------------

Deno.test("VAL-OPT-011 readAllEntries from entries yields decoded live pairs and cleans up expired keys", async () => {
  const storage = backing();
  const transforms = fixtureTransforms();
  const fixtures = await writeOptionalFixtures(storage, transforms);
  setMethods(storage, {
    readAllKeys: undefined,
    readAllValues: undefined,
    readAllEntries: () => fixtures.entries,
  });
  const adapter = createExtendedStorage<FixtureValue>({
    storage,
    transforms: [transforms.rev, transforms.ttl],
  });

  assertEquals(await collectAsync(adapter.readAllEntries!()), [
    ["a", { value: 1 }],
    ["b", ["two"]],
  ]);
  assertEquals(await storage.read("gone"), undefined);
});

Deno.test("VAL-OPT-012 readAllEntries from keys reads each key", async () => {
  const storage = backing();
  const transforms = fixtureTransforms();
  const fixtures = await writeOptionalFixtures(storage, transforms);
  setMethods(storage, {
    readAllKeys: () => fixtures.keys,
    readAllValues: undefined,
    readAllEntries: undefined,
  });
  const adapter = createExtendedStorage<FixtureValue>({
    storage,
    transforms: [transforms.rev, transforms.ttl],
  });
  const reads = readsOf(storage);

  assertEquals(await collectAsync(adapter.readAllEntries!()), [
    ["a", { value: 1 }],
    ["b", ["two"]],
  ]);
  assertEquals(reads.count, 3);
  assertEquals(await storage.read("gone"), undefined);
});

Deno.test("VAL-OPT-013 readAllEntries is omitted without entries or key-read derivation", () => {
  const storage = setMethods(backing(), {
    readAllKeys: undefined,
    readAllEntries: undefined,
  });
  const adapter = createExtendedStorage({ storage });

  assertStrictEquals(adapter.readAllEntries, undefined);
});

// ---------------------------------------------------------------------------
// Capability selection & iteration semantics
// ---------------------------------------------------------------------------

Deno.test("VAL-OPT-014 bulk methods are async-iterable when backing iterables are synchronous", async () => {
  const storage = backing();
  const transforms = fixtureTransforms();
  const fixtures = await writeOptionalFixtures(storage, transforms);
  setMethods(storage, {
    readAllKeys: () => fixtures.keys,
    readAllValues: () => fixtures.values,
    readAllEntries: () => fixtures.entries,
  });
  const adapter = createExtendedStorage<FixtureValue>({
    storage,
    transforms: [transforms.rev, transforms.ttl],
  });

  for (
    const iterable of [
      adapter.readAllKeys!(),
      adapter.readAllValues!(),
      adapter.readAllEntries!(),
    ]
  ) {
    assert(Symbol.asyncIterator in iterable);
    assert(!(Symbol.iterator in iterable));
  }
  assertEquals(await collectAsync(adapter.readAllKeys!()), ["a", "b"]);
});

Deno.test("VAL-OPT-015 bulk methods prefer readAllEntries when backing exposes all bulk capabilities", async () => {
  const storage = backing();
  const transforms = fixtureTransforms();
  const fixtures = await writeOptionalFixtures(storage, transforms);
  const calls = { keys: 0, values: 0, entries: 0 };
  setMethods(storage, {
    readAllKeys: () => {
      calls.keys++;
      return fixtures.keys;
    },
    readAllValues: () => {
      calls.values++;
      return fixtures.values;
    },
    readAllEntries: () => {
      calls.entries++;
      return fixtures.entries;
    },
  });
  const adapter = createExtendedStorage<FixtureValue>({
    storage,
    transforms: [transforms.rev, transforms.ttl],
  });

  await collectAsync(adapter.readAllKeys!());
  await collectAsync(adapter.readAllValues!());
  await collectAsync(adapter.readAllEntries!());

  assertEquals(calls, { keys: 0, values: 0, entries: 3 });
});

Deno.test("VAL-OPT-016 bulk iteration ignores cleanup delete failures", async () => {
  const storage = backing();
  const transforms = fixtureTransforms();
  const fixtures = await writeOptionalFixtures(storage, transforms);
  setMethods(storage, {
    readAllEntries: () => fixtures.entries,
    delete: () => {
      throw new Error("delete failed");
    },
  });
  const adapter = createExtendedStorage<FixtureValue>({
    storage,
    transforms: [transforms.rev, transforms.ttl],
  });

  assertEquals(await collectAsync(adapter.readAllKeys!()), ["a", "b"]);
  assertEquals(await collectAsync(adapter.readAllEntries!()), [
    ["a", { value: 1 }],
    ["b", ["two"]],
  ]);
});

Deno.test("VAL-OPT-017 bulk iteration is fail-fast on a corrupt entry", async () => {
  const storage = backing();
  const transforms = fixtureTransforms();
  const fixtures = await writeOptionalFixtures(storage, transforms);
  const corrupt = validEnvelope({ transforms: [record("ghost")] });
  setMethods(storage, {
    readAllEntries: () => [fixtures.entries[0], ["bad", corrupt]],
  });
  const adapter = createExtendedStorage<FixtureValue>({
    storage,
    transforms: [transforms.rev, transforms.ttl],
  });

  const seen: string[] = [];
  let failed: unknown;
  try {
    for await (const key of adapter.readAllKeys!()) seen.push(key);
  } catch (error) {
    failed = error;
  }

  assertEquals(seen, ["a"]);
  assert(failed instanceof Error);
  assert(failed.message.includes("ghost"));
});
