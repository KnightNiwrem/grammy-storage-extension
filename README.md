# grammY Storage Extended

`@grammyjs/storage-extended` wraps any grammY
[`StorageAdapter`](https://grammy.dev/plugins/session) so that session values
are stored inside validated **envelopes**. On write it runs an ordered list of
body **transforms** (compression, encryption, expiry, …); on read it undoes them
using the records saved in each envelope. The wrapper keeps grammY's
`StorageAdapter<T>` shape, so it drops straight into `session({ storage })`.

Transforms can attach plaintext metadata and a cheap `isExpired` check that runs
without decoding the body, so `has` and `readAllKeys` never pay for
decompression or decryption.

- **Using the plugin?** Start at [Install](#install) and
  [Quick start](#quick-start), then read
  [Configuring transforms](#configuring-transforms) and
  [Operational behavior](#operational-behavior). You do not need to write a
  transform.
- **Writing a transform (codec author)?** Jump to
  [Authoring a transform](#authoring-a-transform).
- **Need the full contract?** See [`spec.md`](./spec.md); each section below
  links into it.

## Status

Pre-1.0 and **not yet published to a registry**. The public API (`spec.md` §3)
and the stored envelope format may still change without a migration path until
the version in [`deno.json`](./deno.json) reaches `1.0.0`. Until it is
published, depend on it by Git URL or a local path rather than the `jsr:`
specifier below.

Written for and tested on **Deno** (CI runs Deno `v2.x`). It has no
Node-specific dependencies, but Node/Bun compatibility is not yet part of the
test matrix.

## Install

> Once published, install from [JSR](https://jsr.io/):
>
> ```sh
> deno add jsr:@grammyjs/storage-extended   # Deno
> npx jsr add @grammyjs/storage-extended     # Node / Bun
> ```

All examples below import from `@grammyjs/storage-extended`; map that specifier
to your install method (JSR once published, otherwise a Git URL or local path).

## Quick start

You do not have to write a transform to use the wrapper. With an empty transform
list it just wraps your session values in envelopes and stores them as-is.

```ts
import { Bot, type Context, session, type SessionFlavor } from "grammy";
import { MemorySessionStorage } from "grammy";
import {
  createExtendedStorage,
  type StorageEnvelope,
} from "@grammyjs/storage-extended";

interface SessionData {
  count: number;
}
type MyContext = Context & SessionFlavor<SessionData>;

// The backing adapter stores StorageEnvelope values — swap MemorySessionStorage
// for any grammY storage adapter (Redis, MongoDB, Deno KV, …).
// MemorySessionStorage is for demonstration only: it keeps everything in
// process memory and loses all contents when the process restarts. Use a
// persistent adapter in production.
const backing = new MemorySessionStorage<StorageEnvelope>();

const storage = createExtendedStorage<SessionData>({
  storage: backing,
  transforms: [], // no transforms yet: values are wrapped but otherwise unchanged
});

const bot = new Bot<MyContext>(""); // <-- your bot token
bot.use(session({ initial: (): SessionData => ({ count: 0 }), storage }));

bot.on("message", (ctx) => {
  ctx.session.count++;
  return ctx.reply(`Seen ${ctx.session.count} messages.`);
});

bot.start();
```

The type parameter on `createExtendedStorage<SessionData>` must match your
session type; the returned adapter is a `StorageAdapter<SessionData>`.

## Configuring transforms

Transforms are what make this wrapper useful: each one rewrites the body on
write and restores it on read. You add behavior by listing transforms; the
wrapper applies them **in declaration order** on write and reverses them on
read. A transform may also just attach metadata (e.g. an expiry timestamp) and
leave the body untouched.

Here a time-to-live transform stamps each write with an expiry and reports the
entry as expired once that time passes. It is metadata-only — the body is never
rewritten:

```ts
import { MemorySessionStorage } from "grammy";
import {
  createExtendedStorage,
  type StorageEnvelope,
  type StorageTransform,
} from "@grammyjs/storage-extended";

function ttl(ttlMilliseconds: number): StorageTransform {
  if (!Number.isFinite(ttlMilliseconds) || ttlMilliseconds <= 0) {
    throw new RangeError(
      `ttl requires a positive duration, got ${ttlMilliseconds}`,
    );
  }
  return {
    kind: "example:ttl",
    version: "1.0.0",
    encode: (body) => ({
      body,
      meta: { expiresAt: Date.now() + ttlMilliseconds },
    }),
    decode: (body) => body,
    // Reads the plaintext meta only; the body is never decoded for this check.
    isExpired: (record) => {
      const expiresAtMilliseconds = record.meta.expiresAt;
      // Malformed stored metadata must not silently pass as a live entry.
      if (!Number.isFinite(expiresAtMilliseconds)) {
        throw new Error(
          `${record.kind}: invalid meta.expiresAt ${
            JSON.stringify(expiresAtMilliseconds)
          }`,
        );
      }
      return Date.now() >= (expiresAtMilliseconds as number);
    },
  };
}

const backing = new MemorySessionStorage<StorageEnvelope>();
const storage = createExtendedStorage<{ count: number }>({
  storage: backing,
  transforms: [ttl(60_000)],
});

await storage.write("chat:1", { count: 1 });
console.log(await storage.read("chat:1")); // { count: 1 }
// ...more than 60s later, or after the clock passes expiresAt:
console.log(await storage.read("chat:1")); // undefined (and the row is deleted)
```

### Ordering

Order is semantic, not cosmetic. When you combine transforms that change the
body, compression must come **before** encryption, because encrypted
(high-entropy) data does not compress. This snippet is conceptual — `gzip()` is
the [worked example below](#worked-example-gzip-compression), and
`encrypt`/`key` stand in for an encryption transform you supply:

```ts
const storage = createExtendedStorage<SessionData>({
  storage: backing,
  transforms: [gzip(), encrypt(key)], // compress, then encrypt
});
```

See [`spec.md` §7.7](./spec.md#77-layer-ordering--size-considerations) for the
full ordering and size discussion.

### Retiring a transform without breaking old rows

The read pipeline is driven by the records saved in each envelope, not by your
current `transforms` list. To stop applying a transform while keeping
already-stored rows readable, move it to `readOnlyTransforms`. Existing rows are
rewritten without it on their next `write`.

Suppose you have been writing rows with the
[gzip transform](#worked-example-gzip-compression) and want to stop compressing
new writes. Before, gzip is in `transforms`:

```ts
import { gzip } from "./gzip.ts"; // the worked example below

const storage = createExtendedStorage<SessionData>({
  storage: backing,
  transforms: [ttl(60_000), gzip()],
});
```

After, gzip moves to `readOnlyTransforms` so old compressed rows still decode
while new writes skip compression. The transform's `kind` must match the one in
the stored rows, so reuse the same `gzip()`:

```ts
import { gzip } from "./gzip.ts";

const storage = createExtendedStorage<SessionData>({
  storage: backing,
  transforms: [ttl(60_000)], // no longer compressing new writes
  readOnlyTransforms: [gzip()], // still decodes previously compressed rows
});
```

Once no stored row still references that `kind`, drop it from
`readOnlyTransforms`. A row that still references a kind registered in neither
list fails its read with `ERR_UNKNOWN_TRANSFORM`. See
[`spec.md` §7.6](./spec.md#76-read-only-transforms).

Transform kinds must be unique **across both lists**: a `kind` cannot appear
twice, whether within `transforms`, within `readOnlyTransforms`, or once in
each. Registering the same kind in both throws `ERR_DUPLICATE_TRANSFORM_KIND` at
construction — so when you retire a transform, move it from `transforms` to
`readOnlyTransforms` rather than adding it to both.

## Operational behavior

Know these before you deploy:

- **JSON only.** Session values are serialized with `JSON.stringify`. `Date`,
  `Map`, `Set`, `bigint`, cyclic graphs, functions, and symbols are **not**
  preserved — they are degraded or raise `ERR_VALUE_SERIALIZATION` on write.
  Writing a top-level `undefined` deletes the key.
  ([`spec.md` §5](./spec.md#5-body-serialization--encoding))

- **Lazy expiry.** An expired entry is not swept in the background. It is
  detected and deleted the next time it is touched — `read`, `has`, or a bulk
  read that knows the key. Until then it still occupies space in the backing
  store. The one path that cannot delete is keyless value iteration
  (`readAllValues` derived from a backing `readAllValues`), where the key is
  unavailable. The cleanup delete is **best-effort**: a failed delete is
  swallowed, so an entry can remain physically stored while the wrapper already
  treats it as absent. ([`spec.md` §11](./spec.md#11-deletion--expiry))

- **Metadata is plaintext.** A transform's `meta` (including any `expiresAt`) is
  stored unencrypted and unauthenticated, outside whatever the body transforms
  do. Anyone with database access can read or edit it. Never put secrets in
  `meta`. ([`spec.md` §7.3](./spec.md#73-encodebody))

- **Optional bulk methods.** `has` is always present. `readAllKeys`,
  `readAllValues`, and `readAllEntries` are each exposed **only** when the
  backing adapter supplies a capability the wrapper can derive them from — which
  may be a different backing method than the same-named one. This mirrors
  grammY's optional `StorageAdapter<T>` members, so check for presence before
  calling:

  | Returned method  | Required backing capability                             |
  | ---------------- | ------------------------------------------------------- |
  | `has`            | Basic `read` is sufficient; always attached at runtime. |
  | `readAllKeys`    | `readAllEntries` or `readAllKeys`.                      |
  | `readAllValues`  | `readAllEntries`, `readAllValues`, or `readAllKeys`.    |
  | `readAllEntries` | `readAllEntries` or `readAllKeys`.                      |

  ([`spec.md` §12](./spec.md#12-optional-adapter-capabilities))

- **Bulk reads are fail-fast.** One corrupt or unregistered row terminates the
  whole `readAll*` stream; entries are never skipped or quarantined. For per-row
  resilience, iterate the **backing** storage's keys and call this wrapper's
  `read(key)` inside your own try/catch.
  ([`spec.md` §12.5](./spec.md#125-error-semantics))

- **No legacy migration.** The wrapper expects the backing store to hold
  `StorageEnvelope` values only; it does not read raw, unwrapped legacy session
  rows. Migrate existing data to envelope format before activating it.
  ([`spec.md` §1](./spec.md#1-overview--architecture))

Adapter-raised errors are `ExtendedStorageError` instances carrying a `code`
from `EXTENDED_STORAGE_ERROR_CODES`; errors thrown inside a transform, or by
base64 / UTF-8 / `JSON.parse`, propagate unchanged. Full matrix:
[`spec.md` §13](./spec.md#13-error-reference-matrix).

## Authoring a transform

A transform is a codec for the body bytes plus optional metadata. Implement the
[`StorageTransform`](./spec.md#3-public-api-contracts) interface — `kind`,
`version`, `encode`, `decode`, and optional `isExpired` — and register it in
`transforms`. You do not touch the wrapper's internals; the contract below is
everything you need.

### The contract

```ts
import type {
  StorageTransform,
  StorageTransformRecord,
} from "@grammyjs/storage-extended";
```

- **`kind: string`** — a stable, globally unique identifier for this transform
  family. It is recorded in every envelope and used to route reads back to your
  transform, so it must never change once rows exist. Namespace it to avoid
  collisions, e.g. `"npm:@my-org/transform-aes-gcm"` or `"jsr:@my-org/lz4"`. It
  cannot be empty and cannot begin with the reserved prefix
  `grammy-extended-storage-` (either is rejected at construction).

- **`version: string`** — the format version your `encode` currently produces
  (use SemVer). It is copied verbatim into the record; `decode` receives it back
  as `record.version` so you can evolve the format and still read old rows.

- **`encode(body): { body, meta? }`** — transform the incoming `Uint8Array` and
  optionally attach JSON-serializable `meta`. Returning anything other than a
  `Uint8Array` body (or a non-object `meta`) throws
  `ERR_INVALID_TRANSFORM_OUTPUT` before the write. `meta` is stored in
  **plaintext** — never put secrets in it.

- **`decode(body, record): Uint8Array`** — reverse `encode`, using
  `record.version` and `record.meta`. It **must throw** if the body cannot be
  restored (bad key, corruption, unsupported `record.version`). It must not be
  used to signal expiry; a non-`Uint8Array` return throws
  `ERR_INVALID_TRANSFORM_OUTPUT`.

- **`isExpired?(record): boolean`** (optional) — a cheap check over the record
  **only** (typically `record.meta`); the body is not available here. Returning
  `true` expires the whole entry: the wrapper deletes it and treats it as absent
  without ever decoding the body. Anything expiry depends on must be written
  into `meta` at encode time.

`encode`, `decode`, and `isExpired` may each be sync or return a `Promise`. Full
rules: [`spec.md` §7](./spec.md#7-transform-contract).

### Worked example: gzip compression

A complete, runnable transform using the platform `CompressionStream`. It
rejects unsupported record versions and validates the untrusted field it reads
back (`record.meta.rawLength`) rather than trusting it blindly:

```ts
import type { StorageTransform } from "@grammyjs/storage-extended";

async function pipeThrough(
  bytes: Uint8Array,
  stream: ReadableWritablePair<Uint8Array, BufferSource>,
): Promise<Uint8Array> {
  const source = new Blob([bytes as BlobPart]).stream().pipeThrough(stream);
  return new Uint8Array(await new Response(source).arrayBuffer());
}

export function gzip(kind = "example:gzip"): StorageTransform {
  return {
    kind,
    version: "1.0.0",
    async encode(body) {
      return {
        body: await pipeThrough(body, new CompressionStream("gzip")),
        meta: { rawLength: body.byteLength },
      };
    },
    async decode(body, record) {
      // Reject record versions this decode does not understand.
      if (record.version !== "1.0.0") {
        throw new Error(
          `${record.kind}: unsupported record version ${record.version}`,
        );
      }
      const restored = await pipeThrough(body, new DecompressionStream("gzip"));
      // Validate untrusted meta before trusting it (see spec.md §6, §7.4).
      const expected = record.meta.rawLength;
      if (
        typeof expected !== "number" ||
        !Number.isSafeInteger(expected) ||
        expected < 0
      ) {
        throw new Error(
          `${record.kind}: invalid meta.rawLength ${JSON.stringify(expected)}`,
        );
      }
      if (restored.byteLength !== expected) {
        throw new Error(
          `${record.kind}: decoded ${restored.byteLength} bytes, expected ${expected}`,
        );
      }
      return restored;
    },
  };
}
```

### Testing and distribution

- **Round-trip.** The wrapper never checks that `decode(encode(x)) === x` — that
  fidelity is your responsibility. Test it, including across every `version`
  your `decode` still accepts, and test that `decode` **throws** on corrupt
  input.
- **Expiry.** If you expose `isExpired`, test that it reads only the record,
  that a `true` result deletes the row and yields `undefined` from `read`, and
  that `has` reports it absent without decoding the body.
- **Distribute** as its own package that depends on `@grammyjs/storage-extended`
  for the `StorageTransform` type. Publish your `kind` in the README so
  consumers can recognize your rows in stored envelopes.

## Contributing

Local checks (see [`deno.json`](./deno.json)):

```sh
deno task test      # run the test suite
deno task check     # type-check src/mod.ts and test/
deno task lint
deno task fmt:check
```

Please run these before opening a pull request. Engineering conventions live in
[`AGENTS.md`](./AGENTS.md), and the authoritative behavior spec is
[`spec.md`](./spec.md).
