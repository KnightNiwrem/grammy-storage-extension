/**
 * Worked example: a gzip body codec.
 *
 * A complete, runnable {@link BodyCodec} built on the platform
 * `CompressionStream`/`DecompressionStream`. It rejects record versions it does
 * not understand and validates the untrusted field it reads back
 * (`record.meta.rawLength`) rather than trusting it blindly.
 *
 * Because compression raises entropy, place `gzip()` **before** any encryption
 * codec in your `codecs` list (see `spec.md` §7.7).
 */
import type { BodyCodec } from "../src/mod.ts";

/** Pump `bytes` through a (de)compression stream and collect the result. */
async function pipeThrough(
  bytes: Uint8Array,
  stream: ReadableWritablePair<Uint8Array, BufferSource>,
): Promise<Uint8Array> {
  const source = new Blob([bytes as BlobPart]).stream().pipeThrough(stream);
  return new Uint8Array(await new Response(source).arrayBuffer());
}

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
      // Reject record versions this decode does not understand.
      if (record.version !== "1.0.0") {
        throw new Error(
          `${record.id}: unsupported record version ${record.version}`,
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
          `${record.id}: invalid meta.rawLength ${JSON.stringify(expected)}`,
        );
      }
      if (restored.byteLength !== expected) {
        throw new Error(
          `${record.id}: decoded ${restored.byteLength} bytes, expected ${expected}`,
        );
      }
      return restored;
    },
  };
}
