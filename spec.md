# @grammyjs/storage-extended: Architectural & API Specification

An advanced, middleware-like session storage wrapper for the [grammY bot framework](https://grammy.dev/).

---

## 1. Overview & Architecture

`@grammyjs/storage-extended` provides a layered session storage adapter (`StorageAdapter<T>`) built on top of an underlying raw storage engine (`StorageAdapter<StorageEnvelope>`). 

Instead of storing raw, unstructured session objects directly in the database, this extension encapsulates the session state inside a structured metadata envelope (`StorageEnvelope`). The adapter then runs a pipeline of **Envelope Codecs** that recursively serialize, encrypt, compress, or sign the data as it flows into and out of storage.

### 1.1 Serialization (Write) Pipeline

When writing data, the session state is first serialized into a JSON envelope. Then, user-defined codecs are applied sequentially in the **order of their declaration** (from first to last):

```
Raw Session State (T)
         │
         ▼
 ┌───────────────┐
 │  Value Codec  │  <-- Encodes session state (T) into initial JSON payload
 └───────────────┘
         │
         ▼   [Core Envelope]
 ┌───────────────┐
 │    Codec A    │  <-- First user-supplied layer (e.g. Compression)
 └───────────────┘
         │
         ▼   [Compressed Envelope]
 ┌───────────────┐
 │    Codec B    │  <-- Second user-supplied layer (e.g. Encryption)
 └───────────────┘
         │
         ▼   [Compressed & Encrypted Envelope]
 ┌───────────────┐
 │  Raw Storage  │  <-- Outermost envelope written to backing database
 └───────────────┘
```

### 1.2 Deserialization (Read) Pipeline

Unlike the write pipeline, reading is **data-driven**, not order-driven. The adapter inspects the `codec` identifier of the envelope retrieved from storage, locates the matching codec, and decodes it. This process repeats recursively until it reaches the core JSON Value Codec:

```
                  ┌───────────────┐
                  │  Raw Storage  │  <-- Reads outermost envelope
                  └───────────────┘
                          │
                          ▼   [Enveloped Data]
                  ┌───────────────┐
                  │  Route Codec  │  <-- Inspects `envelope.codec`
                  └───────────────┘
                          │
            ┌─────────────┴─────────────┐
            ▼ (codec === "aes-gcm")     ▼ (codec === "value")
    ┌───────────────┐           ┌───────────────┐
    │    Codec B    │           │  Value Codec  │
    └───────────────┘           └───────────────┘
            │                           │
            ▼ [Compressed Envelope]     ▼
    ┌───────────────┐           ┌───────────────┐
    │    Route      │           │ Return state T│
    └───────────────┘           └───────────────┘
            │
            ▼ (codec === "gzip")
    ┌───────────────┐
    │    Codec A    │
    └───────────────┘
            │
            ▼ [Core Envelope]
    ┌───────────────┐
    │  Value Codec  │
    └───────────────┘
            │
            ▼
     Return state T
```

> [!IMPORTANT]
> **No Legacy Compatibility**: This specification does **not** provide fallback parsing for raw, unwrapped legacy database entries. Any pre-existing database contents must be migrated to `StorageEnvelope` format before activating this adapter.

---

## 2. Core Domain Concepts

| Concept | Description |
| :--- | :--- |
| **Layered Adapter** | The `StorageAdapter<T>` returned by `createExtendedStorage` that wraps the underlying storage. |
| **Underlying Storage** | The physical database adapter (e.g., Redis, MongoDB, Memory) that reads and writes `StorageEnvelope` objects. |
| **Storage Envelope** | The standardized JSON transport object (`StorageEnvelope`) stored in the underlying database. |
| **Value Codec** | The mandatory, internal serializer that converts the rich session state `T` to/from the core `StorageEnvelope`. |
| **Envelope Codec** | A middleware-like plugin (`StorageEnvelopeCodec`) that takes a `StorageEnvelope` and encodes its payload into another outer `StorageEnvelope`. |
| **Implicit Deletion (Tombstoning)** | A design pattern where a codec's `decode` returns `undefined` (indicating the session has expired or failed validation), triggering automatic removal of that key from storage. |

---

## 3. Public API Contracts

```typescript
import type { StorageAdapter } from "grammy";

export type MaybePromise<T> = T | Promise<T>;

/**
 * The standardized container stored physically in the database.
 */
export type StorageEnvelope = {
  readonly kind: typeof STORAGE_ENVELOPE_KIND;
  readonly codec: string;
  readonly version: string;
  readonly payload: string;
};

/**
 * Interface implemented by custom codec plugins (e.g., encryption, compression).
 */
export interface StorageEnvelopeCodec {
  /** A unique identifier representing this codec family (e.g., "aes-gcm"). */
  readonly codec: string;

  /** The current version of the write format produced by this codec (e.g., "1.0.0"). */
  readonly version: string;

  /** Wraps an inner envelope into an outer envelope. */
  encode(envelope: StorageEnvelope): MaybePromise<StorageEnvelope>;

  /**
   * Unwraps an outer envelope back into its inner envelope.
   * Returns `undefined` if the envelope represents a tombstoned or expired session.
   */
  decode(
    envelope: StorageEnvelope,
  ): MaybePromise<StorageEnvelope | undefined>;
}

export type CreateExtendedStorageOptions = {
  /** The physical database adapter to read/write envelopes. */
  storage: StorageAdapter<StorageEnvelope>;
  
  /** Optional ordered array of envelope wrapping layers. */
  codecs?: readonly StorageEnvelopeCodec[];
};

export function createExtendedStorage<T>(
  options: CreateExtendedStorageOptions,
): StorageAdapter<T>;
```

### 3.1 Serialization Constraints
The JSON Value Codec is internal and mandatory. Custom serialization algorithms (e.g. MessagePack) are not supported at the value-codec level unless the public factory API is extended to expose value-codec customization.

---

## 4. Spec Constants & Reserved Identifiers

The following identifier constants are reserved by the implementation:

```typescript
export const STORAGE_ENVELOPE_KIND = "grammy-extended-storage-envelope" as const;
export const VALUE_CODEC_ID = "grammy-extended-storage-value" as const;
export const VALUE_CODEC_VERSION = "1.0.0" as const;
export const MAX_DECODE_DEPTH = 100 as const;
```

### 4.1 Custom Codec Constraints
User-supplied `StorageEnvelopeCodec` objects must adhere to the following naming rules:
1. **No Empty Identifiers**: The `codec` string cannot be empty.
2. **No Value Codec Hijacking**: The `codec` string cannot equal `VALUE_CODEC_ID`.
3. **No Prefix Collisions**: The `codec` string cannot begin with `grammy-extended-storage-`.

> [!TIP]
> Custom codec identifiers should be globally namespaced to prevent collisions (e.g. `npm:@my-org/codec-aes-gcm` or `jsr:@my-org/codec-lz4`).

---

## 5. Terminal JSON Value Codec

The `JsonValueCodec` is the core terminal serializer in the read/write pipeline.

### 5.1 Encoding
For any defined session value `value: T`:
- It MUST serialize the value using `JSON.stringify(value)`.
- It MUST return a `StorageEnvelope` structure:
  ```json
  {
    "kind": "grammy-extended-storage-envelope",
    "codec": "grammy-extended-storage-value",
    "version": "1.0.0",
    "payload": "<JSON string>"
  }
  ```
- If stringification fails or produces `undefined`, encoding MUST throw an error.
- **Top-Level `undefined` Special Case**: Before encoding, the adapter MUST intercept top-level `undefined` session writes, treating them as deletion requests (delegated directly to `storage.delete(key)`), bypassing the serialization pipeline.

### 5.2 Decoding
When encountering an envelope with `codec === VALUE_CODEC_ID`:
- The adapter MUST verify that `version === VALUE_CODEC_VERSION`.
- If the version mismatches, decoding MUST throw an error.
- If the version is correct, it MUST return `JSON.parse(envelope.payload) as T`.
- Any JSON parsing exceptions MUST propagate up as errors.

### 5.3 Rich Types Limitation
Because serialization relies on standard JSON:
- Sessions must be JSON-serializable.
- Rich JS classes and types (`Date`, `Map`, `Set`, `bigint`, cyclic graphs, functions, and symbols) are **not preserved** and will be degraded or raise serialization exceptions.

---

## 6. Runtime Invariant Validations

To protect storage integrity, the adapter MUST execute runtime validation of envelopes whenever data crosses a boundary (upon reading from storage, and before/after passing data to any custom codec).

An object is validated by `assertValidEnvelope(value)` and must satisfy:
1. The value is a non-null `object`.
2. The value is not an array.
3. The `kind` property matches `STORAGE_ENVELOPE_KIND` exactly.
4. The `codec` property is a non-empty string.
5. The `version` property is a string.
6. The `payload` property is a string.

Failure to satisfy any of these conditions MUST throw an immediate validation error.

---

## 7. Custom Envelope Codec Contract

Custom codecs (e.g., for encryption or compression) must comply with the following contracts:

### 7.1 `codec` property
Acts as the identifier for the codec family. It must remain stable across different versions of the format.

### 7.2 `version` property
Represents the format version produced by `encode()`. The adapter treats this as an opaque string, but codec authors should use semantic versioning (SemVer) to manage format transitions.

### 7.3 `encode(envelope)`
- **Input**: A validated inner `StorageEnvelope`.
- **Output**: A validated outer `StorageEnvelope` wrapping the inner envelope.
- **Rules**:
  - The returned envelope's `codec` and `version` fields MUST match the codec's declared properties.
  - The inner envelope MUST be serialized into the output's `payload` string.
  - `encode` MUST NEVER return `undefined`.

### 7.4 `decode(envelope)`
- **Input**: A validated outer `StorageEnvelope` owned by this codec family.
- **Output**: The next inner `StorageEnvelope`, or `undefined` to signal implicit session expiration/deletion.
- **Rules**:
  - The codec's `decode` is responsible for handling historical version backward compatibility.
  - It MUST throw an error if the payload cannot be decrypted, decompressed, or parsed, or if the format version is unsupported.

---

## 8. Construction & Initialization

When calling `createExtendedStorage(options)`:
1. **Normalisation**: If `options.codecs` is missing, default to an empty list.
2. **Uniqueness**: Ensure that no two codecs share the same `codec` identifier.
3. **Validation**: Check each codec against the reserved identifier rules.
4. **Immutability**: The set of codecs and their metadata is fixed at construction time. Subsequent mutation of the source options array MUST NOT alter the adapter's behavior.

---

## 9. Write Pipeline Flow

When the bot writes session data via `write(key, value)`:

1. **Delete Interception**: If `value === undefined`, invoke `storage.delete(key)` and return immediately.
2. **Initial Serialization**: Serialize the session state using the internal terminal JSON Value Codec.
3. **Shape Check**: Run `assertValidEnvelope` on the serialized envelope.
4. **Layer Application**: For each custom codec in the `codecs` option, in **command order** (declaration order):
   1. Invoke `codec.encode(currentEnvelope)`.
   2. Run `assertValidEnvelope` on the output.
   3. Verify that the output's `codec` and `version` match the codec's registered properties.
   4. Update `currentEnvelope` to this output.
5. **Physical Storage**: Save the final outermost envelope to the underlying storage using `storage.write(key, currentEnvelope)`.

---

## 10. Read & Decoding Pipeline Flow

When the bot requests session data via `read(key)`:

1. **Physical Read**: Fetch the entry from underlying storage.
2. **Miss Handling**: If the database returns `undefined`, return `undefined` immediately.
3. **Loop Initialization**: Set the retrieved envelope as `currentEnvelope` and set `decodeDepth = 0`.
4. **Decoding Loop**:
   1. Run `assertValidEnvelope(currentEnvelope)`.
   2. **Terminal Case**: If `currentEnvelope.codec === VALUE_CODEC_ID`, decode it using the JSON Value Codec and return the decoded session object `T` to the caller.
   3. **Depth Check**: If `decodeDepth >= MAX_DECODE_DEPTH`, throw a recursion loop error.
   4. **Codec Lookup**: Find the registered custom codec matching `currentEnvelope.codec`. If not found, throw an error.
   5. **Execution**: Pass the envelope to the custom codec's `decode` method.
   6. **Tombstone Case**: If `decode` returns `undefined` (tombstone / logical absence):
      1. Trigger an automatic cleanup call: `await storage.delete(key)`.
      2. Halt processing and return `undefined` to the caller.
   7. **Progress**: Increment `decodeDepth`, set `currentEnvelope` to the decoded inner envelope, and repeat the loop.

> [!NOTE]
> **Data-Driven Routing**: Because decoding routes dynamically via the `codec` metadata on the envelopes, changing the sequence of `codecs` in the options does not break the ability to read pre-existing data, as long as all required codecs remain registered.

---

## 11. Deletion & Tombstones

```
               Direct Delete
            ───────────────────►  [storage.delete(key)]
            
            
            Implicit Delete (during read decode)
            [decode(env)] ───► returns undefined (Tombstone)
                                    │
                                    ▼
                          [storage.delete(key)]
```

- **Direct Deletion**: `delete(key)` bypasses the codec pipeline and invokes the underlying storage's `delete` method directly.
- **Implicit Cleanup**: When a custom codec indicates that a session is expired or revoked (by returning `undefined` from `decode`), the adapter automatically executes a database cleanup delete for that key.

---

## 12. Optional Bulk Capabilities

If the underlying storage supports bulk capabilities, the layered adapter selectively exposes them if they can be implemented soundly.

### 12.1 `has(key)`
- Always exposed.
- Implemented as: `(await read(key)) !== undefined`.
- **Warning**: Calling `has` performs a full read/decode cycle, meaning it may trigger implicit deletion side-effects if a session has expired. It must **not** forward blindly to the underlying storage's `.has()` method.

### 12.2 `readAllKeys()`
Exposed if the underlying storage implements `readAllEntries` or `readAllKeys`.
- Yields only keys whose sessions successfully decode and do not evaluate to `undefined`.
- If the underlying storage implements `readAllEntries()`, it iterates over the entries and decodes each envelope.
- Otherwise, it falls back to iterating backing keys and executing a full `read(key)` for each key.

### 12.3 `readAllValues()`
Exposed if the underlying storage implements `readAllEntries` or `readAllValues`.
- Yields only fully decoded session values of type `T` (filtering out `undefined` tombstones).
- **Caveat**: If deriving values solely from `readAllValues` without keys, the adapter cannot delete tombstones from the underlying database because the keys are unavailable.

### 12.4 `readAllEntries()`
Exposed if the underlying storage implements `readAllEntries` or `readAllKeys`.
- Yields `[key, T]` pairs where `T !== undefined`.
- Prefers iterating entries, but falls back to iterating keys and fetching each key.

---

## 13. Error Reference Matrix

The adapter guarantees that errors are thrown under the following circumstances:

| Phase | Failure Trigger | Thrown Error Context / Type |
| :--- | :--- | :--- |
| **Construction** | A codec identifier is empty or invalid. | Construction validation error. |
| **Construction** | Two codecs declare the identical identifier. | Duplicate registration error. |
| **Construction** | A codec uses `grammy-extended-storage-value` or prefixes. | Reserved namespace violation. |
| **Runtime Write** | Output of `JSON.stringify` is invalid/undefined. | Serialization failure. |
| **Runtime Write** | A codec returns an object that fails shape invariants. | Post-encode validation error. |
| **Runtime Write** | A codec's output `codec`/`version` doesn't match its ID. | Identity verification failure. |
| **Runtime Read** | Database returns an object failing envelope invariants. | Pre-decode validation error. |
| **Runtime Read** | Value codec version is not `1.0.0`. | Version unsupported error. |
| **Runtime Read** | JSON parsing of terminal payload fails. | Parse error propagation. |
| **Runtime Read** | Envelope codec identifier is not registered. | Unknown codec routing error. |
| **Runtime Read** | Decode chain depth hits `MAX_DECODE_DEPTH`. | Recursion loop guard error. |
| **Runtime Read** | A codec fails to decode internally. | Propagation of codec's thrown error. |

---

## 14. Non-Goals

This specification does **not** mandate or cover:
- Semantic Versioning (SemVer) format validation by the adapter.
- Custom validation schemas for the user session type `T`.
- Transparent support for legacy raw database values (migration is the caller's responsibility).
- Replacement of the terminal JSON Value Codec with other serialization systems.
- Codec-private payload inspection by the core adapter.
