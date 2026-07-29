# To Review

Open spec questions that need more discussion before a decision.

## Issue #10 — Codec registration vs. execution semantics

**Context**: §8.2 dedupes registrations by `codec` id, so the registered set is
id-keyed. The write pipeline (§9) therefore applies each registered codec
exactly once per write, in declaration order — registering the same id twice
(e.g. compress → encrypt → compress) is rejected at construction. The read
pipeline (§10) is data-driven and happily decodes the same codec multiple times;
repeat-wrapped data can only originate externally (older writers, codecs that
wrap internally, hand-crafted envelopes).

**Open questions**:

1. Should §9 explicitly state that each registered codec runs exactly once per
   write, and that repeated layers on read come only from externally-produced
   data?
2. Should §7.2/§8 explicitly state the one-registration-per-family constraint —
   only one version of a codec family can be registered at a time, so format
   rotation must be handled inside that codec's `decode`, which must accept
   every historical version it may encounter?
3. Is the write-side inability to apply the same codec at two different pipeline
   steps (short of using two distinct ids like `lz4:inner` / `lz4:outer`)
   acceptable, or should the spec allow repeated registration of the same id at
   distinct write steps?

**Status**: unresolved — user wants more discussion before any spec change.
