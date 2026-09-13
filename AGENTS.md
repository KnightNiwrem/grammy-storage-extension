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

## Completion

For implementation tasks, continue through implementation, relevant
verification, and correction of issues introduced by the change. All code
intended for commit, including tests, helpers, and examples, is a deliverable:
review it for correctness, readability, meaningful names, and coherent design
before finishing. Keep improvements within the requested scope and report
unresolved blockers.

## Behavioral contract

Use the relevant sections of `spec.md` as the behavioral contract. When the task
intentionally changes that contract, update the specification, implementation,
affected tests, and documentation together.

| Work                                   | Relevant specification |
| :------------------------------------- | :--------------------- |
| Public API or envelope format          | §§3–6                  |
| Codec behavior and registration        | §§7–8                  |
| Read/write ordering and expiry         | §§9–11                 |
| Optional methods and error propagation | §§12–13                |
| Proposed feature expansion             | §14: non-goals         |

## Project status & breaking changes

This package is pre-1.0 (see `version` in `deno.json`) and not yet published.
Breaking changes to the public API and to the stored `SerializedEnvelope` wire
format are permitted — no migration path or backward-compatibility shim is
required — unless and until the semver version in `deno.json` reaches major
version 1 or greater. From 1.0.0 onward, treat the public API (`spec.md` §3) and
the envelope format as stable: changes then require a deprecation or migration
story (e.g. a new envelope `discriminator` value).

## Distribution

Deno is currently supported; scoped JSR distribution and Node.js/Bun support are
planned. Direct URL imports are the interim Deno installation path. Registry
publication and a `publish` task remain deferred until a valid scoped name is
chosen. For distribution changes, consult README's [Status](README.md#status)
and [Install](README.md#install) sections and verify any newly claimed runtime
support.

The package name and `ENVELOPE_DISCRIMINATOR` are currently
`grammy-storage-extension`. When choosing a scoped package name, explicitly
decide whether the stored discriminator changes too.

## Checks

- `deno task test` — run the test suite.
- `deno task check` — type-check `src/mod.ts`, `test/`, and `examples/`.
- `deno task lint` / `deno task fmt:check`

The test suite uses in-memory fixtures and requires no live bot or database.
Dependency downloads may require network access. Run relevant checks, fix
failures introduced by the requested change, and rerun affected checks without
asking at each step. Running `examples/quick-start.ts` against a live Telegram
bot requires authorization for live testing.

Use focused checks while iterating and run all four tasks before opening a pull
request. Rerun checks affected by subsequent edits.
