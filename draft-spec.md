# Technical Specification: Extended Storage Adapter

## 1. Overview

`createExtendedStorage<T>` constructs a `StorageAdapter<T>` on top of a backing `StorageAdapter<StorageEnvelope>`.

The extended adapter applies a built-in value codec for `T`, then zero or more user-supplied `StorageEnvelopeCodec`s when writing. On read, it repeatedly dispatches decoding based on the current envelope’s `codec` field until the built-in value codec is reached or decoding terminates with `undefined`.

This design treats `payload` as codec-private and opaque. No codec, other than the codec identified by the current envelope’s `codec`, is required or permitted to interpret that payload.

This design does **not** include a compatibility shim for raw unwrapped legacy values. The backing storage is expected to contain `StorageEnvelope` values only. That is a deliberate difference from grammY’s current helper, which internally uses a compat wrapper.

---

## 2. Core Types

```ts
type MaybePromise<T> = T | Promise<T>;

type StorageEnvelope = {
  kind: "grammy-extended-storage-envelope";
  codec: string;
  version: string;
  payload: string;
};

interface StorageEnvelopeCodec {
  readonly codec: string;
  readonly version: string;
  encode(envelope: StorageEnvelope): MaybePromise<StorageEnvelope>;
  decode(envelope: StorageEnvelope): MaybePromise<StorageEnvelope | undefined>;
}

interface StorageValueCodec<T> {
  readonly codec: string;
  readonly version: string;
  encode(value: T): MaybePromise<StorageEnvelope>;
  decode(envelope: MaybeStorageEnvelope): Promise<T | undefined>;
}
```

---

## 3. Factory API

```ts
function createExtendedStorage<T>(options: {
  storage: StorageAdapter<StorageEnvelope>;
  codecs?: readonly StorageEnvelopeCodec[];
}): StorageAdapter<T>;
```

### Construction Rules

`createExtendedStorage` MUST:

1. accept a backing `StorageAdapter<StorageEnvelope>`;
2. accept zero or more outer codecs in `options.codecs`;
3. install an internal built-in value codec for `T`;
4. return a `StorageAdapter<T>`.

The built-in value codec is mandatory and not configurable through the public API.

---

## 4. Reserved Identifiers

The following values are reserved by this specification:

```ts
const STORAGE_ENVELOPE_KIND = "grammy-extended-storage-envelope";
const BUILTIN_VALUE_CODEC = "grammy-extended-storage-value";
const BUILTIN_VALUE_CODEC_VERSION = 1;
```

User-supplied codecs MUST NOT use:

* `kind: "grammy-extended-storage-envelope"` for anything other than `StorageEnvelope.kind`;
* `codec: "grammy-extended-storage-value"`;
* any future reserved internal codec identifier defined by the implementation.

A codec identifier MUST be unique within the installed codec set.

---

## 5. Built-in Value Codec

### Built-in Encode Semantics

The built-in value codec MUST encode `T` as:

```ts
{
  kind: "grammy-extended-storage-envelope",
  codec: "grammy-extended-storage-value",
  version: "1.0.0",
  payload: JSON.stringify(value)
}
```

### Built-in Decode Semantics

The built-in value codec MUST decode by applying `JSON.parse(envelope.payload)` and returning the parsed value as `T`.

### Value Constraints

Because the built-in value codec uses JSON:

1. top-level `T` values written through the adapter MUST be JSON-serializable;
2. top-level `undefined` is not supported as a storable value, entry is deleted if value is just `undefined`;
3. runtime preservation of `Date`, `Map`, `Set`, `bigint`, class instances, functions, symbols, cyclic graphs, `NaN`, `Infinity`, and exact `undefined` property semantics is not guaranteed;
4. the caller is responsible for ensuring the stored runtime shape actually matches `T`.

This is an intentional constraint of the built-in codec.

---

## 6. Envelope Invariants

Any `StorageEnvelope` emitted by the built-in value codec or by a `StorageEnvelopeCodec.encode` implementation MUST satisfy all of the following:

1. `kind === "grammy-extended-storage-envelope"`;
2. `codec` is a non-empty string;
3. `version` is a SemVer string;
4. `payload` is a string.

Additionally, any `StorageEnvelopeCodec.encode` implementation MUST emit an envelope whose:

* `codec === codecImplementation.codec`
* `version === codecImplementation.version`

In other words, the output envelope always identifies the codec that most recently wrapped it.

---

## 7. Codec Contract

## 7.1 `StorageEnvelopeCodec.encode`

`encode` accepts a valid `StorageEnvelope` and returns a new valid `StorageEnvelope`.

`encode` MUST:

1. serialize that input envelope into a codec-private `payload` string;
2. return a new outer envelope that identifies the current codec and version.

`encode` MAY implement any reversible private string representation for `payload`.

`encode` MUST NOT return `undefined`.

## 7.2 `StorageEnvelopeCodec.decode`

`decode` accepts a valid `StorageEnvelope` previously produced by the same codec family and returns either:

* the next inner `StorageEnvelope`, or
* `undefined`.

`decode` is only invoked when `envelope.codec === codecImplementation.codec`.

`decode` MAY accept multiple historical envelope versions for the same `codec` identifier.

`decode` MUST throw if:

* the envelope is malformed;
* the payload cannot be decoded by this codec;
* the envelope version is unsupported;

`decode` MAY return `undefined` to indicate that decoding terminates in logical absence.

## 7.3 `StorageValueCodec<T>`

The built-in value codec is terminal.

Its `encode` converts `T` to a `StorageEnvelope`.
Its `decode` converts the terminal `StorageEnvelope` back to `T | undefined`.

No user-supplied codec participates after the built-in value codec on read.

---

## 8. Write Semantics

For `write(key, value)`:

1. the built-in value codec encodes `value` into the initial envelope;
2. each installed codec in `options.codecs` is applied in declaration order;
3. the final envelope is written to the backing storage.

Reference algorithm:

```ts
async function write(key: string, value: T): Promise<void> {
  // In actual implementation, the builtin value codec is its own class and file
  let envelope: StorageEnvelope = {
    kind: "grammy-extended-storage-envelope",
    codec: "grammy-extended-storage-value",
    version: "1.0.0",
    payload: JSON.stringify(value),
  };

  for (const codec of codecs) {
    envelope = await codec.encode(envelope);
    // only checks type/shape
    assertValidEnvelope(envelope);
  }

  await storage.write(key, envelope);
}
```

### Write Ordering

If installed codecs are `[A, B, C]`, the stored value is:

```ts
C(B(A(value(T))))
```

Codec declaration order therefore defines the wrapping order for new writes.

---

## 9. Read Semantics

For `read(key)`:

1. read the stored envelope from backing storage;
2. if backing storage returns `undefined`, return `undefined`;
3. validate the current envelope shape;
4. inspect `envelope.codec`;
5. if it is the built-in value codec id, decode and return `T | undefined`;
6. otherwise locate the matching installed codec by `codec` id;
7. invoke that codec’s `decode`;
8. if decode returns `undefined`, terminate, delete this key-value from storage, and return `undefined`;
9. otherwise continue the loop with the returned inner envelope.

Reference algorithm:

```ts
async function read(key: string): Promise<T | undefined> {
  let envelope = await storage.read(key);
  if (envelope === undefined) return undefined;

  for (;;) {
    // only checks type/shape
    assertValidEnvelope(envelope);

    // In actual implementation, the builtin value codec is its own class and file
    if (envelope.codec === "grammy-extended-storage-value") {
      if (envelope.version !== "1.0.0") {
        throw new Error("Unsupported built-in value codec version");
      }
      return JSON.parse(envelope.payload) as T;
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
}
```

### Read Routing

Read routing is data-driven, not order-driven.

That means installed codec order is irrelevant for dispatch during read. The adapter routes only by the current envelope’s `codec` field. Reordering codecs changes the wrapping order of future writes, but old data remains readable as long as the required codecs are still installed and still support the stored versions.

---

## 10. Delete Semantics

`delete(key)` MUST delegate directly to `storage.delete(key)`.

```ts
async function deleteKey(key: string): Promise<void> {
  await storage.delete(key);
}
```

---

## 11. Optional `StorageAdapter` Methods

Because grammY’s `StorageAdapter<T>` also defines optional `has`, `readAllKeys`, `readAllValues`, and `readAllEntries`, the extended adapter SHOULD preserve semantic consistency when exposing them.

## 11.1 `has`

If exposed, `has(key)` MUST be semantically equivalent to:

```ts
async function has(key: string): Promise<boolean> {
  return (await read(key)) !== undefined;
}
```

It MUST NOT simply forward `storage.has(key)` unless that is provably equivalent.

## 11.2 `readAllKeys`

If exposed, `readAllKeys()` MUST yield only keys whose decoded value is not `undefined`.

A correct implementation may:

* iterate backing keys and call wrapped `read(key)` for each key, or
* use backing entries if available and decode each entry.

## 11.3 `readAllValues`

If exposed, `readAllValues()` MUST decode each backing value and yield only decoded `T` values that are not `undefined`.

## 11.4 `readAllEntries`

If exposed, `readAllEntries()` MUST decode each backing entry and yield only `[key, value]` pairs whose decoded value is not `undefined`.

## 11.5 Sync vs Async Bulk Methods

The returned optional bulk methods MAY be `AsyncIterable` even if the backing adapter exposes synchronous iterables, because decoding may be asynchronous.

---

## 12. Validation Rules

The implementation MUST validate all envelopes read from backing storage and all envelopes returned by codecs.

A validation failure MUST throw.

`assertValidEnvelope` MUST verify at minimum:

```ts
function assertValidEnvelope(value: unknown): asserts value is StorageEnvelope {
  if (typeof value !== "object" || value === null) throw new Error("Invalid envelope");
  const v = value as Record<string, unknown>;
  if (v.kind !== "grammy-extended-storage-envelope") throw new Error("Invalid envelope kind");
  if (typeof v.codec !== "string" || v.codec.length === 0) throw new Error("Invalid envelope codec");
  if (typeof v.version !== "string") {
    throw new Error("Invalid envelope version");
  }
  if (typeof v.payload !== "string") throw new Error("Invalid envelope payload");
}
```

---

## 13. Error Semantics

The adapter MUST throw on the following conditions:

1. backing storage returns a non-envelope value;
2. `kind` is invalid;
3. `codec` is unknown;
4. `version` is unsupported by the relevant codec (thrown by codec, itself);
5. a codec returns an invalid envelope;
6. built-in JSON decoding fails (thrown by codec, itself);
7. a codec fails to decode its payload (thrown by codec, itself);
8. two installed codecs share the same `codec` identifier.

A codec returning `undefined` from `decode` is **not** an error. It means logical absence and terminates the read with `undefined`.

---

## 14. Progress Requirement

A codec decode chain MUST make progress toward the built-in value codec.

A codec implementation MUST NOT create an infinite decode loop by repeatedly returning envelopes that keep the system at the same logical decode step forever.

The implementation SHOULD enforce a maximum decode depth as a defensive guard. A recommended default is:

```ts
const MAX_DECODE_DEPTH = 100;
```

If the limit is exceeded, the adapter MUST throw.

---

## 15. Codec Versioning

For `StorageEnvelopeCodec`:

* `codec` identifies the codec family;
* `version` identifies the current write format produced by `encode`.

`decode` MAY support one or more historical versions for the same `codec`.

A codec implementation SHOULD preserve its `codec` identifier across compatible historical versions and use `version` to branch decode behavior.

If a codec changes its `codec` identifier, that is treated as a new codec family.

---

## 16. Codec Installation Rules

At construction time, `createExtendedStorage` MUST:

1. normalize `codecs` to an empty array if omitted;
2. verify all codec identifiers are unique;
3. build a `Map<string, StorageEnvelopeCodec>` keyed by `codec`.

A codec identifier collision MUST throw immediately during construction.

---

## 17. Backing Storage Requirements

The backing storage used with `createExtendedStorage` MUST store only `StorageEnvelope` values.

It is a caller responsibility to ensure existing data in the backing storage already conforms to this format.

This specification does not define any implicit migration path from raw `T` values to `StorageEnvelope` values.

---

## 18. Non-Goals

This specification does not require:

1. canonical serialization of inner envelopes across codecs;
2. generic decoding by unrelated codecs;
3. external tooling that can inspect codec-private payloads;
4. support for non-JSON top-level values via the built-in value codec;
5. transparent compatibility with pre-existing raw storage values.
