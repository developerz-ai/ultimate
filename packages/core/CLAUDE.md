# @ultimat3/core — agent notes

Tier 0. **Imports no `@ultimat3/*` package.** Everything else depends on this, so a change here
is a change to every package.

| Rule | |
|---|---|
| Deps | none (`bun-types` only) |
| Errors | subclass `UltimateError`; never `throw new Error` |
| New code | add to `CORE_CODE_TITLES` in `error-codes.ts`, else the title is auto-humanised |
| Time | take a `Clock`; `Date.now()` / `new Date()` only inside `clock.ts` |
| Context | never thread `ctx` as a parameter — `useContext()` |
| Exports | add to `src/index.ts` explicitly; no `export *` |
| Files | < 200 LOC, one responsibility, `kebab-case.ts`, test beside source |

Deliberate cycles (safe — nothing is referenced at module-evaluation time):
`errors.ts ⇄ error-codes.ts`. Keep it that way: no top-level `UltimateError` use in
`error-codes.ts`.

`logger.ts` must not import `context.ts`. `context.ts` injects the ids via
`setLoggerContextFields()`.

```bash
bun test                      # from packages/core
bun run typecheck
```

Gotchas:
- `exactOptionalPropertyTypes` is on — declare optional fields as `x?: T | undefined`.
- `noPropertyAccessFromIndexSignature` is on — `ctx.services['mail']`, not `.mail`.
- `Ctx` carries a string index signature so apps can augment `CtxServices` for `ctx.posts`.
- Tests that touch the registry, the lifecycle or the listener table must call
  `resetErrorCodes()` / `resetLifecycle()` / `resetListeners()`.
- The error-code registry is process-global and every package fills it once, at import time. A
  test that resets it must take `errorCodeSnapshot()` first and call the returned undo in
  `afterAll` — a reset that is not handed back strips the titles of every package imported before
  that file, and their errors render the humanised fallback (`X_DB_DRIFT: db drift`) for the rest
  of the run. That is a load-order flake: green locally, red on whichever CI ordering hits it.
- Anything that opens a socket calls `markListening(server.url.origin)` and releases it on close.
  That is what tells the sealed test network a loopback request is this process, not egress.
- `defineService(name, factory)` factories run again on every `createContext`/`withChildContext`
  call — never cached — because a factory closes over the `ctx` (actor, clock, tz) it is built
  for. `withChildContext` drops a factory-managed name from what it carries forward on purpose;
  only an ad hoc service nobody registered survives an actor swap unrebuilt.
- `cursor.ts` is the framework's ONE keyset-cursor codec — `entity`, `query` and `admin` all sign
  and verify here. `decodeCursor(cursor, scope)` takes the scope as a required argument on
  purpose: an optional check is one a call site can forget, and a forgotten one pages a listing
  with another read's cursor. A second codec anywhere is the regression this file exists to
  prevent. Tests that call `configureCursorSigning()` must restore the previous secret.
