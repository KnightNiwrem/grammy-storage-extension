# AGENTS.md

## Engineering principles

- Keep responsibilities cohesive, dependencies explicit, and interfaces small.
  Choose simple designs over speculative abstractions. Extract shared code when
  it represents shared knowledge, not just similar syntax.
- Give identifiers meaningful names that express domain concepts,
  responsibilities, and behavior. Prioritize human readability. Treat names as
  contracts: humans and LLMs use them to infer intent and relationships. Use
  consistent vocabulary, include units or state where relevant, and rename
  identifiers when their meaning changes.
- Make types, invariants, side effects, and error handling explicit. Validate
  external input at boundaries instead of concealing problems with unchecked
  assertions or suppressions.
- Scope changes to the task and preserve unrelated work. Test observable
  behavior and relevant edge cases. Update documentation when behavior or
  workflows change.
- Follow repository configuration and established Deno tooling, formatting,
  linting, and type-checking conventions. Run checks appropriate to the change
  and report failures or checks not run.

## Project status & breaking changes

This package is pre-1.0 (see `version` in `deno.json`) and not yet published.
Breaking changes to the public API and to the stored `StorageEnvelope` wire
format are permitted — no migration path or backward-compatibility shim is
required — unless and until the semver version in `deno.json` reaches major
version 1 or greater. From 1.0.0 onward, treat the public API (`spec.md` §3) and
the envelope format as stable: changes then require a deprecation or migration
story (e.g. a new envelope `kind`).

## Distribution

The package name is the unscoped `grammy-storage-extension` (it also serves as
the `ENVELOPE_DISCRIMINATOR` value). Distribution has two stages; do not read
the current stage as cancelling the intended one:

| Concern              | Current                                                          | Intended                   |
| :------------------- | :--------------------------------------------------------------- | :------------------------- |
| Supported runtime    | Deno                                                             | Deno, Node.js, and Bun     |
| Installation         | Direct URL import under Deno (jsDelivr/GitHub) or local checkout | Scoped package on JSR      |
| Registry publication | Deferred until a scoped name is chosen                           | Planned; **not** cancelled |

Constraints that drive this:

- JSR requires the `@scope/name` format, which the unscoped
  `grammy-storage-extension` does not satisfy — so JSR publication waits on
  choosing a scoped registry name. There is no `publish` task while the name is
  unscoped (a `deno publish` would fail); add one only once a valid scoped name
  exists.
- The jsDelivr URL import is a **Deno-only** interim path. Node.js does not
  resolve `https:` ESM specifiers through its default loader, so this path does
  not establish Node.js/Bun support. Do not infer cross-runtime compatibility
  from it; that support arrives with the scoped JSR release, and Node/Bun are
  not yet in the test matrix.

## Checks

- `deno task test` — run the test suite.
- `deno task check` — type-check `src/mod.ts` and `test/`.
- `deno task lint` / `deno task fmt:check`
