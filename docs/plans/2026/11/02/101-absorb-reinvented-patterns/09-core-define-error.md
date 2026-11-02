# 09 — `defineError`: one declaration for a code, its title, its status and its class

> Part of [`overview.md`](overview.md). Depends on: none. Tier: 0 (`core`), 2 (`http`), 5 (`cli`).

## Why
An app code takes up to three separate declarations (`registerErrorCodes`, `registerErrorStatus`, a class), and nothing makes it write the status. Two adopters: 656 classes in 9,257 LOC, 217 classes in 4,394 LOC. One app measured 565 classes against 51 status registrations.
Probe: `statusFor('X_POST_NOT_FOUND')` is `500`, `declaredStatusFor` is `undefined`. No file in `examples/dummy` or `dummy/social-media-clone` calls `registerErrorStatus`, so the reference app's "post not found" is a 500, hides its cause (`packages/ai/src/failure-disclosure.ts:37`) and reaches the error monitor. The reference app has the defect the framework's own docs warn about.
Axiom 1: `defineError` beside `extends UltimateError` is a second way. It ships only with a guard that makes it THE way for app code.

## Files to change
- `packages/core/src/define-error.ts` (new) — the factory. Own file so a chunk importing only `UltimateError` does not grow.
- `packages/core/src/error-status-declared.ts` (new) — the app half of the status table, moved down from `packages/http/src/error-status.ts:31`. `core` cannot import `http`.
- `packages/core/src/index.ts`, `packages/core/README.md`, `packages/core/CLAUDE.md` — export and document.
- `packages/http/src/error-status.ts:42,79` — `registerErrorStatus` writes to core's table and keeps its refusals. `declaredStatusFor` stays framework-table-first, so `defineError` cannot move a framework code.
- `packages/cli/src/templates/guard-error-declared.ts` (new), `packages/cli/src/templates/scaffold-guards.ts:24` — the app-owned guard.
- `packages/cli/src/templates/guard-bare-error.ts:62` — its `fix` says "subclass UltimateError"; change it to name `defineError`.
- `packages/cli/src/templates/scaffold-domain-package.ts`, `packages/cli/src/templates/backfill.ts` — generators emit `defineError`.
- `examples/dummy/apps/web/app/*/errors.ts`, `examples/dummy/packages/*/src/errors.ts`, `dummy/social-media-clone/apps/web/app/*/errors.ts` — migrate all 22 classes, with statuses chosen per code.
- `wiki/Error-Codes.md` (app-code section), `wiki/Actions.md` `## Errors`, `wiki/Known-Gaps.md:106` (delete the row), `wiki/Building-Your-Own-Base.md`.

## Steps
1. `defineError<P = void>(spec)`. `spec`: `code`, `title`, exactly one of `status: number` or `offSocket: true`, `cause: string | (params: P) => string`, `fix: string | (params: P) => string`, optional `callerFix`, `docs`, `retry`, `meta: (params: P) => Record<string, unknown>`.
2. Returns a subclass of `UltimateError`: `new (params: P, extra?: { sourceError?, retry? })`, with statics `code`, `status` (`undefined` when off-socket) and `is(value): value is Instance`. `is` matches `isUltimateError` plus `code`, so it also recognises a `RemoteActionError` in a browser, where `instanceof` cannot.
3. At definition it calls `registerErrorCodes`, the core status table and, when given, `registerErrorRetry`. The same code with the same title and status is a no-op, which covers module re-evaluation under `x dev`. A different title or status is the existing `X_ERROR_CODE_DUPLICATE`.
4. Keep the `code:` literal at the call site. Probe: `scanFixes` on an arrow `fix: (p) => \`psql … ${p.ref}\`` reports the template at the right line, so the `errors` step (`X_ERROR_FIX_INVALID`, `X_ERROR_CODE_UNRESOLVED`) and the manifest's `errorCodes` read it with no scanner change.
5. Guard `error-declared`, code from `guardCode('error-declared')` per the template's rule: refuses `extends UltimateError` and `new UltimateError({ code: '<literal>'` in app source. A re-raise passing `err.code` is not a literal and passes. Fix: rewrite as `defineError({ code, title, status, cause, fix })`, then `x verify`.
6. Framework's own 421 classes stay as they are. Their codes belong to the closed `ERROR_STATUS` table and the `new-error-code` flow (`--status` / `--off-socket`), read by `scripts/error-map.ts`, and many carry positional constructors. State this split once in `packages/core/CLAUDE.md`: a framework code goes through `new-error-code`, an app code through `defineError`. No wiki row is required for an app code (`packages/cli/src/error-contract.ts:302`).
7. `registerErrorStatus` and `registerProblemMeta` stay: `registerErrorStatus` for codes an app does not own, `registerProblemMeta` for the per-code `meta` allowlist. `defineError` does not take the allowlist.

## Error codes
| Code | When | Fix |
|---|---|---|
| `X_ERROR_DECLARATION_INVALID` (new, off-socket) | both or neither of `status`/`offSocket`, a status outside 100-599, or a code not `X_SCREAMING_SNAKE` | `edit the defineError call the cause names, then x verify --only errors`. Add with `bun run new-error-code X_ERROR_DECLARATION_INVALID --package core --title '…' --cause '…' --fix '…' --off-socket` |
| `X_ERROR_CODE_DUPLICATE` (existing) | same code, different title or status | existing fix |

## Tests
- `packages/core/src/define-error.test.ts` (unit): both `cause` forms, `is()` across a plain `{code}` look-alike (refused) and an `UltimateError` built elsewhere with that code (accepted), re-definition no-op, each refusal.
- `packages/http/src/error-status.test.ts` (unit): a code from `defineError` answers its status; `defineError` of a framework code cannot change `statusFor`.
- `packages/cli/src/templates/guard-error-declared.test.ts` (unit): the shipped source run over a class, a literal `new`, a re-raise.
- `examples/dummy/apps/web/app/posts/*.test.ts`: `X_POST_NOT_FOUND` over the HTTP route answers 404 and carries its cause. It fails today with 500.
- Byte pin: `UltimateError`-only browser chunk unchanged (`bun build --target=browser --minify`, as `scripts/ui-barrel-bytes.test.ts` measures).
- `bun test packages/core/src/define-error.test.ts` then `bun run scripts/reference-app-gate.ts`.

## Semver
Minor. New export; the guard reaches new scaffolds only and existing apps see it as an `x doctor` difference. The tracked apps' status changes are app behaviour. Upgrading: optional row showing a class rewritten as `defineError`, and that any app code with no registered status answers 500 until declared.

## Done when
- `X_POST_NOT_FOUND` answers 404 in the reference app.
- `grep -rl 'extends UltimateError' examples/dummy dummy/social-media-clone --include=*.ts --exclude-dir=node_modules` prints nothing.
- A scaffolded app with a handwritten subclass fails `x verify` at `boundaries`.
- `wiki/Known-Gaps.md` no longer lists the row; `bun run verify` and the app gate are green.
