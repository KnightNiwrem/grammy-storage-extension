import { STORAGE_ENVELOPE_KIND } from "./constants.ts";

export type StorageEnvelope = {
  kind: typeof STORAGE_ENVELOPE_KIND;
  codec: string;
  version: string;
  payload: string;
};

export function assertValidEnvelope(
  value: unknown,
): asserts value is StorageEnvelope {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Invalid envelope: expected a non-null object");
  }

  const envelope = value as Record<string, unknown>;

  if (envelope.kind !== STORAGE_ENVELOPE_KIND) {
    throw new Error("Invalid envelope kind");
  }
  if (typeof envelope.codec !== "string" || envelope.codec.length === 0) {
    throw new Error("Invalid envelope codec");
  }
  if (typeof envelope.version !== "string") {
    throw new Error("Invalid envelope version");
  }
  if (typeof envelope.payload !== "string") {
    throw new Error("Invalid envelope payload");
  }
}
