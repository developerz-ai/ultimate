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
- Anything that opens a socket calls `markListening(server.url.origin)` and releases it on close.
  That is what tells the sealed test network a loopback request is this process, not egress.
- `cursor.ts` is the framework's ONE keyset-cursor codec — `entity`, `query` and `admin` all sign
  and verify here. `decodeCursor(cursor, scope)` takes the scope as a required argument on
  purpose: an optional check is one a call site can forget, and a forgotten one pages a listing
  with another read's cursor. A second codec anywhere is the regression this file exists to
  prevent. Tests that call `configureCursorSigning()` must restore the previous secret.
