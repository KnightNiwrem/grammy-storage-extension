# Implementation TODOs (spec gaps)

Spec changes approved in `spec.md` that the implementation in `src/` does not
yet reflect.

- [x] **Readonly `StorageEnvelope`** (spec §3)
  - Make all fields of `StorageEnvelope` in `src/envelope.ts` `readonly` to
    match the spec's public type contract.

- [x] **Error taxonomy** (spec §3, §6, §13)
  - Add `src/errors.ts` defining `ExtendedStorageError extends Error` with a
    `readonly code` field, the `EXTENDED_STORAGE_ERROR_CODES` constant object,
    and the `ExtendedStorageErrorCode` union type; export all three from
    `src/mod.ts`.
  - Replace every plain `Error` thrown by the adapter (construction validation,
    `assertValidEnvelope`, `JsonValueCodec`, write identity check, unknown-codec
    routing, depth guard) with `ExtendedStorageError` carrying the code listed
    in spec §13.
  - Codec-thrown errors and `JSON.parse` errors must continue to propagate
    unchanged.
  - Update tests to assert on `code` rather than message strings.

- [x] **Best-effort tombstone cleanup** (spec §10.4.6, §11)
  - In `decodeEnvelope` (`src/create-extended-storage.ts`), wrap the cleanup
    `storage.delete(keyToDeleteOnUndefined)` call so a delete failure does not
    propagate; the decode must still return `undefined`.
  - Add tests covering cleanup-delete failure on both the single-read path and
    bulk iteration paths.

- [x] **Configurable decode depth limit** (spec §4, §8, §10, §13)
  - Add `maxDecodeDepth?: number` to `CreateExtendedStorageOptions` in
    `src/create-extended-storage.ts`.
  - Validate at construction: if provided, it must be a positive integer,
    otherwise throw a construction validation error.
  - Default to `codecs.length + 16` and use the resolved value in
    `decodeEnvelope` instead of the fixed `MAX_DECODE_DEPTH`.
  - Decide the fate of the exported `MAX_DECODE_DEPTH` constant (the spec
    retains it for backward compatibility only; it no longer drives the
    default).
  - Update the depth-limit error message and add tests covering: the default
    heuristic, an explicit option value, invalid option values, and decode
    chains that legitimately reuse the same codec beyond the registered codec
    count.
