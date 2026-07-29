# AGENTS.md

## Project status & breaking changes

This package is pre-1.0 (see `version` in `deno.json`) and not yet published.
Breaking changes to the public API and to the stored `StorageEnvelope` wire
format are permitted — no migration path or backward-compatibility shim is
required — unless and until the semver version in `deno.json` reaches major
version 1 or greater. From 1.0.0 onward, treat the public API (`spec.md` §3)
and the envelope format as stable: changes then require a deprecation or
migration story (e.g. a new envelope `kind`).

## Key documents

- `spec.md` — the normative architectural & API specification. Keep it in
  sync with any behavior change.
- `todo.md` — approved spec changes not yet reflected in `src/`.
- `toreview.md` — open spec questions awaiting a decision.

## Checks

- `deno task test` — run the test suite.
- `deno task check` — type-check `src/mod.ts` and `test/`.
- `deno task lint` / `deno task fmt:check` — style gates (`spec.md` is
  excluded from fmt).
