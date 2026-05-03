# grammY Storage Extended

`@grammyjs/storage-extended` is a small storage adapter wrapper for grammY that
stores values in validated envelopes, applies optional user-defined envelope
codecs on write, and decodes them by envelope metadata on read while preserving
grammY's `StorageAdapter<T>` shape.

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
} from "@grammyjs/storage-extended";

const backing = new MemorySessionStorage<StorageEnvelope>();
const storage = createExtendedStorage<{ count: number }>({ storage: backing });

await storage.write("chat:1", { count: 1 });
const value = await storage.read("chat:1");
console.log(value); // { count: 1 }
```

See [`draft-spec.md`](./draft-spec.md) for the full specification.
