import { assertEquals, assertThrows } from "@std/assert";
import { assertValidEnvelope } from "../src/validation.ts";
import { STORAGE_ENVELOPE_KIND } from "../src/constants.ts";

function validEnvelope() {
  return {
    kind: STORAGE_ENVELOPE_KIND,
    codec: "test-codec",
    version: 1,
    payload: "{}",
  };
}

Deno.test("assertValidEnvelope accepts a valid envelope", () => {
  assertValidEnvelope(validEnvelope());
});

Deno.test("assertValidEnvelope rejects null", () => {
  assertThrows(() => assertValidEnvelope(null), Error, "Invalid envelope");
});

Deno.test("assertValidEnvelope rejects non-object", () => {
  assertThrows(() => assertValidEnvelope("hi"), Error, "Invalid envelope");
});

Deno.test("assertValidEnvelope rejects wrong kind", () => {
  const e = { ...validEnvelope(), kind: "wrong" };
  assertThrows(() => assertValidEnvelope(e), Error, "Invalid envelope kind");
});

Deno.test("assertValidEnvelope rejects empty codec", () => {
  const e = { ...validEnvelope(), codec: "" };
  assertThrows(() => assertValidEnvelope(e), Error, "Invalid envelope codec");
});

Deno.test("assertValidEnvelope rejects non-string codec", () => {
  const e = { ...validEnvelope(), codec: 123 };
  assertThrows(() => assertValidEnvelope(e), Error, "Invalid envelope codec");
});

Deno.test("assertValidEnvelope rejects negative version", () => {
  const e = { ...validEnvelope(), version: -1 };
  assertThrows(
    () => assertValidEnvelope(e),
    Error,
    "Invalid envelope version",
  );
});

Deno.test("assertValidEnvelope rejects non-integer version", () => {
  const e = { ...validEnvelope(), version: 1.5 };
  assertThrows(
    () => assertValidEnvelope(e),
    Error,
    "Invalid envelope version",
  );
});

Deno.test("assertValidEnvelope rejects non-string payload", () => {
  const e = { ...validEnvelope(), payload: 42 };
  assertThrows(
    () => assertValidEnvelope(e),
    Error,
    "Invalid envelope payload",
  );
});

Deno.test("assertValidEnvelope accepts version 0", () => {
  const e = { ...validEnvelope(), version: 0 };
  assertValidEnvelope(e);
});
