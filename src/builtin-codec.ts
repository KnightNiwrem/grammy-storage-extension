import {
  BUILTIN_VALUE_CODEC,
  BUILTIN_VALUE_CODEC_VERSION,
  STORAGE_ENVELOPE_KIND,
} from "./constants.ts";
import type { StorageValueCodec } from "./codec-types.ts";
import type { StorageEnvelope } from "./envelope.ts";

export class BuiltinValueCodec<T> implements StorageValueCodec<T> {
  readonly codec = BUILTIN_VALUE_CODEC;
  readonly version = BUILTIN_VALUE_CODEC_VERSION;

  encode(value: T): StorageEnvelope {
    const payload = JSON.stringify(value);
    if (typeof payload !== "string") {
      throw new Error(
        "Value cannot be encoded as a JSON storage envelope payload",
      );
    }

    return {
      kind: STORAGE_ENVELOPE_KIND,
      codec: this.codec,
      version: this.version,
      payload,
    };
  }

  decode(envelope: StorageEnvelope): T | undefined {
    if (envelope.version !== this.version) {
      throw new Error(
        `Unsupported built-in value codec version: ${envelope.version}`,
      );
    }
    return JSON.parse(envelope.payload) as T;
  }
}
