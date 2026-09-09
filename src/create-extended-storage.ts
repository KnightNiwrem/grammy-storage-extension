import type { StorageAdapter } from "grammy";

import {
  bytesToText,
  deserializeValue,
  serializeValue,
  textToBytes,
} from "./body.ts";
import { ENVELOPE_DISCRIMINATOR } from "./constants.ts";
import {
  assertValidSerializedEnvelope,
  type CodecRecord,
  deserializeEnvelope,
  type Envelope,
  isPlainObject,
  type SerializedEnvelope,
  serializeEnvelope,
} from "./envelope.ts";
import {
  EXTENDED_STORAGE_ERROR_CODES,
  ExtendedStorageError,
} from "./errors.ts";
import type { BodyCodec, BodyDecoder } from "./codec.ts";
import { PACKAGE_VERSION } from "./version.ts";

export type CreateExtendedStorageOptions = {
  /** The physical database adapter that reads and writes envelopes. */
  storage: StorageAdapter<SerializedEnvelope>;
  /** Optional ordered list of body codecs applied on write. */
  codecs?: readonly BodyCodec[];
  /**
   * Codecs registered only for reading; never applied on write. Use this to
   * keep reading rows produced by a codec you have stopped using.
   */
  decoders?: readonly BodyDecoder[];
};

type MaybeAsyncIterable<T> = Iterable<T> | AsyncIterable<T>;

type ResolvedStep = {
  readonly record: CodecRecord;
  readonly codec: BodyDecoder;
};

export function createExtendedStorage<T>(
  options: CreateExtendedStorageOptions,
): StorageAdapter<T> {
  const installed = installCodecs(options.codecs, options.decoders);
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
   * Validates the envelope, resolves every recorded codec, and runs the
   * expiry pass. Returns `undefined` when the entry is expired (after
   * best-effort cleanup), otherwise the resolved chain for the body pass.
   */
  async function inspectEnvelope(
    envelope: unknown,
    key: string | undefined,
  ): Promise<readonly ResolvedStep[] | undefined> {
    assertValidSerializedEnvelope(envelope);

    const chain: ResolvedStep[] = envelope.codecs.map((record) => {
      const codec = installed.byId.get(record.id);
      if (codec === undefined) {
        throw new ExtendedStorageError(
          EXTENDED_STORAGE_ERROR_CODES.UNKNOWN_CODEC,
          `Unknown storage codec id: ${record.id}`,
        );
      }
      return { record, codec };
    });

    for (const { record, codec } of chain) {
      if (codec.isExpired === undefined) continue;
      if (await codec.isExpired(record)) {
        await cleanup(key);
        return undefined;
      }
    }

    return chain;
  }

  async function decodeChain(
    serialized: SerializedEnvelope,
    chain: readonly ResolvedStep[],
  ): Promise<T> {
    // The body pass has begun: reconstruct the internal working envelope
    // (spec §10) and advance its body through the reverse decode chain.
    let envelope = deserializeEnvelope(serialized);

    for (let i = chain.length - 1; i >= 0; i--) {
      const { record, codec } = chain[i];
      const next: unknown = await codec.decode(envelope.body, record);
      if (!(next instanceof Uint8Array)) {
        throw new ExtendedStorageError(
          EXTENDED_STORAGE_ERROR_CODES.INVALID_CODEC_OUTPUT,
          `Storage codec "${record.id}" decode must return a Uint8Array`,
        );
      }
      envelope = { ...envelope, body: next };
    }

    return deserializeValue<T>(bytesToText(envelope.body));
  }

  async function decodeEnvelope(
    envelope: unknown,
    key: string | undefined,
  ): Promise<T | undefined> {
    const chain = await inspectEnvelope(envelope, key);
    if (chain === undefined) return undefined;
    return await decodeChain(envelope as SerializedEnvelope, chain);
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
        discriminator: ENVELOPE_DISCRIMINATOR,
        version: PACKAGE_VERSION,
        codecs: [],
        encoding: "utf8",
        body: text,
      });
      return;
    }

    // Assemble the internal working envelope, then advance it one codec at a
    // time: the adapter owns each Envelope -> Envelope transition (spec §1, §9),
    // replacing the body with the codec's output and appending its record.
    let envelope: Envelope = {
      discriminator: ENVELOPE_DISCRIMINATOR,
      version: PACKAGE_VERSION,
      codecs: [],
      body: textToBytes(text),
    };

    for (const codec of installed.ordered) {
      const output: unknown = await codec.encode(envelope.body);
      if (!isPlainObject(output) || !(output.body instanceof Uint8Array)) {
        throw new ExtendedStorageError(
          EXTENDED_STORAGE_ERROR_CODES.INVALID_CODEC_OUTPUT,
          `Storage codec "${codec.id}" encode must return { body: Uint8Array, meta? }`,
        );
      }
      if (output.meta !== undefined && !isPlainObject(output.meta)) {
        throw new ExtendedStorageError(
          EXTENDED_STORAGE_ERROR_CODES.INVALID_CODEC_OUTPUT,
          `Storage codec "${codec.id}" encode meta must be a plain object`,
        );
      }
      const record: CodecRecord = {
        id: codec.id,
        version: codec.version,
        meta: output.meta ?? {},
      };
      envelope = {
        ...envelope,
        codecs: [...envelope.codecs, record],
        body: output.body,
      };
    }

    await storage.write(key, serializeEnvelope(envelope, "base64"));
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
    entries: MaybeAsyncIterable<[string, SerializedEnvelope]>,
  ): AsyncIterable<string> {
    for await (const [key, envelope] of entries) {
      if ((await inspectEnvelope(envelope, key)) !== undefined) yield key;
    }
  }

  async function* readAllValuesFromValues(
    values: MaybeAsyncIterable<SerializedEnvelope>,
  ): AsyncIterable<T> {
    for await (const envelope of values) {
      const value = await decodeEnvelope(envelope, undefined);
      if (value !== undefined) yield value;
    }
  }

  async function* readAllValuesFromEntries(
    entries: MaybeAsyncIterable<[string, SerializedEnvelope]>,
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
    entries: MaybeAsyncIterable<[string, SerializedEnvelope]>,
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

function installCodecs(
  codecs: readonly BodyCodec[] = [],
  decoders: readonly BodyDecoder[] = [],
): {
  readonly ordered: readonly BodyCodec[];
  readonly byId: ReadonlyMap<string, BodyDecoder>;
} {
  const byId = new Map<string, BodyDecoder>();

  for (const codec of [...codecs, ...decoders]) {
    const id: unknown = codec.id;

    if (typeof id !== "string" || id.length === 0) {
      throw new ExtendedStorageError(
        EXTENDED_STORAGE_ERROR_CODES.INVALID_CODEC_ID,
        "Storage codec id must be a non-empty string",
      );
    }

    if (byId.has(id)) {
      throw new ExtendedStorageError(
        EXTENDED_STORAGE_ERROR_CODES.DUPLICATE_CODEC_ID,
        `Duplicate storage codec id: ${id}`,
      );
    }

    byId.set(id, codec);
  }

  return { ordered: [...codecs], byId };
}
