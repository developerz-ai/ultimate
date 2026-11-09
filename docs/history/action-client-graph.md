# @ultimat3/action — `isTransientFailure`, the client graph's import rule and `sideEffects`

Moved out of `packages/action/CLAUDE.md` on 2026-11-09 (plan 101, slice 21), verbatim, to keep that
file under its 24 KB ceiling. Each is still a rule: a change that breaks one is a defect.

- **The client graph imports `@ultimat3/core/page`, never the barrel** (`client.ts`, `errors*.ts`,
  `error-titles.ts`, `wire-issues.ts`); `client-bundle.test.ts` fails on a titles table or a warning.

- **`sideEffects` is `["./src/error-titles.ts"]`**, never `false` (drops its bare imports): the
  titles ride into every barrel chunk (`problemError` decodes by code), `errors.ts`'s classes do
  not. An http refusal needs no http module: core's decoders take its title off the body and its
  `retry-after` off the header (`rpc-refusal.test.ts`).

- **`isTransientFailure` INVERTS `retryDecision`'s unclassified default** (a caller's `AbortError`
  is terminal). Must survive.
