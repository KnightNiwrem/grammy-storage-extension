import { decodeBase64, encodeBase64 } from "@std/encoding/base64";

import type { StorageBodyEncoding } from "./envelope.ts";
import {
  EXTENDED_STORAGE_ERROR_CODES,
  ExtendedStorageError,
} from "./errors.ts";

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("utf-8", { fatal: true });

export function serializeValue(value: unknown): string {
  let text: string | undefined;
  try {
    text = JSON.stringify(value);
  } catch (error) {
    throw new ExtendedStorageError(
      EXTENDED_STORAGE_ERROR_CODES.VALUE_SERIALIZATION,
      "Value cannot be serialized as a JSON storage envelope body",
      { cause: error },
    );
  }
  if (typeof text !== "string") {
    throw new ExtendedStorageError(
      EXTENDED_STORAGE_ERROR_CODES.VALUE_SERIALIZATION,
      "Value cannot be serialized as a JSON storage envelope body",
    );
  }
  return text;
}

export function deserializeValue<T>(text: string): T {
  return JSON.parse(text) as T;
}

export function textToBytes(text: string): Uint8Array {
  return textEncoder.encode(text);
}

export function bytesToText(bytes: Uint8Array): string {
  return textDecoder.decode(bytes);
}

export function encodeBody(bytes: Uint8Array): string {
  return encodeBase64(bytes);
}

export function decodeBody(
  body: string,
  encoding: StorageBodyEncoding,
): Uint8Array {
  return encoding === "utf8" ? textToBytes(body) : decodeBase64(body);
}
