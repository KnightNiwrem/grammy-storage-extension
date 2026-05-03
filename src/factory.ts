import type { StorageAdapter } from "grammy";

import { BuiltinValueCodec } from "./builtin-codec.ts";
import { BUILTIN_VALUE_CODEC, MAX_DECODE_DEPTH } from "./constants.ts";
import type { StorageEnvelopeCodec } from "./codec-types.ts";
import { assertValidEnvelope, type StorageEnvelope } from "./envelope.ts";

export type CreateExtendedStorageOptions = {
  storage: StorageAdapter<StorageEnvelope>;
  codecs?: readonly StorageEnvelopeCodec[];
};

type MaybeAsyncIterable<T> = Iterable<T> | AsyncIterable<T>;

type StorageAdapterCapabilities = StorageAdapter<StorageEnvelope> & {
  has?: (key: string) => boolean | Promise<boolean>;
  readAllKeys?: () => MaybeAsyncIterable<string>;
  readAllValues?: () => MaybeAsyncIterable<StorageEnvelope>;
  readAllEntries?: () => MaybeAsyncIterable<[string, StorageEnvelope]>;
};

export function createExtendedStorage<T>(
  options: CreateExtendedStorageOptions,
): StorageAdapter<T> {
  const codecs = options.codecs ?? [];
  const codecsById = new Map<string, StorageEnvelopeCodec>();

  for (const codec of codecs) {
    if (codec.codec === BUILTIN_VALUE_CODEC) {
      throw new Error(`Reserved storage envelope codec id: ${codec.codec}`);
    }
    if (codecsById.has(codec.codec)) {
      throw new Error(`Duplicate storage envelope codec id: ${codec.codec}`);
    }
    codecsById.set(codec.codec, codec);
  }

  const valueCodec = new BuiltinValueCodec<T>();
  const storage = options.storage as StorageAdapterCapabilities;

  async function decodeEnvelope(
    envelope: StorageEnvelope,
    keyToDeleteOnUndefined: string | undefined,
  ): Promise<T | undefined> {
    let current = envelope;
    for (let depth = 0; depth < MAX_DECODE_DEPTH; depth++) {
      assertValidEnvelope(current);

      if (current.codec === valueCodec.codec) {
        return valueCodec.decode(current);
      }

      const codec = codecsById.get(current.codec);
      if (codec === undefined) {
        throw new Error(`Unknown storage envelope codec: ${current.codec}`);
      }

      const next = await codec.decode(current);
      if (next === undefined) {
        if (keyToDeleteOnUndefined !== undefined) {
          await storage.delete(keyToDeleteOnUndefined);
        }
        return undefined;
      }

      current = next;
    }

    throw new Error(
      `Decode depth exceeded MAX_DECODE_DEPTH (${MAX_DECODE_DEPTH})`,
    );
  }

  async function read(key: string): Promise<T | undefined> {
    const envelope = await storage.read(key);
    if (envelope === undefined) {
      return undefined;
    }

    return await decodeEnvelope(envelope, key);
  }

  async function write(key: string, value: T): Promise<void> {
    if (value === undefined) {
      await storage.delete(key);
      return;
    }

    let envelope = valueCodec.encode(value);
    assertValidEnvelope(envelope);

    for (const codec of codecs) {
      envelope = await codec.encode(envelope);
      assertValidEnvelope(envelope);
    }

    await storage.write(key, envelope);
  }

  async function deleteKey(key: string): Promise<void> {
    await storage.delete(key);
  }

  async function* readAllKeysFromKeys(
    keys: MaybeAsyncIterable<string>,
  ): AsyncIterable<string> {
    for await (const key of keys) {
      if ((await read(key)) !== undefined) {
        yield key;
      }
    }
  }

  async function* readAllKeysFromEntries(
    entries: MaybeAsyncIterable<[string, StorageEnvelope]>,
  ): AsyncIterable<string> {
    for await (const [key, envelope] of entries) {
      if ((await decodeEnvelope(envelope, key)) !== undefined) {
        yield key;
      }
    }
  }

  async function* readAllValuesFromValues(
    values: MaybeAsyncIterable<StorageEnvelope>,
  ): AsyncIterable<T> {
    for await (const envelope of values) {
      const value = await decodeEnvelope(envelope, undefined);
      if (value !== undefined) {
        yield value;
      }
    }
  }

  async function* readAllValuesFromEntries(
    entries: MaybeAsyncIterable<[string, StorageEnvelope]>,
  ): AsyncIterable<T> {
    for await (const [key, envelope] of entries) {
      const value = await decodeEnvelope(envelope, key);
      if (value !== undefined) {
        yield value;
      }
    }
  }

  async function* readAllEntriesFromEntries(
    entries: MaybeAsyncIterable<[string, StorageEnvelope]>,
  ): AsyncIterable<[string, T]> {
    for await (const [key, envelope] of entries) {
      const value = await decodeEnvelope(envelope, key);
      if (value !== undefined) {
        yield [key, value];
      }
    }
  }

  async function* readAllEntriesFromKeys(
    keys: MaybeAsyncIterable<string>,
  ): AsyncIterable<[string, T]> {
    for await (const key of keys) {
      const value = await read(key);
      if (value !== undefined) {
        yield [key, value];
      }
    }
  }

  const adapter: StorageAdapter<T> = {
    read,
    write,
    delete: deleteKey,
  };

  if (typeof storage.has === "function") {
    adapter.has = async (key: string): Promise<boolean> =>
      (await read(key)) !== undefined;
  }

  if (typeof storage.readAllKeys === "function") {
    adapter.readAllKeys = (): AsyncIterable<string> =>
      readAllKeysFromKeys(storage.readAllKeys!());
  } else if (typeof storage.readAllEntries === "function") {
    adapter.readAllKeys = (): AsyncIterable<string> =>
      readAllKeysFromEntries(storage.readAllEntries!());
  }

  if (typeof storage.readAllValues === "function") {
    adapter.readAllValues = (): AsyncIterable<T> =>
      readAllValuesFromValues(storage.readAllValues!());
  } else if (typeof storage.readAllEntries === "function") {
    adapter.readAllValues = (): AsyncIterable<T> =>
      readAllValuesFromEntries(storage.readAllEntries!());
  }

  if (typeof storage.readAllEntries === "function") {
    adapter.readAllEntries = (): AsyncIterable<[string, T]> =>
      readAllEntriesFromEntries(storage.readAllEntries!());
  } else if (typeof storage.readAllKeys === "function") {
    adapter.readAllEntries = (): AsyncIterable<[string, T]> =>
      readAllEntriesFromKeys(storage.readAllKeys!());
  }

  return adapter;
}
