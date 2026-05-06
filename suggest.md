# Codex Implementation Request

Implement the non-spec codebase changes needed to align the repository with
`spec.md`.

Use `spec.md` as the source of truth for behavior. Do not add SemVer
enforcement. Do not add broad runtime validation for ordinary TypeScript codec
object shape. Runtime checks should protect storage-integrity boundaries, not
duplicate TypeScript.

## Goals

1. Clean up naming around the mandatory JSON value codec.
2. Freeze the installed codec set at construction time.
3. Reject empty and reserved codec identifiers.
4. Always expose `has` because it can be implemented through wrapped `read`.
5. Tighten public exports so only real public extension points are exported.
6. Update tests and docs to match the new behavior.

## Desired file structure

Refactor `src/` toward this structure:

```txt
src/
  codec.ts
  constants.ts
  create-extended-storage.ts
  envelope.ts
  json-value-codec.ts
  mod.ts
```

Required renames:

```txt
src/builtin-codec.ts   -> src/json-value-codec.ts
src/factory.ts         -> src/create-extended-storage.ts
src/codec-types.ts     -> src/codec.ts
```

Remove “builtin” from code-level names for the mandatory value codec. Prefer
names based on behavior.

## Constants

Rename constants as follows:

```ts
BUILTIN_VALUE_CODEC         -> VALUE_CODEC_ID
BUILTIN_VALUE_CODEC_VERSION -> VALUE_CODEC_VERSION
```

Keep:

```ts
STORAGE_ENVELOPE_KIND;
MAX_DECODE_DEPTH;
```

Expected constants:

```ts
export const STORAGE_ENVELOPE_KIND =
  "grammy-extended-storage-envelope" as const;
export const VALUE_CODEC_ID = "grammy-extended-storage-value" as const;
export const VALUE_CODEC_VERSION = "1.0.0" as const;
export const MAX_DECODE_DEPTH = 100 as const;
```

## JSON value codec

Rename:

```ts
BuiltinValueCodec -> JsonValueCodec
```

Move it to:

```txt
src/json-value-codec.ts
```

Keep the JSON semantics unchanged:

```ts
encode(value: T): StorageEnvelope {
  const payload = JSON.stringify(value);

  if (typeof payload !== "string") {
    throw new Error("Value cannot be encoded as a JSON storage envelope payload");
  }

  return {
    kind: STORAGE_ENVELOPE_KIND,
    codec: this.codec,
    version: this.version,
    payload,
  };
}
```

Do not export `JsonValueCodec` from `src/mod.ts`. It is internal.

## Codec types and public exports

Move codec-related types to `src/codec.ts`.

Keep these types available from `src/mod.ts`:

```ts
MaybePromise;
StorageEnvelopeCodec;
StorageEnvelope;
CreateExtendedStorageOptions;
```

Do not re-export `StorageValueCodec` from `src/mod.ts` unless the project
intentionally makes the value-codec layer public. It is fine for
`StorageValueCodec` to remain exported from `src/codec.ts` for internal
cross-file imports, but it should not be part of the package root API.

Update `src/mod.ts` to export from renamed files:

```ts
export {
  MAX_DECODE_DEPTH,
  STORAGE_ENVELOPE_KIND,
  VALUE_CODEC_ID,
  VALUE_CODEC_VERSION,
} from "./constants.ts";

export { assertValidEnvelope } from "./envelope.ts";
export type { StorageEnvelope } from "./envelope.ts";

export type { MaybePromise, StorageEnvelopeCodec } from "./codec.ts";

export { createExtendedStorage } from "./create-extended-storage.ts";
export type { CreateExtendedStorageOptions } from "./create-extended-storage.ts";
```

## Construction behavior

In `createExtendedStorage`, install codecs through a helper that snapshots
construction-time metadata.

Add an internal installed-codec representation:

```ts
type InstalledEnvelopeCodec = {
  readonly id: string;
  readonly version: string;
  readonly impl: StorageEnvelopeCodec;
};
```

Add an installation helper with this behavior:

1. Normalize omitted codecs to an empty array.
2. Snapshot the ordered codec set at construction time.
3. Snapshot each installed codec's `codec` and `version` values.
4. Reject empty codec identifiers.
5. Reject codec identifiers equal to `VALUE_CODEC_ID`.
6. Reject codec identifiers beginning with `grammy-extended-storage-`.
7. Reject duplicate codec identifiers.
8. Return both ordered installed codecs and a `Map` keyed by installed codec id.

Sketch:

```ts
function installCodecs(
  codecs: readonly StorageEnvelopeCodec[] = [],
): {
  readonly ordered: readonly InstalledEnvelopeCodec[];
  readonly byId: ReadonlyMap<string, InstalledEnvelopeCodec>;
} {
  const ordered: InstalledEnvelopeCodec[] = [];
  const byId = new Map<string, InstalledEnvelopeCodec>();

  for (const impl of codecs) {
    const id = impl.codec;

    if (id.length === 0) {
      throw new Error("Storage envelope codec id must be non-empty");
    }

    if (id === VALUE_CODEC_ID || id.startsWith("grammy-extended-storage-")) {
      throw new Error(`Reserved storage envelope codec id: ${id}`);
    }

    if (byId.has(id)) {
      throw new Error(`Duplicate storage envelope codec id: ${id}`);
    }

    const installed: InstalledEnvelopeCodec = {
      id,
      version: impl.version,
      impl,
    };

    ordered.push(installed);
    byId.set(id, installed);
  }

  return { ordered, byId };
}
```

Do not add runtime checks for missing `encode`, missing `decode`, or SemVer
shape.

## Write path

Update the write path to iterate over the installed codec snapshot, not the
caller-owned `options.codecs` array.

Before:

```ts
for (const codec of codecs) {
  envelope = await codec.encode(envelope);
  assertValidEnvelope(envelope);
  assertEncodeOutputIdentity(codec, envelope);
}
```

After:

```ts
for (const codec of installed.ordered) {
  envelope = await codec.impl.encode(envelope);
  assertValidEnvelope(envelope);
  assertEncodeOutputIdentity(codec, envelope);
}
```

Update identity checking to use construction-time metadata:

```ts
function assertEncodeOutputIdentity(
  codec: InstalledEnvelopeCodec,
  envelope: StorageEnvelope,
): void {
  const mismatchedFields: string[] = [];

  if (envelope.codec !== codec.id) {
    mismatchedFields.push("codec");
  }

  if (envelope.version !== codec.version) {
    mismatchedFields.push("version");
  }

  if (mismatchedFields.length > 0) {
    throw new Error(
      `Storage envelope codec "${codec.id}" encode output mismatched ${
        mismatchedFields.join(" and ")
      }`,
    );
  }
}
```

Keep the existing `value === undefined` deletion behavior.

## Read path

Update decode dispatch to use the installed map:

```ts
const codec = installed.byId.get(current.codec);

if (codec === undefined) {
  throw new Error(`Unknown storage envelope codec: ${current.codec}`);
}

const next = await codec.impl.decode(current);
```

Keep the maximum decode-depth guard.

Keep data-driven routing by `envelope.codec`.

Do not make read dispatch order-driven.

## `has`

Always expose `has` on the returned adapter.

Before:

```ts
if (typeof storage.has === "function") {
  adapter.has = async (key: string): Promise<boolean> =>
    (await read(key)) !== undefined;
}
```

After:

```ts
adapter.has = async (key: string): Promise<boolean> =>
  (await read(key)) !== undefined;
```

Do not forward backing `storage.has`.

## Optional bulk methods

Keep the existing strategy:

1. Prefer backing `readAllEntries` when available.
2. Fall back to backing `readAllKeys` for `readAllKeys` and `readAllEntries`.
3. Fall back to backing `readAllValues` for `readAllValues` when entries are
   unavailable.
4. Return async iterables from extended bulk methods.
5. Yield only decoded non-`undefined` values.

Preserve the known limitation: when deriving `readAllValues` from backing values
alone, keyless tombstones cannot be deleted because no key is available.

## Spec file and README

Replace `draft-spec.md` with `spec.md`.

Update README:

```txt
See [`spec.md`](./spec.md) for the full specification.
```

Add a short warning to README:

```md
> This adapter expects backing storage to contain `StorageEnvelope` values only.
> It does not automatically migrate raw legacy session values.
```

If `deno.json` excludes `draft-spec.md` from formatting, update that entry to
`spec.md` or remove the exclude if Deno formatting is acceptable for the new
spec.

## Tests to add or update

Add tests for construction-time codec installation:

1. Empty codec id is rejected.
2. Reserved codec id `VALUE_CODEC_ID` is rejected.
3. Reserved prefix `grammy-extended-storage-` is rejected.
4. Duplicate codec ids are rejected.
5. Mutating the caller-owned codec array after construction does not affect
   writes.
6. Encode output identity checks use construction-time `id` and `version`
   metadata.

Add or update tests for `has`:

1. The extended adapter exposes `has` even when the backing adapter does not
   expose `has`.
2. `has(key)` returns `true` only when wrapped `read(key)` returns a decoded
   value.
3. `has(key)` triggers the same logical-absence cleanup behavior as wrapped
   `read(key)`.

Add or update export tests if the project has export-surface tests:

1. `CreateExtendedStorageOptions` is exported from `src/mod.ts`.
2. `VALUE_CODEC_ID` and `VALUE_CODEC_VERSION` are exported from `src/mod.ts`.
3. `BUILTIN_VALUE_CODEC` and `BUILTIN_VALUE_CODEC_VERSION` are no longer
   exported.
4. `StorageValueCodec` is not exported from the package root unless
   intentionally made public.

Update existing tests and helpers to import from renamed files and renamed
constants.

If any test names currently duplicate IDs, fix the duplicate IDs while touching
the tests.

## Packaging cleanup

If the repository still declares MIT in `deno.json` but lacks a root `LICENSE`
file, add a standard MIT `LICENSE` file with the correct copyright holder.

Do not change the package name or version unless explicitly requested.

## Verification

Run:

```sh
deno task fmt_check
deno task lint
deno task check
deno task test
deno task publish_dry
```

All commands should pass.

## Non-goals for this implementation request

Do not implement raw legacy compatibility.

Do not make the JSON value codec configurable.

Do not add SemVer parsing or SemVer runtime enforcement.

Do not add generic schema validation for stored `T` values.

Do not add broad runtime validation for every property of caller-provided codec
objects.
