# grammY Storage Extended

`grammy-storage-extension` wraps any grammY
[`StorageAdapter`](https://grammy.dev/plugins/session) so that session values
are stored inside validated **envelopes**. On write it runs an ordered list of
body **codecs** (compression, encryption, expiry, …); on read it undoes them
using the records saved in each envelope. The wrapper keeps grammY's
`StorageAdapter<T>` shape, so it drops straight into `session({ storage })`.

Codecs can attach plaintext metadata and a cheap `isExpired` check that runs
without decoding the body, so `has` and `readAllKeys` never pay for
decompression or decryption.

- **Using the plugin?** Start at [Install](#install) and
  [Quick start](#quick-start), then read
  [Configuring codecs](#configuring-codecs) and
  [Operational behavior](#operational-behavior). You do not need to write a
  codec.
- **Writing a codec?** Jump to [Authoring a codec](#authoring-a-codec).
- **Need the full contract?** See [`spec.md`](./spec.md); each section below
  links into it.

## Status

Pre-1.0 and **not yet published to a registry**. The public API (`spec.md` §3)
and the stored envelope format may still change without a migration path until
the version in [`deno.json`](./deno.json) reaches `1.0.0`. Until it is
published, depend on it via the jsDelivr URL in [Install](#install), a Git URL,
or a local path.

Written for and tested on **Deno** (CI runs Deno `v2.x`). It has no
Node-specific dependencies, but Node/Bun compatibility is not yet part of the
test matrix. A scoped JSR package usable from Deno, Node.js, and Bun is planned.

## Install

This package is not published to a registry yet. The supported interim path is a
**direct URL import under Deno**, serving this GitHub repo through a CDN such as
[jsDelivr](https://www.jsdelivr.com/):

> ```ts
> // Pin a tag or commit in place of <ref> for reproducible builds.
> import { createExtendedStorage } from "https://cdn.jsdelivr.net/gh/KnightNiwrem/grammy-storage-extension@<ref>/src/mod.ts";
> ```

This URL import works under Deno. It is not usable from Node.js, which does not
resolve `https:` ESM specifiers through its default loader; Node.js and Bun will
be supported by the planned scoped JSR release (see [Status](#status)).

The examples below import from the bare specifier `grammy-storage-extension`;
map that to your setup — the jsDelivr URL above, an import-map/`deno.json`
alias, a Git URL, or a local path.

## Quick start

You do not have to write a codec to use the wrapper. With an empty codec list it
just wraps your session values in envelopes and stores them as-is:

```ts
const storage = createExtendedStorage<SessionData>({
  storage: new MemorySessionStorage<SerializedEnvelope>(), // any grammY adapter
  codecs: [], // no codecs yet: values are wrapped but otherwise unchanged
});

bot.use(session({ initial: (): SessionData => ({ count: 0 }), storage }));
```

The full, runnable program is in
[`examples/quick-start.ts`](./examples/quick-start.ts). Swap
`MemorySessionStorage` for any grammY storage adapter (Redis, MongoDB, Deno KV,
…); it is for demonstration only and loses all contents when the process
restarts, so use a persistent adapter in production.

The type parameter on `createExtendedStorage<SessionData>` must match your
session type; the returned adapter is a `StorageAdapter<SessionData>`.

## Configuring codecs

Codecs are what make this wrapper useful: each one rewrites the body on write
and restores it on read. You add behavior by listing codecs; the wrapper applies
them **in declaration order** on write and reverses them on read. A codec may
also just attach metadata (e.g. an expiry timestamp) and leave the body
untouched.

Here a time-to-live codec stamps each write with an expiry and reports the entry
as expired once that time passes. It is metadata-only — the body is never
rewritten:

```ts
const storage = createExtendedStorage<{ count: number }>({
  storage: new MemorySessionStorage<SerializedEnvelope>(),
  codecs: [ttl(60_000)],
});

await storage.write("chat:1", { count: 1 });
console.log(await storage.read("chat:1")); // { count: 1 }
// ...more than 60s later, or after the clock passes expiresAt:
console.log(await storage.read("chat:1")); // undefined (and the row is deleted)
```

The `ttl()` codec used above is the complete, runnable
[`examples/ttl.ts`](./examples/ttl.ts): it stamps `meta.expiresAt` on encode,
leaves the body untouched, and exposes a cheap `isExpired` that reads only the
plaintext meta (so `has` and `readAllKeys` never decode the body).

### Ordering

Order is semantic, not cosmetic. When you combine codecs that change the body,
compression must come **before** encryption, because encrypted (high-entropy)
data does not compress. This snippet is conceptual — `gzip()` is the
[worked example below](#worked-example-gzip-compression), and `encrypt`/`key`
stand in for an encryption codec you supply:

```ts
const storage = createExtendedStorage<SessionData>({
  storage: backing,
  codecs: [gzip(), encrypt(key)], // compress, then encrypt
});
```

See [`spec.md` §7.7](./spec.md#77-layer-ordering--size-considerations) for the
full ordering and size discussion.

### Retiring a codec without breaking old rows

The read pipeline is driven by the records saved in each envelope, not by your
current `codecs` list. To stop applying a codec while keeping already-stored
rows readable, move it to `decoders`. Existing rows are rewritten without it on
their next `write`.

Suppose you have been writing rows with the
[gzip codec](#worked-example-gzip-compression) and want to stop compressing new
writes. Before, gzip is in `codecs`:

```ts
import { gzip } from "./examples/gzip.ts"; // the worked example below

const storage = createExtendedStorage<SessionData>({
  storage: backing,
  codecs: [ttl(60_000), gzip()],
});
```

After, gzip moves to `decoders` so old compressed rows still decode while new
writes skip compression. The codec's `id` must match the one in the stored rows,
so reuse the same `gzip()`:

```ts
import { gzip } from "./examples/gzip.ts";

const storage = createExtendedStorage<SessionData>({
  storage: backing,
  codecs: [ttl(60_000)], // no longer compressing new writes
  decoders: [gzip()], // still decodes previously compressed rows
});
```

Once no stored row still references that `id`, drop it from `decoders`. A row
that still references an id registered in neither list fails its read with
`ERR_UNKNOWN_CODEC`. See [`spec.md` §7.6](./spec.md#76-read-only-decoders).

Codec ids must be unique **across both lists**: an `id` cannot appear twice,
whether within `codecs`, within `decoders`, or once in each. Registering the
same id in both throws `ERR_DUPLICATE_CODEC_ID` at construction — so when you
retire a codec, move it from `codecs` to `decoders` rather than adding it to
both.

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

- **Metadata is plaintext.** A codec's `meta` (including any `expiresAt`) is
  stored unencrypted and unauthenticated, outside whatever the body codecs do.
  Anyone with database access can read or edit it. Never put secrets in `meta`.
  ([`spec.md` §7.3](./spec.md#73-encodebody))

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
  `SerializedEnvelope` values only; it does not read raw, unwrapped legacy
  session rows. Migrate existing data to envelope format before activating it.
  ([`spec.md` §1](./spec.md#1-overview--architecture))

Adapter-raised errors are `ExtendedStorageError` instances carrying a `code`
from `EXTENDED_STORAGE_ERROR_CODES`; errors thrown inside a codec, or by base64
/ UTF-8 / `JSON.parse`, propagate unchanged. Full matrix:
[`spec.md` §13](./spec.md#13-error-reference-matrix).

## Authoring a codec

A codec encodes the body bytes on write, restores them on read, and may attach
optional metadata. Implement the [`BodyCodec`](./spec.md#3-public-api-contracts)
interface — `id`, `version`, `encode`, `decode`, and optional `isExpired` — and
register it in `codecs`. You do not touch the wrapper's internals; the contract
below is everything you need.

### The contract

```ts
import type { BodyCodec, CodecRecord } from "grammy-storage-extension";
```

- **`id: string`** — a stable, globally unique identifier for this codec family.
  It is recorded in every envelope and used to route reads back to your codec,
  so it must never change once rows exist. Namespace it to avoid collisions,
  e.g. `"npm:@my-org/codec-aes-gcm"` or `"jsr:@my-org/lz4"`. It must be a
  non-empty string (any other value is rejected at construction).

- **`version: string`** — the format version your `encode` currently produces
  (use SemVer). It is copied verbatim into the record; `decode` receives it back
  as `record.version` so you can evolve the format and still read old rows.

- **`encode(body): { body, meta? }`** — encode the incoming `Uint8Array` and
  optionally attach JSON-serializable `meta`. Returning anything other than a
  `Uint8Array` body (or a non-object `meta`) throws `ERR_INVALID_CODEC_OUTPUT`
  before the write. `meta` is stored in **plaintext** — never put secrets in it.

- **`decode(body, record): Uint8Array`** — reverse `encode`, using
  `record.version` and `record.meta`. It **must throw** if the body cannot be
  restored (bad key, corruption, unsupported `record.version`). It must not be
  used to signal expiry; a non-`Uint8Array` return throws
  `ERR_INVALID_CODEC_OUTPUT`.

- **`isExpired?(record): boolean`** (optional) — a cheap check over the record
  **only** (typically `record.meta`); the body is not available here. Returning
  `true` expires the whole entry: the wrapper deletes it and treats it as absent
  without ever decoding the body. Anything expiry depends on must be written
  into `meta` at encode time.

`encode`, `decode`, and `isExpired` may each be sync or return a `Promise`. Full
rules: [`spec.md` §7](./spec.md#7-codec-contract).

### Worked example: gzip compression

[`examples/gzip.ts`](./examples/gzip.ts) is a complete, runnable codec using the
platform `CompressionStream`. It shows the two things a body codec should do
beyond the round trip: reject record versions its `decode` does not understand,
and **validate** the untrusted field it reads back (`record.meta.rawLength`)
rather than trusting it blindly. Its shape:

```ts
export function gzip(id = "example:gzip"): BodyCodec {
  return {
    id,
    version: "1.0.0",
    async encode(body) {
      return {
        body: await pipeThrough(body, new CompressionStream("gzip")),
        meta: { rawLength: body.byteLength },
      };
    },
    async decode(body, record) {
      // Rejects unknown record.version, then validates record.meta.rawLength
      // against the decoded byte length. See examples/gzip.ts for the checks.
      // ...
    },
  };
}
```

The example codecs ([`examples/gzip.ts`](./examples/gzip.ts),
[`examples/ttl.ts`](./examples/ttl.ts)) are exercised by the test suite
(`test/examples.test.ts`), so the snippets above stay in step with code that
actually runs.

### Testing and distribution

- **Round-trip.** The wrapper never checks that `decode(encode(x)) === x` — that
  fidelity is your responsibility. Test it, including across every `version`
  your `decode` still accepts, and test that `decode` **throws** on corrupt
  input.
- **Expiry.** If you expose `isExpired`, test that it reads only the record,
  that a `true` result deletes the row and yields `undefined` from `read`, and
  that `has` reports it absent without decoding the body.
- **Distribute** as its own package that depends on `grammy-storage-extension`
  for the `BodyCodec` type. Publish your `id` in the README so consumers can
  recognize your rows in stored envelopes.

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
