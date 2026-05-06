# Extended Storage Adapter Specification

## 1. Overview

`createExtendedStorage` constructs a grammY-compatible `StorageAdapter<T>` on top of a backing `StorageAdapter<StorageEnvelope>`.

The extended adapter stores only validated storage envelopes in the backing storage. It does not store raw `T` values.

On write, the adapter:

1. treats top-level `undefined` as deletion;
2. encodes `T` with the mandatory JSON value codec;
3. applies zero or more user-supplied envelope codecs in declaration order;
4. writes the final outer envelope to the backing storage.

On read, the adapter:

1. reads an envelope from backing storage;
2. validates the envelope shape;
3. dispatches decoding by the envelope's `codec` field;
4. repeats until the mandatory JSON value codec is reached or a codec returns `undefined`.

The design is intentionally data-driven on read. The current envelope decides which codec decodes it. Codec array order does not control read dispatch.

This specification does **not** define compatibility for raw, unwrapped legacy values. Existing backing storage data must already be migrated to `StorageEnvelope` values before this adapter is used.

## 2. Terminology

**Extended adapter** means the `StorageAdapter<T>` returned by `createExtendedStorage`.

**Backing storage** means the underlying `StorageAdapter<StorageEnvelope>` passed to `createExtendedStorage`.

**Storage envelope** means the validated object stored in backing storage and exchanged between codecs.

**JSON value codec** means the mandatory internal terminal codec that converts between `T` and a `StorageEnvelope` using `JSON.stringify` and `JSON.parse`.

**Envelope codec** means a user-supplied `StorageEnvelopeCodec` that wraps and unwraps existing storage envelopes.

**Logical absence** means a decoded result of `undefined`. Logical absence is not an error. When the key is known, the adapter deletes that key from backing storage.

## 3. Core API

```ts
import type { StorageAdapter } from "grammy";

export type MaybePromise<T> = T | Promise<T>;

export type StorageEnvelope = {
  kind: typeof STORAGE_ENVELOPE_KIND;
  codec: string;
  version: string;
  payload: string;
};

export interface StorageEnvelopeCodec {
  readonly codec: string;
  readonly version: string;

  encode(envelope: StorageEnvelope): MaybePromise<StorageEnvelope>;

  decode(
    envelope: StorageEnvelope,
  ): MaybePromise<StorageEnvelope | undefined>;
}

export type CreateExtendedStorageOptions = {
  storage: StorageAdapter<StorageEnvelope>;
  codecs?: readonly StorageEnvelopeCodec[];
};

export function createExtendedStorage<T>(
  options: CreateExtendedStorageOptions,
): StorageAdapter<T>;
```

The JSON value codec is mandatory and internal. It is not configurable through the public factory API.

An implementation may define an internal `StorageValueCodec<T>` type, but that type is not a public extension point unless the public API explicitly exposes value-codec customization.

## 4. Reserved Identifiers

The following specification constants are reserved:

```ts
export const STORAGE_ENVELOPE_KIND = "grammy-extended-storage-envelope" as const;
export const VALUE_CODEC_ID = "grammy-extended-storage-value" as const;
export const VALUE_CODEC_VERSION = "1.0.0" as const;
export const MAX_DECODE_DEPTH = 100 as const;
```

User-supplied envelope codecs MUST NOT use:

1. an empty codec identifier;
2. `VALUE_CODEC_ID`;
3. any codec identifier beginning with `grammy-extended-storage-`.

The prefix `grammy-extended-storage-` is reserved for implementation-owned envelope kinds and codec identifiers.

User-supplied codec identifiers SHOULD be globally namespaced. Examples:

```txt
npm:@example/grammy-storage-codecs/aes-gcm
jsr:@example/grammy-storage-codecs/gzip
com.example.telegram.session.crypto
```

A codec identifier MUST be unique within the installed codec set.

## 5. JSON Value Codec

The JSON value codec is the terminal codec. No user-supplied codec participates after it on read.

### 5.1 Encode Semantics

For a defined value `value: T`, the JSON value codec encodes as:

```ts
{
  kind: STORAGE_ENVELOPE_KIND,
  codec: VALUE_CODEC_ID,
  version: VALUE_CODEC_VERSION,
  payload: JSON.stringify(value),
}
```

If `JSON.stringify(value)` does not return a string, encoding MUST throw.

The extended adapter MUST special-case top-level `undefined` before value encoding. Calling `write(key, undefined)` MUST delete `key` from backing storage instead of attempting to store JSON text.

### 5.2 Decode Semantics

The JSON value codec MUST decode only envelopes whose:

```ts
envelope.codec === VALUE_CODEC_ID
envelope.version === VALUE_CODEC_VERSION
```

If the version is unsupported, decoding MUST throw.

If the version is supported, decoding returns:

```ts
JSON.parse(envelope.payload) as T
```

If JSON parsing fails, the error MUST propagate.

### 5.3 Value Constraints

Because the JSON value codec uses normal JSON semantics:

1. values written through the adapter must be JSON-serializable;
2. top-level `undefined` is deletion, not a storable value;
3. `Date`, `Map`, `Set`, `bigint`, class instances, functions, symbols, cyclic graphs, `NaN`, `Infinity`, and exact `undefined` property semantics are not preserved as rich JavaScript values;
4. callers are responsible for ensuring that the stored runtime shape actually matches `T`.

The adapter does not perform schema validation for `T`.

## 6. Envelope Invariants

Every envelope read from backing storage and every envelope returned by a codec MUST satisfy:

1. the value is a non-null object;
2. the value is not an array;
3. `kind === STORAGE_ENVELOPE_KIND`;
4. `codec` is a non-empty string;
5. `version` is a string;
6. `payload` is a string.

`version` is an opaque string to the adapter. Codec authors SHOULD use SemVer or another stable documented versioning scheme, but the adapter MUST NOT parse or enforce SemVer.

The adapter MUST validate envelope shape at runtime when crossing a storage or codec boundary. These runtime checks protect stored data integrity. The adapter is not required to duplicate TypeScript's structural checks for every caller-supplied codec object.

## 7. Envelope Codec Contract

### 7.1 `StorageEnvelopeCodec.codec`

`codec` identifies a codec family.

A codec family SHOULD keep a stable `codec` identifier across compatible historical versions and use `version` to distinguish payload formats.

Changing `codec` means the implementation is treated as a different codec family.

### 7.2 `StorageEnvelopeCodec.version`

`version` identifies the current write format produced by `encode`.

The adapter treats `version` as opaque. A codec's own `decode` implementation is responsible for accepting or rejecting the versions for that codec family.

### 7.3 `StorageEnvelopeCodec.encode`

`encode` accepts a valid inner `StorageEnvelope` and returns a valid outer `StorageEnvelope`.

`encode` MUST:

1. serialize the input envelope into a codec-private payload string;
2. return an envelope whose `codec` equals the installed codec identifier;
3. return an envelope whose `version` equals the installed codec version;
4. return an envelope whose `payload` is a string;
5. never return `undefined`.

The adapter MUST validate the returned envelope. The adapter MUST also verify that the returned envelope identifies the codec that produced it.

### 7.4 `StorageEnvelopeCodec.decode`

`decode` accepts a valid envelope whose `codec` matches the installed codec identifier.

`decode` returns either:

1. the next inner `StorageEnvelope`; or
2. `undefined` to indicate logical absence.

`decode` MAY support multiple historical versions for the same codec identifier.

`decode` MUST throw when its payload cannot be decoded, when the envelope version is unsupported, or when the envelope is otherwise invalid for that codec's private format.

A codec returning `undefined` from `decode` is not an error.

## 8. Construction Rules

`createExtendedStorage` MUST:

1. accept a backing `StorageAdapter<StorageEnvelope>`;
2. normalize missing `options.codecs` to an empty installed codec set;
3. reject user codecs with empty codec identifiers;
4. reject user codecs using reserved implementation identifiers;
5. reject duplicate codec identifiers;
6. build a dispatch map keyed by codec identifier;
7. return a grammY-compatible `StorageAdapter<T>`.

The installed codec set is fixed at construction time. Later mutation of `options.codecs` MUST NOT add, remove, reorder, or otherwise change the adapter's installed codec set.

The installed codec identifier and installed codec version for each codec are fixed at construction time for adapter-level routing and encode-output identity checks.

The adapter SHOULD rely on TypeScript for ordinary structural validation of caller-provided codec objects. Runtime construction checks are required only for storage-integrity invariants such as empty identifiers, reserved identifiers, and duplicate identifiers.

## 9. Write Semantics

For `write(key, value)`:

1. if `value === undefined`, call `storage.delete(key)` and return;
2. encode `value` with the JSON value codec;
3. validate the resulting envelope;
4. for each installed envelope codec in declaration order:
   1. call `codec.encode(currentEnvelope)`;
   2. validate the returned envelope;
   3. verify that returned `codec` and `version` match the installed codec metadata;
   4. use the returned envelope as the new current envelope;
5. write the final envelope to backing storage.

If installed codecs are `[A, B, C]`, the stored value is wrapped as:

```txt
C(B(A(JSON(T))))
```

Codec declaration order therefore defines the wrapping order for new writes.

## 10. Read Semantics

For `read(key)`:

1. call `storage.read(key)`;
2. if backing storage returns `undefined`, return `undefined`;
3. treat the returned value as the current envelope;
4. validate the current envelope;
5. inspect `current.codec`;
6. if `current.codec === VALUE_CODEC_ID`, decode with the JSON value codec and return `T | undefined`;
7. otherwise locate the installed envelope codec by `current.codec`;
8. if no codec is installed for `current.codec`, throw;
9. invoke that codec's `decode(current)`;
10. if decode returns `undefined`, delete `key` from backing storage and return `undefined`;
11. otherwise treat the returned envelope as current and repeat.

Read routing is data-driven, not order-driven. Reordering `options.codecs` changes the wrapping order of future writes, but existing stored values remain readable as long as every required codec identifier is still installed and each codec supports the stored versions.

The adapter MUST enforce a maximum user-codec decode depth. The default maximum is `MAX_DECODE_DEPTH`. If the maximum is exceeded, the adapter MUST throw.

## 11. Delete Semantics

`delete(key)` MUST delegate directly to backing storage:

```ts
await storage.delete(key);
```

## 12. Optional StorageAdapter Methods

The extended adapter MUST expose `has`, even when the backing storage does not expose `has`.

The extended adapter MAY expose `readAllKeys`, `readAllValues`, and `readAllEntries` when the backing storage exposes enough capability to implement them correctly.

Returned bulk methods MAY be `AsyncIterable` even when the backing storage exposes synchronous iterables, because decoding may be asynchronous.

### 12.1 `has`

`has(key)` MUST be semantically equivalent to:

```ts
return (await read(key)) !== undefined;
```

It MUST NOT simply forward `storage.has(key)` unless forwarding is provably equivalent to wrapped `read` semantics.

Because `has` uses wrapped `read`, it may trigger the same cleanup side effects as `read` when decoding terminates in logical absence.

### 12.2 `readAllKeys`

If exposed, `readAllKeys()` MUST yield only keys whose decoded value is not `undefined`.

A correct implementation may:

1. iterate backing entries and decode each entry; or
2. iterate backing keys and call wrapped `read(key)` for each key.

### 12.3 `readAllValues`

If exposed, `readAllValues()` MUST yield only decoded values that are not `undefined`.

A correct implementation may:

1. iterate backing entries and decode each entry; or
2. iterate backing values and decode each value.

When deriving `readAllValues()` from backing values alone, the adapter cannot delete entries whose decoded result is logical absence, because no key is available.

### 12.4 `readAllEntries`

If exposed, `readAllEntries()` MUST yield only `[key, value]` pairs whose decoded value is not `undefined`.

A correct implementation may:

1. iterate backing entries and decode each entry; or
2. iterate backing keys and call wrapped `read(key)` for each key.

## 13. Validation Rules

`assertValidEnvelope` MUST verify at minimum:

```ts
export function assertValidEnvelope(
  value: unknown,
): asserts value is StorageEnvelope {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Invalid envelope: expected a non-null object");
  }

  const envelope = value as Record<string, unknown>;

  if (envelope.kind !== STORAGE_ENVELOPE_KIND) {
    throw new Error("Invalid envelope kind");
  }

  if (typeof envelope.codec !== "string" || envelope.codec.length === 0) {
    throw new Error("Invalid envelope codec");
  }

  if (typeof envelope.version !== "string") {
    throw new Error("Invalid envelope version");
  }

  if (typeof envelope.payload !== "string") {
    throw new Error("Invalid envelope payload");
  }
}
```

A validation failure MUST throw.

## 14. Error Semantics

The adapter MUST throw on at least the following conditions:

1. backing storage returns a non-envelope value;
2. envelope `kind` is invalid;
3. envelope `codec` is missing or empty;
4. envelope `version` is not a string;
5. envelope `payload` is not a string;
6. a user codec identifier is empty at construction;
7. a user codec identifier is reserved at construction;
8. two installed codecs share the same codec identifier;
9. an envelope references an unknown codec identifier;
10. a codec returns an invalid envelope;
11. a codec `encode` output does not identify the installed codec and version;
12. JSON value encoding cannot produce a string payload;
13. JSON value decoding receives an unsupported version;
14. JSON parsing fails;
15. a user codec rejects an unsupported version;
16. a user codec fails to decode its private payload;
17. the maximum decode depth is exceeded.

The adapter SHOULD allow codec-thrown errors to propagate.

A codec returning `undefined` from `decode` is not an error. It means logical absence.

## 15. Progress Requirement

A codec decode chain MUST make progress toward the JSON value codec or logical absence.

A codec implementation MUST NOT create an infinite decode loop by repeatedly returning envelopes that keep the system at the same logical decode step forever.

The adapter MUST enforce `MAX_DECODE_DEPTH` as a defensive guard. The guard does not prove semantic progress; it only prevents unbounded loops.

## 16. Backing Storage Requirements

The backing storage passed to `createExtendedStorage` MUST be treated as `StorageAdapter<StorageEnvelope>`.

The backing storage MUST contain only valid `StorageEnvelope` values for keys read by the extended adapter.

The caller is responsible for migrating existing raw `T` values before using this adapter. This specification does not define an implicit migration path from raw values to envelopes.

## 17. Non-Goals

This specification does not require:

1. SemVer validation;
2. schema validation for `T`;
3. broad runtime validation of TypeScript codec object shape;
4. canonical serialization of inner envelopes across user codecs;
5. generic decoding by unrelated codecs;
6. external tooling that can inspect codec-private payloads;
7. support for non-JSON top-level values through the mandatory JSON value codec;
8. transparent compatibility with pre-existing raw storage values;
9. configurable replacement of the JSON value codec.
