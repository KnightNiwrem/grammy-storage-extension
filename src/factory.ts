import type { StorageAdapter } from "grammy";

import { BuiltinValueCodec } from "./builtin-codec.ts";
import { BUILTIN_VALUE_CODEC, MAX_DECODE_DEPTH } from "./constants.ts";
import type { StorageEnvelopeCodec } from "./codec-types.ts";
import { assertValidEnvelope, type StorageEnvelope } from "./envelope.ts";

export type CreateExtendedStorageOptions = {
  storage: StorageAdapter<StorageEnvelope>;
  codecs?: readonly StorageEnvelopeCodec[];
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
  const storage = options.storage;

  return {
    async read(key: string): Promise<T | undefined> {
      let envelope = await storage.read(key);
      if (envelope === undefined) {
        return undefined;
      }

      for (let depth = 0; depth < MAX_DECODE_DEPTH; depth++) {
        assertValidEnvelope(envelope);

        if (envelope.codec === valueCodec.codec) {
          return valueCodec.decode(envelope);
        }

        const codec = codecsById.get(envelope.codec);
        if (codec === undefined) {
          throw new Error(`Unknown storage envelope codec: ${envelope.codec}`);
        }

        const next = await codec.decode(envelope);
        if (next === undefined) {
          await storage.delete(key);
          return undefined;
        }

        envelope = next;
      }

      throw new Error(
        `Decode depth exceeded MAX_DECODE_DEPTH (${MAX_DECODE_DEPTH})`,
      );
    },

    async write(key: string, value: T): Promise<void> {
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
    },

    async delete(key: string): Promise<void> {
      await storage.delete(key);
    },
  };
}
