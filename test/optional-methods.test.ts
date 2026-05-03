import { assert, assertEquals, assertStrictEquals } from "@std/assert";
import { MemorySessionStorage, type StorageAdapter } from "grammy";

import { createExtendedStorage, type StorageEnvelope } from "../src/mod.ts";
import { missingCodec, validEnvelope } from "./helpers.ts";

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

async function writeOptionalFixtures(
  storage: FlexibleStorage,
): Promise<{
  entries: Array<[string, StorageEnvelope]>;
  keys: string[];
  values: StorageEnvelope[];
}> {
  const writer = createExtendedStorage<unknown>({ storage });
  await writer.write("a", { value: 1 });
  await storage.write("gone", validEnvelope({ codec: "gone-codec" }));
  await writer.write("b", ["two"]);

  const a = await storage.read("a");
  if (a === undefined) {
    throw new Error('Fixture key "a" missing from storage');
  }
  const gone = await storage.read("gone");
  if (gone === undefined) {
    throw new Error('Fixture key "gone" missing from storage');
  }
  const b = await storage.read("b");
  if (b === undefined) {
    throw new Error('Fixture key "b" missing from storage');
  }

  const entries: Array<[string, StorageEnvelope]> = [
    ["a", a],
    ["gone", gone],
    ["b", b],
  ];

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

Deno.test("VAL-OPT-001 has is exposed iff backing has and uses read semantics", async () => {
  const storage = backing();
  const writer = createExtendedStorage<unknown>({ storage });

  await writer.write("present", { ok: true });
  await storage.write("gone", validEnvelope({ codec: "gone-codec" }));
  setMethods(storage, { has: () => false });
  const adapter = createExtendedStorage<unknown>({
    storage,
    codecs: [missingCodec("gone-codec")],
  });

  assert(adapter.has);
  assertEquals(await adapter.has("present"), true);
  assertEquals(await adapter.has("gone"), false);
  assertEquals(await storage.read("gone"), undefined);
});

Deno.test("VAL-OPT-002 has is omitted when backing adapter does not expose has", () => {
  const storage = setMethods(backing(), { has: undefined });
  const adapter = createExtendedStorage<unknown>({ storage });

  assertStrictEquals(adapter.has, undefined);
});

Deno.test("VAL-OPT-003 readAllKeys yields only keys whose decoded value is not undefined", async () => {
  const storage = backing();
  const { keys } = await writeOptionalFixtures(storage);
  setMethods(storage, { readAllKeys: () => keys });
  const adapter = createExtendedStorage<unknown>({
    storage,
    codecs: [missingCodec("gone-codec")],
  });

  assert(adapter.readAllKeys);
  assertEquals(await collectAsync(adapter.readAllKeys()), ["a", "b"]);
});

Deno.test("VAL-OPT-004 readAllKeys is omitted without all-key or all-entry capability", () => {
  const storage = setMethods(backing(), {
    readAllKeys: undefined,
    readAllEntries: undefined,
  });
  const adapter = createExtendedStorage<unknown>({ storage });

  assertStrictEquals(adapter.readAllKeys, undefined);
});

Deno.test("VAL-OPT-005 readAllValues yields only decoded values and filters undefined", async () => {
  const storage = backing();
  const { values } = await writeOptionalFixtures(storage);
  setMethods(storage, { readAllValues: () => values });
  const adapter = createExtendedStorage<unknown>({
    storage,
    codecs: [missingCodec("gone-codec")],
  });

  assert(adapter.readAllValues);
  assertEquals(await collectAsync(adapter.readAllValues()), [
    { value: 1 },
    ["two"],
  ]);
});

Deno.test("VAL-OPT-006 readAllValues is omitted without values or entries", () => {
  const storage = setMethods(backing(), {
    readAllValues: undefined,
    readAllEntries: undefined,
  });
  const adapter = createExtendedStorage<unknown>({ storage });

  assertStrictEquals(adapter.readAllValues, undefined);
});

Deno.test("VAL-OPT-007 readAllEntries yields only decoded entries and filters undefined", async () => {
  const storage = backing();
  const { entries } = await writeOptionalFixtures(storage);
  setMethods(storage, { readAllEntries: () => entries });
  const adapter = createExtendedStorage<unknown>({
    storage,
    codecs: [missingCodec("gone-codec")],
  });

  assert(adapter.readAllEntries);
  assertEquals(await collectAsync(adapter.readAllEntries()), [
    ["a", { value: 1 }],
    ["b", ["two"]],
  ]);
});

Deno.test("VAL-OPT-008 readAllEntries is omitted without entries or key-read derivation", () => {
  const storage = setMethods(backing(), {
    readAllKeys: undefined,
    readAllEntries: undefined,
    readAllValues: () => [],
  });
  const adapter = createExtendedStorage<unknown>({ storage });

  assertStrictEquals(adapter.readAllEntries, undefined);
});

Deno.test("VAL-OPT-009 bulk methods are async-iterable when backing iterables are synchronous", async () => {
  const storage = backing();
  const { entries, keys, values } = await writeOptionalFixtures(storage);
  setMethods(storage, {
    readAllKeys: () => keys,
    readAllValues: () => values,
    readAllEntries: () => entries,
  });
  const adapter = createExtendedStorage<unknown>({
    storage,
    codecs: [missingCodec("gone-codec")],
  });

  assert(adapter.readAllKeys);
  assert(adapter.readAllValues);
  assert(adapter.readAllEntries);

  assertEquals(await collectAsync(adapter.readAllKeys()), ["a", "b"]);
  assertEquals(await collectAsync(adapter.readAllValues()), [
    { value: 1 },
    ["two"],
  ]);
  assertEquals(await collectAsync(adapter.readAllEntries()), [
    ["a", { value: 1 }],
    ["b", ["two"]],
  ]);
});

Deno.test("bulk methods prefer readAllEntries when backing exposes all bulk capabilities", async () => {
  const storage = backing();
  const { entries, keys, values } = await writeOptionalFixtures(storage);
  let readAllKeysCalls = 0;
  let readAllValuesCalls = 0;
  let readAllEntriesCalls = 0;
  setMethods(storage, {
    readAllKeys: () => {
      readAllKeysCalls++;
      return keys;
    },
    readAllValues: () => {
      readAllValuesCalls++;
      return values;
    },
    readAllEntries: () => {
      readAllEntriesCalls++;
      return entries;
    },
  });
  const adapter = createExtendedStorage<unknown>({
    storage,
    codecs: [missingCodec("gone-codec")],
  });

  assert(adapter.readAllKeys);
  assert(adapter.readAllValues);
  assert(adapter.readAllEntries);

  assertEquals(await collectAsync(adapter.readAllKeys()), ["a", "b"]);
  assertEquals(readAllKeysCalls, 0);
  assertEquals(readAllEntriesCalls, 1);

  assertEquals(await collectAsync(adapter.readAllValues()), [
    { value: 1 },
    ["two"],
  ]);
  assertEquals(readAllValuesCalls, 0);
  assertEquals(readAllEntriesCalls, 2);

  assertEquals(await collectAsync(adapter.readAllEntries()), [
    ["a", { value: 1 }],
    ["b", ["two"]],
  ]);
  assertEquals(readAllKeysCalls, 0);
  assertEquals(readAllValuesCalls, 0);
  assertEquals(readAllEntriesCalls, 3);
});

Deno.test("VAL-OPT-010 readAllKeys is exposed when backing has only readAllEntries", async () => {
  const storage = backing();
  const { entries } = await writeOptionalFixtures(storage);
  setMethods(storage, {
    readAllKeys: undefined,
    readAllValues: undefined,
    readAllEntries: () => entries,
  });
  const adapter = createExtendedStorage<unknown>({
    storage,
    codecs: [missingCodec("gone-codec")],
  });

  assert(adapter.readAllKeys);
  assertEquals(await collectAsync(adapter.readAllKeys()), ["a", "b"]);
});

Deno.test("VAL-OPT-011 readAllValues is exposed when backing has only readAllEntries", async () => {
  const storage = backing();
  const { entries } = await writeOptionalFixtures(storage);
  setMethods(storage, {
    readAllKeys: undefined,
    readAllValues: undefined,
    readAllEntries: () => entries,
  });
  const adapter = createExtendedStorage<unknown>({
    storage,
    codecs: [missingCodec("gone-codec")],
  });

  assert(adapter.readAllValues);
  assertEquals(await collectAsync(adapter.readAllValues()), [
    { value: 1 },
    ["two"],
  ]);
});

Deno.test("VAL-OPT-012 readAllEntries is exposed when backing has readAllKeys only", async () => {
  const storage = backing();
  const { keys } = await writeOptionalFixtures(storage);
  setMethods(storage, {
    readAllKeys: () => keys,
    readAllValues: undefined,
    readAllEntries: undefined,
  });
  const adapter = createExtendedStorage<unknown>({
    storage,
    codecs: [missingCodec("gone-codec")],
  });

  assert(adapter.readAllEntries);
  assertEquals(await collectAsync(adapter.readAllEntries()), [
    ["a", { value: 1 }],
    ["b", ["two"]],
  ]);
});
