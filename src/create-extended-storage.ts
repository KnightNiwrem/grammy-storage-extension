import type { StorageAdapter } from "grammy";

import { JsonValueCodec } from "./json-value-codec.ts";
import { MAX_DECODE_DEPTH, VALUE_CODEC_ID } from "./constants.ts";
import type { StorageEnvelopeCodec } from "./codec.ts";
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

type InstalledEnvelopeCodec = {
  readonly id: string;
  readonly version: string;
  readonly impl: StorageEnvelopeCodec;
};

export function createExtendedStorage<T>(
  options: CreateExtendedStorageOptions,
): StorageAdapter<T> {
  const installed = installCodecs(options.codecs);
  const valueCodec = new JsonValueCodec<T>();
  const storage = options.storage as StorageAdapterCapabilities;

  async function decodeEnvelope(
    envelope: StorageEnvelope,
    keyToDeleteOnUndefined: string | undefined,
  ): Promise<T | undefined> {
    let current = envelope;
    let userDecodeCount = 0;

    for (;;) {
      assertValidEnvelope(current);

      if (current.codec === valueCodec.codec) {
        return valueCodec.decode(current);
      }

      if (userDecodeCount >= MAX_DECODE_DEPTH) {
        throw new Error(
          `Decode depth exceeded MAX_DECODE_DEPTH (${MAX_DECODE_DEPTH})`,
        );
      }

      const codec = installed.byId.get(current.codec);
      if (codec === undefined) {
        throw new Error(`Unknown storage envelope codec: ${current.codec}`);
      }

      const next = await codec.impl.decode(current);
      userDecodeCount++;
      if (next === undefined) {
        if (keyToDeleteOnUndefined !== undefined) {
          await storage.delete(keyToDeleteOnUndefined);
        }
        return undefined;
      }

      current = next;
    }
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

    for (const codec of installed.ordered) {
      envelope = await codec.impl.encode(envelope);
      assertValidEnvelope(envelope);
      assertEncodeOutputIdentity(codec, envelope);
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

  adapter.has = async (key: string): Promise<boolean> =>
    (await read(key)) !== undefined;

  if (typeof storage.readAllEntries === "function") {
    adapter.readAllKeys = (): AsyncIterable<string> =>
      readAllKeysFromEntries(storage.readAllEntries!());
  } else if (typeof storage.readAllKeys === "function") {
    adapter.readAllKeys = (): AsyncIterable<string> =>
      readAllKeysFromKeys(storage.readAllKeys!());
  }

  if (typeof storage.readAllEntries === "function") {
    adapter.readAllValues = (): AsyncIterable<T> =>
      readAllValuesFromEntries(storage.readAllEntries!());
  } else if (typeof storage.readAllValues === "function") {
    adapter.readAllValues = (): AsyncIterable<T> =>
      readAllValuesFromValues(storage.readAllValues!());
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

function installCodecs(
  codecs: readonly StorageEnvelopeCodec[] = [],
): {
  readonly ordered: readonly InstalledEnvelopeCodec[];
  readonly byId: ReadonlyMap<string, InstalledEnvelopeCodec>;
} {
  const ordered: InstalledEnvelopeCodec[] = [];
  const byId = new Map<string, InstalledEnvelopeCodec>();

  for (const impl of codecs) {
    const id = impl.codec;

    if (id.length === 0) {
      throw new Error("Storage envelope codec id must be non-empty");
    }

    if (id === VALUE_CODEC_ID || id.startsWith("grammy-extended-storage-")) {
      throw new Error(`Reserved storage envelope codec id: ${id}`);
    }

    if (byId.has(id)) {
      throw new Error(`Duplicate storage envelope codec id: ${id}`);
    }

    const installed: InstalledEnvelopeCodec = {
      id,
      version: impl.version,
      impl,
    };

    ordered.push(installed);
    byId.set(id, installed);
  }

  return { ordered, byId };
}

function assertEncodeOutputIdentity(
  codec: InstalledEnvelopeCodec,
  envelope: StorageEnvelope,
): void {
  const mismatchedFields: string[] = [];
  if (envelope.codec !== codec.id) {
    mismatchedFields.push("codec");
  }
  if (envelope.version !== codec.version) {
    mismatchedFields.push("version");
  }

  if (mismatchedFields.length > 0) {
    throw new Error(
      `Storage envelope codec "${codec.id}" encode output mismatched ${
        mismatchedFields.join(" and ")
      }`,
    );
  }
}
