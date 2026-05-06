import {
  STORAGE_ENVELOPE_KIND,
  VALUE_CODEC_ID,
  VALUE_CODEC_VERSION,
} from "./constants.ts";
import type { StorageValueCodec } from "./codec.ts";
import type { StorageEnvelope } from "./envelope.ts";

export class JsonValueCodec<T> implements StorageValueCodec<T> {
  readonly codec = VALUE_CODEC_ID;
  readonly version = VALUE_CODEC_VERSION;

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
        `Unsupported JSON value codec version: ${envelope.version}`,
      );
    }
    return JSON.parse(envelope.payload) as T;
  }
}
