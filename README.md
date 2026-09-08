# grammY Storage Extended

`@grammyjs/storage-extended` is a small storage adapter wrapper for grammY that
stores values in validated envelopes, applies an ordered list of body transforms
(compression, encryption, expiry, …) on write, and undoes them by the records
stored in the envelope on read, while preserving grammY's `StorageAdapter<T>`
shape.

Transforms can attach plaintext metadata and a cheap `isExpired` check that runs
without decoding the body, so `has` and `readAllKeys` never pay for
decompression or decryption.

## Install

```sh
deno add jsr:@grammyjs/storage-extended
npx jsr add @grammyjs/storage-extended
```

## Usage

```ts
import { MemorySessionStorage } from "grammy";
import {
  createExtendedStorage,
  type StorageEnvelope,
  type StorageTransform,
} from "@grammyjs/storage-extended";

// A metadata-only transform: leaves the body alone and records an expiry.
function ttl(ms: number): StorageTransform {
  return {
    kind: "example:ttl",
    version: "1.0.0",
    encode: (body) => ({ body, meta: { expiresAt: Date.now() + ms } }),
    decode: (body) => body,
    isExpired: (record) => Date.now() >= (record.meta.expiresAt as number),
  };
}

const backing = new MemorySessionStorage<StorageEnvelope>();
const storage = createExtendedStorage<{ count: number }>({
  storage: backing,
  transforms: [ttl(60_000)],
});

await storage.write("chat:1", { count: 1 });
const value = await storage.read("chat:1");
console.log(value); // { count: 1 }
```

To stop applying a transform while keeping old rows readable, move it to
`readOnlyTransforms`. Rows are rewritten without it on their next write:

```ts
const storage = createExtendedStorage<{ count: number }>({
  storage: backing,
  transforms: [ttl(60_000)],
  readOnlyTransforms: [legacyGzip], // decode-only: { kind, decode, isExpired? }
});
```

> This adapter expects backing storage to contain `StorageEnvelope` values only.
> It does not automatically migrate raw legacy session values.

See [`spec.md`](./spec.md) for the full specification.
