/**
 * Factory for the extended storage adapter.
 *
 * @module
 */

import type { StorageAdapter } from "grammy";
import type { StorageEnvelope, StorageEnvelopeCodec } from "./types.ts";
import {
  BUILTIN_VALUE_CODEC,
  BUILTIN_VALUE_CODEC_VERSION,
  MAX_DECODE_DEPTH,
  STORAGE_ENVELOPE_KIND,
} from "./constants.ts";
import { assertValidEnvelope } from "./validation.ts";

/**
 * Options accepted by {@link createExtendedStorage}.
 */
export interface ExtendedStorageOptions {
  /** The backing storage that persists {@link StorageEnvelope} values. */
  storage: StorageAdapter<StorageEnvelope>;
  /** Zero or more envelope codecs applied in declaration order on write. */
  codecs?: readonly StorageEnvelopeCodec[];
}

/**
 * Creates a {@link StorageAdapter} that applies a built-in JSON value
 * codec followed by zero or more user-supplied envelope codecs.
 *
 * @typeParam T - The logical value type exposed to consumers.
 */
export function createExtendedStorage<T>(
  options: ExtendedStorageOptions,
): StorageAdapter<T> {
  const { storage } = options;
  const codecs = options.codecs ?? [];

  // Build codec lookup map, checking for duplicate identifiers.
  const codecsById = new Map<string, StorageEnvelopeCodec>();
  for (const codec of codecs) {
    if (codec.codec === BUILTIN_VALUE_CODEC) {
      throw new Error(
        `Codec identifier "${BUILTIN_VALUE_CODEC}" is reserved`,
      );
    }
    if (codecsById.has(codec.codec)) {
      throw new Error(`Duplicate codec identifier: "${codec.codec}"`);
    }
    codecsById.set(codec.codec, codec);
  }

  // --- core operations ---

  async function read(key: string): Promise<T | undefined> {
    let envelope = await storage.read(key);
    if (envelope === undefined) return undefined;

    for (let depth = 0; depth < MAX_DECODE_DEPTH; depth++) {
      assertValidEnvelope(envelope);

      if (envelope.codec === BUILTIN_VALUE_CODEC) {
        if (envelope.version !== BUILTIN_VALUE_CODEC_VERSION) {
          throw new Error("Unsupported built-in value codec version");
        }
        return JSON.parse(envelope.payload) as T;
      }

      const codec = codecsById.get(envelope.codec);
      if (codec === undefined) {
        throw new Error(
          `Unknown storage envelope codec: ${envelope.codec}`,
        );
      }

      const next = await codec.decode(envelope);
      if (next === undefined) return undefined;

      envelope = next;
    }

    throw new Error("Maximum decode depth exceeded");
  }

  async function write(key: string, value: T): Promise<void> {
    let envelope: StorageEnvelope = {
      kind: STORAGE_ENVELOPE_KIND,
      codec: BUILTIN_VALUE_CODEC,
      version: BUILTIN_VALUE_CODEC_VERSION,
      payload: JSON.stringify(value),
    };

    for (const codec of codecs) {
      envelope = await codec.encode(envelope);
      assertValidEnvelope(envelope);
      if (envelope.codec !== codec.codec) {
        throw new Error(
          "Codec encode returned envelope with unexpected codec id",
        );
      }
      if (envelope.version !== codec.version) {
        throw new Error(
          "Codec encode returned envelope with unexpected version",
        );
      }
    }

    await storage.write(key, envelope);
  }

  async function deleteKey(key: string): Promise<void> {
    await storage.delete(key);
  }

  // --- optional bulk operations ---

  async function has(key: string): Promise<boolean> {
    return (await read(key)) !== undefined;
  }

  async function* readAllKeys(): AsyncIterable<string> {
    if (!storage.readAllKeys) return;
    for await (const key of storage.readAllKeys()) {
      if ((await read(key)) !== undefined) {
        yield key;
      }
    }
  }

  async function* readAllValues(): AsyncIterable<T> {
    if (!storage.readAllEntries) return;
    for await (const [, envelope] of storage.readAllEntries()) {
      const value = await decodeEnvelope(envelope);
      if (value !== undefined) {
        yield value;
      }
    }
  }

  async function* readAllEntries(): AsyncIterable<[string, T]> {
    if (!storage.readAllEntries) return;
    for await (const [key, envelope] of storage.readAllEntries()) {
      const value = await decodeEnvelope(envelope);
      if (value !== undefined) {
        yield [key, value];
      }
    }
  }

  /**
   * Decode a single envelope through the full codec chain.
   * Shared by readAllValues and readAllEntries to avoid redundant storage reads.
   */
  async function decodeEnvelope(
    rawEnvelope: StorageEnvelope,
  ): Promise<T | undefined> {
    let envelope: StorageEnvelope | undefined = rawEnvelope;

    for (let depth = 0; depth < MAX_DECODE_DEPTH; depth++) {
      assertValidEnvelope(envelope);

      if (envelope.codec === BUILTIN_VALUE_CODEC) {
        if (envelope.version !== BUILTIN_VALUE_CODEC_VERSION) {
          throw new Error("Unsupported built-in value codec version");
        }
        return JSON.parse(envelope.payload) as T;
      }

      const codec = codecsById.get(envelope.codec);
      if (codec === undefined) {
        throw new Error(
          `Unknown storage envelope codec: ${envelope.codec}`,
        );
      }

      const next = await codec.decode(envelope);
      if (next === undefined) return undefined;

      envelope = next;
    }

    throw new Error("Maximum decode depth exceeded");
  }

  // --- assemble adapter ---

  const adapter: StorageAdapter<T> = { read, write, delete: deleteKey };

  adapter.has = has;

  if (storage.readAllKeys) {
    adapter.readAllKeys = readAllKeys;
  }
  if (storage.readAllEntries) {
    adapter.readAllValues = readAllValues;
    adapter.readAllEntries = readAllEntries;
  }

  return adapter;
}
