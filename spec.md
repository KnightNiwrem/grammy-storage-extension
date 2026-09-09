# grammy-storage-extension: Architectural & API Specification

An advanced, middleware-like session storage wrapper for the [grammY bot framework](https://grammy.dev/).

---

## 1. Overview & Architecture

`grammy-storage-extension` provides a layered session storage adapter (`StorageAdapter<T>`) built on top of an underlying raw storage engine (`StorageAdapter<SerializedEnvelope>`).

Instead of storing raw session objects directly in the database, this extension stores each session inside a structured envelope: a single serialized **body** plus an ordered list of **codec records** describing how that body was produced. A pipeline of user-supplied **body codecs** (compression, encryption, expiry tracking, …) operates on the body bytes as they flow into and out of storage. Each codec may attach plaintext **meta** to its record, and may expose a cheap **expiry check** that runs on the record alone, without touching the body.

Two envelope shapes appear in this design:

- **`Envelope`** (internal, not exported): the in-memory working form the pipeline operates on. Its `body` is a `Uint8Array` and it carries no `encoding` field — bytes need no encoding descriptor.
- **`SerializedEnvelope`** (exported, persisted): the wire form actually stored in the underlying database. Its `body` is a string, tagged by an `encoding` discriminant (`"utf8"` or `"base64"`).

**Responsibility boundary.** A codec never sees the envelope: `BodyCodec.encode` receives only the body bytes and returns an `EncodeResult` (`{ body, meta }`). The **adapter** owns the `Envelope → Envelope` transition — it replaces the body with the codec's output bytes and appends a `CodecRecord` built from the codec's `id`/`version` and the returned `meta`. So the pipeline advances the envelope one codec at a time, but each codec's own contract is purely body-in → body-out:

```text
BodyCodec:  Envelope.body ──► EncodeResult { body, meta }
Adapter:    Envelope ──► Envelope   (replaces body, appends CodecRecord)
```

On write, the adapter assembles an `Envelope` by driving the codecs in this way, then serializes it to a `SerializedEnvelope`. On read, the stored `SerializedEnvelope` is deserialized back into an `Envelope`, and the adapter unwinds it by calling each codec's `decode` in reverse.

### 1.1 Write Pipeline

The session state is serialized to JSON, converted to bytes, and passed through the codecs **in declaration order**. Each codec's output body feeds the next, and each codec's record is appended to the envelope's `codecs` list:

```
Raw Session State (T)
         │
         ▼   JSON.stringify → UTF-8 bytes
 ┌───────────────┐
 │   Codec A     │  <-- e.g. gzip: body ← compressed, record {id:"gzip", meta:{…}}
 └───────────────┘
         │
         ▼
 ┌───────────────┐
 │   Codec B     │  <-- e.g. ttl: body unchanged, record {id:"ttl", meta:{expiresAt}}
 └───────────────┘
         │
         ▼   base64
 ┌───────────────┐
 │  Raw Storage  │  <-- { codecs: [A, B], encoding: "base64", body }
 └───────────────┘
```

### 1.2 Read Pipeline

Reading is **record-driven**: the adapter walks the envelope's stored `codecs` list, not the configured list. It runs in two passes:

1. **Expiry pass** (cheap): every recorded codec that exposes `isExpired` is asked, in recorded order, whether its record marks the entry as expired. If any says yes, the entry is deleted and treated as absent. The body is never touched.
2. **Body pass** (expensive): only if the entry is live, the body is decoded and the codecs are undone **in reverse recorded order**, then the resulting UTF-8 JSON is parsed.

```
                  ┌───────────────┐
                  │  Raw Storage  │
                  └───────────────┘
                          │
                          ▼   assertValidSerializedEnvelope
                  ┌───────────────┐
                  │  Expiry pass  │  <-- A.isExpired?(recA), B.isExpired?(recB) …
                  └───────────────┘
            ┌─────────────┴─────────────┐
            ▼ (any true)                ▼ (none true)
   [storage.delete(key)]        ┌───────────────┐
   return undefined             │    Codec B     │  <-- decode(body, recB)
                                └───────────────┘
                                        │
                                        ▼
                                ┌───────────────┐
                                │    Codec A     │  <-- decode(body, recA)
                                └───────────────┘
                                        │
                                        ▼   UTF-8 → JSON.parse
                                 Return state T
```

`has(key)` and `readAllKeys()` stop after the expiry pass, so they never pay for decompression or decryption.

> [!IMPORTANT]
> **No Legacy Compatibility**: This specification does **not** provide fallback parsing for raw, unwrapped legacy database entries. Any pre-existing database contents must be migrated to `SerializedEnvelope` format before activating this adapter.

---

## 2. Core Domain Concepts

| Concept | Description |
| :--- | :--- |
| **Layered Adapter** | The `StorageAdapter<T>` returned by `createExtendedStorage` that wraps the underlying storage. |
| **Underlying Storage** | The physical database adapter (e.g., Redis, MongoDB, Memory) that reads and writes `SerializedEnvelope` objects. |
| **Envelope** | The in-memory working form (internal): a body as bytes plus the ordered codec records. The codec pipeline operates on this shape. |
| **Serialized Envelope** | The standardized JSON transport object stored in the underlying database: a body string, its encoding, and the ordered codec records. |
| **Body** | The session state as bytes: UTF-8 JSON before any codec, arbitrary bytes after. |
| **Body Codec** | A plugin (`BodyCodec`) that rewrites the body bytes on write (`encode`) and restores them on read (`decode`), optionally attaching meta and an expiry check. |
| **Body Decoder** | The read-side half of a codec (`BodyDecoder`): `id`, `decode`, and optionally `isExpired`. A `BodyCodec` is also a `BodyDecoder`. |
| **Codec Record** | The `{ id, version, meta }` entry the adapter appends to the envelope for each applied codec. |
| **Expiry (Implicit Deletion)** | A codec's `isExpired(record)` returning `true`, which makes the adapter delete the entry and treat it as absent without decoding the body. |
| **Discriminator** | The fixed marker (`ENVELOPE_DISCRIMINATOR`) stored on every serialized envelope, identifying it as owned by this plugin and distinguishing it from a raw user session shape. |

---

## 3. Public API Contracts

The types and functions below are the exported surface a library user consumes. The internal `Envelope` (bytes-body working form, §1) is intentionally **not** exported; it is documented here for spec completeness only:

```typescript
/**
 * Internal, in-flight working form. NOT exported. The adapter builds one on
 * write (driving the codecs, §9) and reconstructs one on read (§10) from the
 * stored `SerializedEnvelope`. Its `body` is raw bytes, so it needs no
 * `encoding` field — that concern belongs only to the serialized form.
 */
type Envelope = {
  readonly discriminator: typeof ENVELOPE_DISCRIMINATOR;
  readonly version: string;
  readonly codecs: readonly CodecRecord[];
  readonly body: Uint8Array;
};
```

```typescript
import type { StorageAdapter } from "grammy";

export type MaybePromise<T> = T | Promise<T>;

/** How the serialized envelope `body` string encodes the underlying bytes. */
export type StorageBodyEncoding = "utf8" | "base64";

/** One entry in the ordered list of codecs applied to an envelope body. */
export type CodecRecord = {
  readonly id: string;
  readonly version: string;
  readonly meta: Readonly<Record<string, unknown>>;
};

/**
 * The standardized container stored physically in the database.
 */
export type SerializedEnvelope = {
  /** Marks this object as owned by the plugin (see §4). */
  readonly discriminator: typeof ENVELOPE_DISCRIMINATOR;
  /** The package version that wrote this envelope (see §4). */
  readonly version: string;
  /** Records of the codecs applied, in application order. */
  readonly codecs: readonly CodecRecord[];
  readonly encoding: StorageBodyEncoding;
  readonly body: string;
};

/** The result of a codec's `encode` step. */
export type EncodeResult = {
  readonly body: Uint8Array;
  /** Plaintext, JSON-serializable metadata. Defaults to `{}`. */
  readonly meta?: Record<string, unknown>;
};

/**
 * The read-side half of a codec: enough to decode and expire records of its id.
 * Register one via `decoders` to keep reading rows produced by a
 * codec that is no longer applied on write (see §7.6).
 */
export interface BodyDecoder {
  /** A unique identifier representing this codec family (e.g., "aes-gcm"). */
  readonly id: string;

  /** Restores the body bytes on read, given the record written for this codec. */
  decode(
    body: Uint8Array,
    record: CodecRecord,
  ): MaybePromise<Uint8Array>;

  /**
   * Cheap expiry check based solely on the recorded metadata.
   * Returning `true` marks the whole entry as expired.
   */
  isExpired?(record: CodecRecord): MaybePromise<boolean>;
}

/**
 * Interface implemented by codec plugins (e.g., encryption, compression, expiry),
 * applied on write and undone on read.
 */
export interface BodyCodec extends BodyDecoder {
  /** The current version of the format produced by `encode` (e.g., "1.0.0"). */
  readonly version: string;

  /** Rewrites the body bytes on write and optionally attaches meta. */
  encode(body: Uint8Array): MaybePromise<EncodeResult>;
}

/**
 * Runtime invariant guard for serialized-envelope-shaped values (see §6).
 */
export function assertValidSerializedEnvelope(
  value: unknown,
): asserts value is SerializedEnvelope;

/**
 * Base class for all errors raised by the adapter itself.
 * Errors thrown by codecs, by base64 decoding, by UTF-8 decoding, or by `JSON.parse` propagate unchanged.
 */
export class ExtendedStorageError extends Error {
  readonly code: ExtendedStorageErrorCode;
}

export type ExtendedStorageErrorCode =
  (typeof EXTENDED_STORAGE_ERROR_CODES)[keyof typeof EXTENDED_STORAGE_ERROR_CODES];

export const EXTENDED_STORAGE_ERROR_CODES = {
  INVALID_CODEC_ID: "ERR_INVALID_CODEC_ID",
  DUPLICATE_CODEC_ID: "ERR_DUPLICATE_CODEC_ID",
  VALUE_SERIALIZATION: "ERR_VALUE_SERIALIZATION",
  INVALID_ENVELOPE: "ERR_INVALID_ENVELOPE",
  INVALID_CODEC_OUTPUT: "ERR_INVALID_CODEC_OUTPUT",
  UNKNOWN_CODEC: "ERR_UNKNOWN_CODEC",
} as const;

export type CreateExtendedStorageOptions = {
  /** The physical database adapter to read/write serialized envelopes. */
  storage: StorageAdapter<SerializedEnvelope>;

  /** Optional ordered array of body codecs applied on write. */
  codecs?: readonly BodyCodec[];

  /** Optional decoders registered only for reading; never applied on write. */
  decoders?: readonly BodyDecoder[];
};

export function createExtendedStorage<T>(
  options: CreateExtendedStorageOptions,
): StorageAdapter<T>;
```

### 3.1 Serialization Constraints
Body serialization is internal and mandatory: the body is always `JSON.stringify(value)` encoded as UTF-8 before the first codec. Custom value serializers (e.g. MessagePack) are not supported unless the public factory API is extended to expose them.

---

## 4. Spec Constants & Reserved Identifiers

The following constants are exported by the implementation:

```typescript
export const ENVELOPE_DISCRIMINATOR = "grammy-storage-extension" as const;
export const PACKAGE_VERSION = "<version from deno.json>" as const;
```

`ENVELOPE_DISCRIMINATOR` is the plugin's ownership marker. It is written into every serialized envelope's `discriminator` field and identifies the object as created and managed by this plugin — distinguishing it from a raw user session object that coincidentally shares the same field layout. Its value, `"grammy-storage-extension"`, is exactly the package name (see `deno.json`), so provenance is unmistakable to anyone inspecting the database. The field name `discriminator` is deliberately uncommon to reduce the chance of colliding with a user-defined session shape; collision safety comes from both the field name and its value.

`PACKAGE_VERSION` MUST equal the `version` field in `deno.json`; the test suite enforces this. Every envelope written carries it in `version`, so an envelope found in the database identifies the exact release that produced it. The adapter does not currently gate reads on `version`; future releases that change the format may branch on it.

### 4.1 Codec Id Constraints
User-supplied `BodyCodec` and `BodyDecoder` objects must adhere to the following naming rule:
1. **Non-empty string identifier**: `id` MUST be a primitive `string` of length ≥ 1. A non-string value (including `null`, `undefined`, a number, a boolean, an array, or an object) or an empty string is invalid. The guard is `typeof id === "string" && id.length > 0`; anything else throws `ERR_INVALID_CODEC_ID`.

This is a value check, not merely a length check: a length-only test would throw a raw native `TypeError` on `null`/`undefined` and would let a non-string `id` into the registry, from which it could be written into a `CodecRecord` and produce an envelope the adapter itself later rejects on read (§6).

> [!TIP]
> Codec ids should be globally namespaced to prevent collisions (e.g. `npm:@my-org/codec-aes-gcm` or `jsr:@my-org/codec-lz4`).

---

## 5. Body Serialization & Encoding

### 5.1 Serialization
For any defined session value `value: T`:
- The adapter MUST serialize it with `JSON.stringify(value)`.
- If stringification throws or produces a non-string (e.g. for a function or `undefined`), the adapter MUST throw `ERR_VALUE_SERIALIZATION` and MUST NOT write.
- **Top-Level `undefined` Special Case**: the adapter MUST intercept top-level `undefined` session writes, treating them as deletion requests (delegated directly to `storage.delete(key)`), bypassing the pipeline.

### 5.2 Encoding Rule
The `encoding` field records how `body` encodes the final bytes:
- **Zero codecs**: `encoding` is `"utf8"` and `body` is the JSON text itself. Rows stay human-readable in the database and no byte round trip is performed.
- **One or more codecs**: `encoding` is `"base64"` and `body` is the standard base64 encoding of the last codec's output bytes.

On read the adapter honours the stored `encoding` field regardless of the number of records, so a serialized envelope is always self-describing. A `base64` body that is not valid base64 makes the underlying decoder throw a native error (`TypeError` for an invalid character, `RangeError` for an invalid length), which propagates unchanged.

### 5.3 Deserialization
After the body pass (§10), the adapter decodes the bytes as UTF-8 in fatal mode and returns `JSON.parse(text) as T`. Native UTF-8 decoding errors and JSON parsing errors propagate unchanged.

### 5.4 Rich Types Limitation
Because serialization relies on standard JSON:
- Sessions must be JSON-serializable.
- Rich JS classes and types (`Date`, `Map`, `Set`, `bigint`, cyclic graphs, functions, and symbols) are **not preserved** and will be degraded or raise serialization exceptions.

---

## 6. Runtime Invariant Validations

To protect storage integrity, the adapter MUST validate every serialized envelope read from storage with `assertValidSerializedEnvelope(value)`, which requires:
1. The value is a non-null `object` and not an array.
2. `discriminator` matches `ENVELOPE_DISCRIMINATOR` exactly.
3. `version` is a string.
4. `codecs` is an array, and every element is a non-null, non-array object with a non-empty string `id`, a string `version`, and a `meta` that is a non-null, non-array object.
5. `encoding` is exactly `"utf8"` or `"base64"`.
6. `body` is a string.

Failure to satisfy any of these conditions MUST throw an `ExtendedStorageError` with code `ERR_INVALID_ENVELOPE`.

A serialized envelope MAY carry additional properties beyond the required ones; the adapter ignores unknown properties.

---

## 7. Codec Contract

### 7.1 `id` property
Acts as the identifier for the codec family. It must remain stable across different versions of the format.

### 7.2 `version` property
Represents the format version produced by `encode()`. The adapter treats this as an opaque string and copies it into the record verbatim, but codec authors should use semantic versioning (SemVer) to manage format transitions.

### 7.3 `encode(body)`
- **Input**: The current body bytes (`Uint8Array`).
- **Output**: `{ body: Uint8Array, meta?: Record<string, unknown> }` (an `EncodeResult`).
- **Rules**:
  - `body` MUST be a `Uint8Array`. `meta`, if present, MUST be a non-null, non-array object; a missing `meta` is recorded as `{}`. Any other output makes the adapter throw `ERR_INVALID_CODEC_OUTPUT` before writing.
  - `meta` MUST be JSON-serializable, since it is stored verbatim in the envelope. The adapter cannot verify this; it is a trust-based contract like round-trip fidelity.
  - `meta` is stored **in plaintext**, outside whatever the body codecs do. It is neither encrypted nor authenticated by the adapter, and anyone with database access can read or edit it. Do not put secrets in `meta`, and do not rely on it for tamper resistance.
  - A codec MAY leave the body unchanged and only attach `meta` (e.g. an expiry codec).

### 7.4 `decode(body, record)`
- **Input**: The body bytes as produced by this codec's `encode` (or by a later codec's `decode`), plus the `CodecRecord` stored for this codec. The record carries the `version` and `meta` written at encode time, which may be older than the codec's current `version`.
- **Output**: The restored body bytes (`Uint8Array`).
- **Rules**:
  - `decode` is responsible for handling historical version backward compatibility, using `record.version`.
  - It MUST throw if the body cannot be decrypted, decompressed, or otherwise restored, or if `record.version` is unsupported.
  - It MUST NOT be used to signal expiry: a non-`Uint8Array` return makes the adapter throw `ERR_INVALID_CODEC_OUTPUT`.

### 7.5 `isExpired(record)` (optional)
- **Input**: The `CodecRecord` stored for this codec.
- **Output**: `true` if the entry should be treated as expired, `false` otherwise.
- **Rules**:
  - The check MUST derive its answer from the record alone (typically `record.meta`); the body is not available and is never decoded before the check.
  - Returning `true` from any codec expires the whole entry (§10, §11).
  - Errors thrown by `isExpired` propagate unchanged and do not delete the entry.
  - Anything that must influence expiry (e.g. a body-derived value) must be materialised into `meta` at encode time.

### 7.6 Read-only decoders
`decoders` registers codecs for the read side only. A read-only decoder needs just `id`, `decode`, and optionally `isExpired` (i.e. the `BodyDecoder` interface); a full `BodyCodec` is structurally acceptable too, but its `encode` and `version` are ignored.

- Decoders are **never** applied on write and never appear in new records.
- They participate fully in the read pipeline (§10): resolution, the expiry pass, and the body pass treat them exactly like write codecs.
- Their `id` must satisfy §4.1 and must be unique across **both** lists; an id present in `codecs` and `decoders` is rejected with `ERR_DUPLICATE_CODEC_ID`.

**Retiring a format**: move the codec from `codecs` to `decoders`. New writes stop producing its records while existing rows remain readable. Each row is rewritten in the current format on its next `write`. Once no rows reference the id, remove it from `decoders`; any remaining row would then fail with `ERR_UNKNOWN_CODEC`.

### 7.7 Layer Ordering & Size Considerations

> [!TIP]
> **Ordering matters semantically, not mechanically.** The adapter applies codecs in declaration order regardless of what they do, but some orders defeat their purpose: compression must come **before** encryption, because encrypted (high-entropy) data does not compress. In §1.1's example terms, Codec A is compression for exactly this reason.

> [!NOTE]
> **Size**: the body is stored once, as a single string, regardless of how many codecs are applied; records add only their `id`, `version`, and `meta`. Base64 encoding costs roughly 33% over the raw bytes whenever at least one codec is configured.

---

## 8. Construction & Initialization

When calling `createExtendedStorage(options)`:
1. **Normalisation**: If `options.codecs` or `options.decoders` is missing, default it to an empty list.
2. **Validation**: Check each codec's `id`, across both lists, against the rule in §4.1 — it MUST be a primitive non-empty string (`ERR_INVALID_CODEC_ID`).
3. **Uniqueness**: Ensure that no two codecs across both lists share the same `id` (`ERR_DUPLICATE_CODEC_ID`).
4. **Registry**: The **write pipeline** is `codecs` in declaration order. The **read registry** is the union of `codecs` and `decoders`, keyed by `id`.
5. **Immutability**: Both sets are fixed at construction time. Subsequent mutation of the source options arrays MUST NOT alter the adapter's behavior.

---

## 9. Write Pipeline Flow

When the bot writes session data via `write(key, value)`:

1. **Delete Interception**: If `value === undefined`, invoke `storage.delete(key)` and return immediately.
2. **Serialization**: Produce the JSON text per §5.1.
3. **Zero-Codec Shortcut**: If no codecs are configured, write the `utf8` serialized envelope per §5.2 and return.
4. **Codec Application**: Encode the text as UTF-8 bytes. For each codec in **declaration order**:
   1. Invoke `codec.encode(currentBytes)`.
   2. Validate the output per §7.3.
   3. Append `{ id: codec.id, version: codec.version, meta: output.meta ?? {} }` to the record list.
   4. Set `currentBytes` to `output.body`.
5. **Physical Storage**: Write `{ discriminator: ENVELOPE_DISCRIMINATOR, version: PACKAGE_VERSION, codecs: records, encoding: "base64", body: base64(currentBytes) }` via `storage.write(key, serializedEnvelope)`.

Any error in steps 2–4 propagates and no write occurs.

---

## 10. Read & Decoding Pipeline Flow

When the bot requests session data via `read(key)`:

1. **Physical Read**: Fetch the entry from underlying storage.
2. **Miss Handling**: If the database returns `undefined`, return `undefined` immediately.
3. **Validation**: Run `assertValidSerializedEnvelope` on the retrieved value.
4. **Codec Resolution**: For every record in `envelope.codecs`, look up the codec with the same `id` in the read registry (§8, which includes `decoders`). If any is missing, throw `ERR_UNKNOWN_CODEC` naming the id. Resolution completes before any expiry check runs.
5. **Expiry Pass**: For each resolved record in **recorded order**, if the codec defines `isExpired`, await `isExpired(record)`. On the first `true`:
   1. Trigger a best-effort cleanup: `await storage.delete(key)`. If the delete fails, the error MUST NOT propagate.
   2. Return `undefined` to the caller without decoding the body.
6. **Body Pass**: Decode `body` according to `encoding` (§5.2); base64 decoding errors propagate unchanged. For each resolved record in **reverse recorded order**, set `currentBytes = await codec.decode(currentBytes, record)`, throwing `ERR_INVALID_CODEC_OUTPUT` if the result is not a `Uint8Array`.
7. **Deserialization**: Return the value per §5.3.

> [!NOTE]
> **Record-Driven Routing**: Because decoding follows the records stored in the envelope, changing the order of `codecs` in the options does not break the ability to read pre-existing data, as long as all required codecs remain registered. Each record is decoded exactly once, so no depth limit is needed.

---

## 11. Deletion & Expiry

```
               Direct Delete
            ───────────────────►  [storage.delete(key)]


            Implicit Delete (during the expiry pass)
            [isExpired(record)] ───► returns true
                                        │
                                        ▼
                              [storage.delete(key)]
```

- **Direct Deletion**: `delete(key)` bypasses the pipeline and invokes the underlying storage's `delete` method directly.
- **Implicit Cleanup**: When a codec reports an entry as expired, the adapter automatically executes a cleanup delete for that key. This applies to **every** path where the key is known — `read(key)`, `has(key)`, and bulk iteration in §12 — not only the single-read flow. The sole exception is keyless value iteration (`readAllValues` derived from underlying `readAllValues`, see §12.3), where the key is unavailable and no cleanup is possible. Cleanup is best-effort: failures of the cleanup delete MUST NOT propagate or alter the outcome.

---

## 12. Optional Adapter Capabilities

If the underlying storage supports bulk capabilities, the layered adapter selectively exposes them if they can be implemented soundly.

> [!NOTE]
> grammY's `StorageAdapter<T>` declares `has`, `readAllKeys`, `readAllValues`, and `readAllEntries` as **optional** members, and the adapter returned here satisfies that type. `has` is always present. The bulk methods are present only under the conditions below, so TypeScript consumers must check for presence before calling them; no cast is needed.

### 12.1 `has(key)`
- Always attached to the adapter at runtime.
- Implemented as §10 steps 1–5: read the serialized envelope, validate it, resolve its codecs, and run the expiry pass. Returns `false` for a missing or expired entry (performing cleanup for the latter) and `true` otherwise. **The body is never decoded.**
- It must **not** forward to the underlying storage's `.has()` method, which cannot run the expiry pass.
- Because `has` skips the body pass, it does not detect a corrupt body; a subsequent `read` may still throw.

### 12.2 `readAllKeys()`
Exposed if the underlying storage implements `readAllEntries` or `readAllKeys`.
- Yields only keys whose entries validate and are not expired. Bodies are never decoded.
- If the underlying storage implements `readAllEntries()`, it iterates the entries and runs §10 steps 3–5 on each serialized envelope.
- Otherwise, it falls back to iterating backing keys and calling `has(key)` for each.
- Iteration performs implicit cleanup (§11) for expired keys encountered along the way.

### 12.3 `readAllValues()`
Exposed if the underlying storage implements `readAllEntries`, `readAllValues`, or `readAllKeys`, preferred in that order.
- Yields only fully decoded session values of type `T`, skipping expired entries.
- From entries: decodes each serialized envelope with its key, performing implicit cleanup (§11).
- From values: decodes each serialized envelope without a key.
  **Caveat**: on this path the adapter cannot delete expired entries from the underlying database because the keys are unavailable. This is the only path without implicit cleanup (§11).
- From keys: iterates backing keys and executes a full `read(key)` for each, performing implicit cleanup.

### 12.4 `readAllEntries()`
Exposed if the underlying storage implements `readAllEntries` or `readAllKeys`.
- Yields `[key, T]` pairs for live entries.
- Prefers iterating entries, but falls back to iterating keys and fetching each key.
- Iteration performs implicit cleanup (§11) for expired keys encountered along the way.

### 12.5 Error Semantics
Bulk iteration is **fail-fast**: if any entry fails serialized-envelope validation, references an unregistered codec, or a codec's `isExpired` or `decode` throws, the error propagates and the stream terminates — identical semantics to a single `read(key)`. Entries are never skipped or quarantined; one corrupt row fails the entire bulk operation.

Callers needing resilience must iterate the **underlying** storage's `readAllKeys()` and call the wrapper's `read(key)` per key inside their own error handling. The wrapper's own `readAllKeys()` is not suitable for recovery: it validates every serialized envelope before yielding its key, so it terminates on the corrupt row before the caller sees that key.

---

## 13. Error Reference Matrix

The adapter guarantees that errors are thrown under the following circumstances. All adapter-raised errors are instances of `ExtendedStorageError` carrying the listed `code`; errors thrown by codecs, by base64 decoding, by UTF-8 decoding, and by `JSON.parse` propagate unchanged.

| Phase | Failure Trigger | Thrown Error |
| :--- | :--- | :--- |
| **Construction** | A codec id is not a primitive non-empty string. | `ERR_INVALID_CODEC_ID` |
| **Construction** | Two codecs declare the identical id. | `ERR_DUPLICATE_CODEC_ID` |
| **Runtime Write** | `JSON.stringify` throws or produces a non-string. | `ERR_VALUE_SERIALIZATION` |
| **Runtime Write** | A codec's `encode` output fails §7.3 shape rules. | `ERR_INVALID_CODEC_OUTPUT` |
| **Runtime Write** | A codec's `encode` throws. | The codec's own error, propagated unchanged. |
| **Runtime Read** | Database returns a value failing serialized-envelope invariants. | `ERR_INVALID_ENVELOPE` |
| **Runtime Read** | A recorded codec id is not registered. | `ERR_UNKNOWN_CODEC` |
| **Runtime Read** | A codec's `isExpired` throws. | The codec's own error, propagated unchanged. |
| **Runtime Read** | A codec's `decode` returns a non-`Uint8Array`. | `ERR_INVALID_CODEC_OUTPUT` |
| **Runtime Read** | A codec's `decode` throws. | The codec's own error, propagated unchanged. |
| **Runtime Read** | `encoding` is `base64` but `body` is not valid base64. | Native `TypeError` or `RangeError`, propagated unchanged. |
| **Runtime Read** | Final bytes are not valid UTF-8. | Native `TypeError`, propagated unchanged. |
| **Runtime Read** | JSON parsing of the final text fails. | Native parse error, propagated unchanged. |

---

## 14. Non-Goals

This specification does **not** mandate or cover:
- Semantic Versioning (SemVer) format validation by the adapter.
- Custom validation schemas for the user session type `T`.
- Transparent support for legacy raw database values (migration is the caller's responsibility).
- Replacement of the JSON body serialization with other serialization systems.
- Verification that codec `meta` is JSON-serializable, or that `encode`/`decode` round-trip.
- Confidentiality or integrity of codec `meta`; it is plaintext by design so that expiry checks stay cheap.
- Body inspection by the core adapter.
