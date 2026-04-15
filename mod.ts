export const STORAGE_ENVELOPE_KIND = "grammy-extended-storage-envelope";
export const BUILTIN_VALUE_CODEC = "grammy-extended-storage-value";
export const BUILTIN_VALUE_CODEC_VERSION = 1;
export const MAX_DECODE_DEPTH = 100;

export type MaybePromise<T> = T | Promise<T>;

export type StorageEnvelope = {
  kind: typeof STORAGE_ENVELOPE_KIND;
  codec: string;
  version: number;
  payload: string;
};

export interface StorageEnvelopeCodec {
  readonly codec: string;
  readonly version: number;
  encode(envelope: StorageEnvelope): MaybePromise<StorageEnvelope>;
  decode(
    envelope: StorageEnvelope,
  ): MaybePromise<StorageEnvelope | undefined>;
}

export interface StorageValueCodec<T> {
  readonly codec: string;
  readonly version: number;
  encode(value: T): MaybePromise<StorageEnvelope>;
  decode(envelope: StorageEnvelope): MaybePromise<T | undefined>;
}

export interface StorageAdapter<T> {
  read(key: string): MaybePromise<T | undefined>;
  write(key: string, value: T): MaybePromise<void>;
  delete(key: string): MaybePromise<void>;
  has?(key: string): MaybePromise<boolean>;
  readAllKeys?(): Iterable<string> | AsyncIterable<string>;
  readAllValues?(): Iterable<T> | AsyncIterable<T>;
  readAllEntries?(): Iterable<[string, T]> | AsyncIterable<[string, T]>;
}

type BulkReadableStorageAdapter<T> = StorageAdapter<T> & {
  readAllKeys?: () => Iterable<string> | AsyncIterable<string>;
  readAllValues?: () => Iterable<T> | AsyncIterable<T>;
  readAllEntries?: () => Iterable<[string, T]> | AsyncIterable<[string, T]>;
};

type KeyIteratorFactory = () => Iterable<string> | AsyncIterable<string>;
type EntryIteratorFactory<T> = () =>
  | Iterable<[string, T]>
  | AsyncIterable<[string, T]>;

const builtInValueCodec: StorageValueCodec<unknown> = {
  codec: BUILTIN_VALUE_CODEC,
  version: BUILTIN_VALUE_CODEC_VERSION,
  encode(value) {
    const payload = JSON.stringify(value);
    if (payload === undefined) {
      throw new Error(
        "Built-in value codec does not support top-level undefined",
      );
    }

    return {
      kind: STORAGE_ENVELOPE_KIND,
      codec: BUILTIN_VALUE_CODEC,
      version: BUILTIN_VALUE_CODEC_VERSION,
      payload,
    };
  },
  decode(envelope) {
    return JSON.parse(envelope.payload);
  },
};

export function assertValidEnvelope(
  value: unknown,
): asserts value is StorageEnvelope {
  if (typeof value !== "object" || value === null) {
    throw new Error("Invalid envelope");
  }

  const envelope = value as Record<string, unknown>;
  if (envelope.kind !== STORAGE_ENVELOPE_KIND) {
    throw new Error("Invalid envelope kind");
  }
  if (typeof envelope.codec !== "string" || envelope.codec.length === 0) {
    throw new Error("Invalid envelope codec");
  }
  if (
    !Number.isInteger(envelope.version) ||
    (envelope.version as number) < 0
  ) {
    throw new Error("Invalid envelope version");
  }
  if (typeof envelope.payload !== "string") {
    throw new Error("Invalid envelope payload");
  }
}

export function createExtendedStorage<T>(options: {
  storage: StorageAdapter<StorageEnvelope>;
  codecs?: readonly StorageEnvelopeCodec[];
}): StorageAdapter<T> {
  const codecs = options.codecs ?? [];
  const codecsById = new Map<string, StorageEnvelopeCodec>();

  for (const codec of codecs) {
    if (codec.codec === BUILTIN_VALUE_CODEC) {
      throw new Error(
        `Codec identifier is reserved for internal use: ${BUILTIN_VALUE_CODEC}`,
      );
    }
    if (codecsById.has(codec.codec)) {
      throw new Error(`Duplicate storage envelope codec: ${codec.codec}`);
    }
    codecsById.set(codec.codec, codec);
  }

  const read = async (key: string): Promise<T | undefined> => {
    const envelope = await options.storage.read(key);
    return decodeEnvelope(envelope, codecsById);
  };

  const write = async (key: string, value: T): Promise<void> => {
    let envelope: StorageEnvelope;
    try {
      envelope = await builtInValueCodec.encode(value) as StorageEnvelope;
    } catch (error) {
      if (error instanceof Error) {
        throw error;
      }
      throw new Error("Failed to encode built-in value payload", {
        cause: error,
      });
    }

    assertValidEnvelope(envelope);

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

    await options.storage.write(key, envelope);
  };

  const adapter: StorageAdapter<T> = {
    read,
    write,
    delete(key) {
      return options.storage.delete(key);
    },
    async has(key) {
      return (await read(key)) !== undefined;
    },
  };

  const bulkStorage = options.storage as BulkReadableStorageAdapter<
    StorageEnvelope
  >;
  const readAllEntries = bulkStorage.readAllEntries === undefined
    ? undefined
    : () => bulkStorage.readAllEntries!();
  const readAllKeys = bulkStorage.readAllKeys === undefined
    ? undefined
    : () => bulkStorage.readAllKeys!();
  const readAllValues = bulkStorage.readAllValues === undefined
    ? undefined
    : () => bulkStorage.readAllValues!();

  if (readAllEntries !== undefined) {
    adapter.readAllEntries = () =>
      readAllEntriesFromEntries(readAllEntries, codecsById);
    adapter.readAllKeys = async function* () {
      for await (
        const [key] of readAllEntriesFromEntries<T>(readAllEntries, codecsById)
      ) {
        yield key;
      }
    };
    adapter.readAllValues = async function* (): AsyncIterable<T> {
      for await (
        const [, value] of readAllEntriesFromEntries<T>(
          readAllEntries,
          codecsById,
        )
      ) {
        yield value;
      }
    };
  } else {
    if (readAllKeys !== undefined) {
      adapter.readAllKeys = () => readAllKeysFromKeys(readAllKeys, read);
    }
    if (readAllValues !== undefined) {
      adapter.readAllValues = () =>
        readAllValuesFromValues(readAllValues(), codecsById);
    }
    if (readAllKeys !== undefined) {
      adapter.readAllEntries = () => readAllEntriesFromKeys(readAllKeys, read);
    }
  }

  return adapter;
}

async function* readAllEntriesFromEntries<T>(
  readAllEntries: EntryIteratorFactory<StorageEnvelope>,
  codecsById: ReadonlyMap<string, StorageEnvelopeCodec>,
): AsyncIterable<[string, T]> {
  for await (const [key, envelope] of toAsyncIterable(readAllEntries())) {
    const value = await decodeEnvelope<T>(envelope, codecsById);
    if (value !== undefined) {
      yield [key, value];
    }
  }
}

async function* readAllEntriesFromKeys<T>(
  readAllKeys: KeyIteratorFactory,
  read: (key: string) => Promise<T | undefined>,
): AsyncIterable<[string, T]> {
  for await (const key of toAsyncIterable(readAllKeys())) {
    const value = await read(key);
    if (value !== undefined) {
      yield [key, value];
    }
  }
}

async function* readAllKeysFromKeys<T>(
  readAllKeys: KeyIteratorFactory,
  read: (key: string) => Promise<T | undefined>,
): AsyncIterable<string> {
  for await (const key of toAsyncIterable(readAllKeys())) {
    const value = await read(key);
    if (value !== undefined) {
      yield key;
    }
  }
}

async function* readAllValuesFromValues<T>(
  values: Iterable<StorageEnvelope> | AsyncIterable<StorageEnvelope>,
  codecsById: ReadonlyMap<string, StorageEnvelopeCodec>,
): AsyncIterable<T> {
  for await (const envelope of toAsyncIterable(values)) {
    const value = await decodeEnvelope<T>(envelope, codecsById);
    if (value !== undefined) {
      yield value;
    }
  }
}

async function decodeEnvelope<T>(
  envelope: StorageEnvelope | undefined,
  codecsById: ReadonlyMap<string, StorageEnvelopeCodec>,
): Promise<T | undefined> {
  if (envelope === undefined) {
    return undefined;
  }

  for (let depth = 0; depth < MAX_DECODE_DEPTH; depth += 1) {
    assertValidEnvelope(envelope);

    if (envelope.codec === BUILTIN_VALUE_CODEC) {
      if (envelope.version !== BUILTIN_VALUE_CODEC_VERSION) {
        throw new Error("Unsupported built-in value codec version");
      }

      try {
        return await builtInValueCodec.decode(envelope) as T | undefined;
      } catch (error) {
        throw new Error("Failed to decode built-in value codec payload", {
          cause: error,
        });
      }
    }

    const codec = codecsById.get(envelope.codec);
    if (codec === undefined) {
      throw new Error(`Unknown storage envelope codec: ${envelope.codec}`);
    }

    const nextEnvelope = await codec.decode(envelope);
    if (nextEnvelope === undefined) {
      return undefined;
    }

    envelope = nextEnvelope;
  }

  throw new Error(`Exceeded maximum decode depth of ${MAX_DECODE_DEPTH}`);
}

async function* toAsyncIterable<T>(
  values: Iterable<T> | AsyncIterable<T>,
): AsyncIterable<T> {
  if (Symbol.asyncIterator in values) {
    yield* values as AsyncIterable<T>;
    return;
  }

  yield* values as Iterable<T>;
}
