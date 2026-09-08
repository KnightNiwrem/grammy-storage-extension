import type { StorageAdapter } from "grammy";

import {
  bytesToText,
  decodeBody,
  deserializeValue,
  encodeBody,
  serializeValue,
  textToBytes,
} from "./body.ts";
import {
  RESERVED_TRANSFORM_KIND_PREFIX,
  STORAGE_ENVELOPE_KIND,
} from "./constants.ts";
import {
  assertValidEnvelope,
  isPlainObject,
  type StorageEnvelope,
  type StorageTransformRecord,
} from "./envelope.ts";
import {
  EXTENDED_STORAGE_ERROR_CODES,
  ExtendedStorageError,
} from "./errors.ts";
import type {
  StorageReadOnlyTransform,
  StorageTransform,
} from "./transform.ts";
import { PACKAGE_VERSION } from "./version.ts";

export type CreateExtendedStorageOptions = {
  /** The physical database adapter that reads and writes envelopes. */
  storage: StorageAdapter<StorageEnvelope>;
  /** Optional ordered list of body transforms applied on write. */
  transforms?: readonly StorageTransform[];
  /**
   * Transforms registered only for reading; never applied on write. Use this
   * to keep reading rows produced by a transform you have stopped using.
   */
  readOnlyTransforms?: readonly StorageReadOnlyTransform[];
};

type MaybeAsyncIterable<T> = Iterable<T> | AsyncIterable<T>;

type ResolvedStep = {
  readonly record: StorageTransformRecord;
  readonly transform: StorageReadOnlyTransform;
};

export function createExtendedStorage<T>(
  options: CreateExtendedStorageOptions,
): StorageAdapter<T> {
  const installed = installTransforms(
    options.transforms,
    options.readOnlyTransforms,
  );
  const storage = options.storage;

  async function cleanup(key: string | undefined): Promise<void> {
    if (key === undefined) return;
    try {
      await storage.delete(key);
    } catch {
      // Best-effort cleanup: the entry was already determined to be
      // logically absent, so a failed delete must not propagate.
    }
  }

  /**
   * Validates the envelope, resolves every recorded transform, and runs the
   * expiry pass. Returns `undefined` when the entry is expired (after
   * best-effort cleanup), otherwise the resolved chain for the body pass.
   */
  async function inspectEnvelope(
    envelope: unknown,
    key: string | undefined,
  ): Promise<readonly ResolvedStep[] | undefined> {
    assertValidEnvelope(envelope);

    const chain: ResolvedStep[] = envelope.transforms.map((record) => {
      const transform = installed.byKind.get(record.kind);
      if (transform === undefined) {
        throw new ExtendedStorageError(
          EXTENDED_STORAGE_ERROR_CODES.UNKNOWN_TRANSFORM,
          `Unknown storage transform kind: ${record.kind}`,
        );
      }
      return { record, transform };
    });

    for (const { record, transform } of chain) {
      if (transform.isExpired === undefined) continue;
      if (await transform.isExpired(record)) {
        await cleanup(key);
        return undefined;
      }
    }

    return chain;
  }

  async function decodeChain(
    envelope: StorageEnvelope,
    chain: readonly ResolvedStep[],
  ): Promise<T> {
    let bytes = decodeBody(envelope.body, envelope.encoding);

    for (let i = chain.length - 1; i >= 0; i--) {
      const { record, transform } = chain[i];
      const next: unknown = await transform.decode(bytes, record);
      if (!(next instanceof Uint8Array)) {
        throw new ExtendedStorageError(
          EXTENDED_STORAGE_ERROR_CODES.INVALID_TRANSFORM_OUTPUT,
          `Storage transform "${record.kind}" decode must return a Uint8Array`,
        );
      }
      bytes = next;
    }

    return deserializeValue<T>(bytesToText(bytes));
  }

  async function decodeEnvelope(
    envelope: unknown,
    key: string | undefined,
  ): Promise<T | undefined> {
    const chain = await inspectEnvelope(envelope, key);
    if (chain === undefined) return undefined;
    return await decodeChain(envelope as StorageEnvelope, chain);
  }

  async function read(key: string): Promise<T | undefined> {
    const envelope = await storage.read(key);
    if (envelope === undefined) return undefined;
    return await decodeEnvelope(envelope, key);
  }

  async function write(key: string, value: T): Promise<void> {
    if (value === undefined) {
      await storage.delete(key);
      return;
    }

    const text = serializeValue(value);

    if (installed.ordered.length === 0) {
      await storage.write(key, {
        kind: STORAGE_ENVELOPE_KIND,
        version: PACKAGE_VERSION,
        transforms: [],
        encoding: "utf8",
        body: text,
      });
      return;
    }

    let bytes = textToBytes(text);
    const records: StorageTransformRecord[] = [];

    for (const transform of installed.ordered) {
      const output: unknown = await transform.encode(bytes);
      if (!isPlainObject(output) || !(output.body instanceof Uint8Array)) {
        throw new ExtendedStorageError(
          EXTENDED_STORAGE_ERROR_CODES.INVALID_TRANSFORM_OUTPUT,
          `Storage transform "${transform.kind}" encode must return { body: Uint8Array, meta? }`,
        );
      }
      if (output.meta !== undefined && !isPlainObject(output.meta)) {
        throw new ExtendedStorageError(
          EXTENDED_STORAGE_ERROR_CODES.INVALID_TRANSFORM_OUTPUT,
          `Storage transform "${transform.kind}" encode meta must be a plain object`,
        );
      }
      records.push({
        kind: transform.kind,
        version: transform.version,
        meta: output.meta ?? {},
      });
      bytes = output.body;
    }

    await storage.write(key, {
      kind: STORAGE_ENVELOPE_KIND,
      version: PACKAGE_VERSION,
      transforms: records,
      encoding: "base64",
      body: encodeBody(bytes),
    });
  }

  async function deleteKey(key: string): Promise<void> {
    await storage.delete(key);
  }

  async function has(key: string): Promise<boolean> {
    const envelope = await storage.read(key);
    if (envelope === undefined) return false;
    return (await inspectEnvelope(envelope, key)) !== undefined;
  }

  async function* readAllKeysFromKeys(
    keys: MaybeAsyncIterable<string>,
  ): AsyncIterable<string> {
    for await (const key of keys) {
      if (await has(key)) yield key;
    }
  }

  async function* readAllKeysFromEntries(
    entries: MaybeAsyncIterable<[string, StorageEnvelope]>,
  ): AsyncIterable<string> {
    for await (const [key, envelope] of entries) {
      if ((await inspectEnvelope(envelope, key)) !== undefined) yield key;
    }
  }

  async function* readAllValuesFromValues(
    values: MaybeAsyncIterable<StorageEnvelope>,
  ): AsyncIterable<T> {
    for await (const envelope of values) {
      const value = await decodeEnvelope(envelope, undefined);
      if (value !== undefined) yield value;
    }
  }

  async function* readAllValuesFromEntries(
    entries: MaybeAsyncIterable<[string, StorageEnvelope]>,
  ): AsyncIterable<T> {
    for await (const [key, envelope] of entries) {
      const value = await decodeEnvelope(envelope, key);
      if (value !== undefined) yield value;
    }
  }

  async function* readAllValuesFromKeys(
    keys: MaybeAsyncIterable<string>,
  ): AsyncIterable<T> {
    for await (const [, value] of readAllEntriesFromKeys(keys)) {
      yield value;
    }
  }

  async function* readAllEntriesFromEntries(
    entries: MaybeAsyncIterable<[string, StorageEnvelope]>,
  ): AsyncIterable<[string, T]> {
    for await (const [key, envelope] of entries) {
      const value = await decodeEnvelope(envelope, key);
      if (value !== undefined) yield [key, value];
    }
  }

  async function* readAllEntriesFromKeys(
    keys: MaybeAsyncIterable<string>,
  ): AsyncIterable<[string, T]> {
    for await (const key of keys) {
      const value = await read(key);
      if (value !== undefined) yield [key, value];
    }
  }

  const adapter: StorageAdapter<T> = {
    read,
    write,
    delete: deleteKey,
  };

  adapter.has = has;

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
  } else if (typeof storage.readAllKeys === "function") {
    adapter.readAllValues = (): AsyncIterable<T> =>
      readAllValuesFromKeys(storage.readAllKeys!());
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

function installTransforms(
  transforms: readonly StorageTransform[] = [],
  readOnlyTransforms: readonly StorageReadOnlyTransform[] = [],
): {
  readonly ordered: readonly StorageTransform[];
  readonly byKind: ReadonlyMap<string, StorageReadOnlyTransform>;
} {
  const byKind = new Map<string, StorageReadOnlyTransform>();

  for (const transform of [...transforms, ...readOnlyTransforms]) {
    const kind = transform.kind;

    if (kind.length === 0) {
      throw new ExtendedStorageError(
        EXTENDED_STORAGE_ERROR_CODES.EMPTY_TRANSFORM_KIND,
        "Storage transform kind must be non-empty",
      );
    }

    if (kind.startsWith(RESERVED_TRANSFORM_KIND_PREFIX)) {
      throw new ExtendedStorageError(
        EXTENDED_STORAGE_ERROR_CODES.RESERVED_TRANSFORM_KIND,
        `Reserved storage transform kind: ${kind}`,
      );
    }

    if (byKind.has(kind)) {
      throw new ExtendedStorageError(
        EXTENDED_STORAGE_ERROR_CODES.DUPLICATE_TRANSFORM_KIND,
        `Duplicate storage transform kind: ${kind}`,
      );
    }

    byKind.set(kind, transform);
  }

  return { ordered: [...transforms], byKind };
}
