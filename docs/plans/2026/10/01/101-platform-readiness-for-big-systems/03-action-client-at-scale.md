# 03 — Action / query: the typed client at 300 actions

> Part of [`overview.md`](overview.md). Depends on: none. Tier: 3.

Rule: the documented idiom `rpc<Api['actions']>()` typechecks at any app size, and the path style
is stated once, on the server.

Evidence: a downstream app with 252 actions and 107 queries hit TS2589 ("instantiation is
excessively deep") on `typeof api` at three sites and fell back to four request styles; it also
restated `pathStyle` in a hand-written module because the browser cannot read the registry
(`packages/action/src/client.ts:89-95`).

## Files to change
- `packages/action/src/client.ts:61-65` — `Client<TActions>`, the mapped type.
- `packages/action/src/client.ts:99` — `rpc`.
- `packages/query/src/client.ts:131` — `queryClient`, the same shape.
- `packages/core/src/` `defineApi` return type — what `typeof api` is
  (`examples/dummy/apps/web/api/index.ts:51-60`).
- `packages/cli/src/templates/` — a template for `shared/browser-client.ts`; no template names
  that file today, so `x new` scaffolds no client.

## Steps
1. Reproduce first. Add a type fixture: 30 modules × 10 actions, each with a non-trivial input and
   output schema, composed with `defineApi`. Assert `rpc<Api['actions']>` and one call typecheck.
   Record `tsc --extendedDiagnostics` instantiation count before any change.
2. Find the depth. Candidates, in the order to test: `defineApi` inferring a union over arrays of
   module namespaces; `Action<infer TIn, infer TOut>` distributing over that union; schema
   inference nested inside the mapped type.
3. Fix the type, not the idiom. `rpc<Api['actions']>` stays the one spelling
   (`packages/action/src/client.ts:97-98`); a second, "lighter" client is a second path.
4. `pathStyle`: carry it in the type `defineApi` returns and read it in `rpc`, or ship it to the
   page with the build id the client already asserts (`assertSameBuild`, same file). Remove the
   option from `ClientOptions` only if every caller can then omit it; otherwise keep it and make
   a mismatch `X_CONTRACT_DRIFT`.
5. Scaffold `shared/browser-client.ts` from `examples/dummy/apps/web/shared/browser-client.ts:35-38`.

## Tests
- `packages/action/src/client-scale.test.ts` — the fixture; the test fails on today's tree if the
  reproduction holds. If it does not reproduce, record the measured count in this plan's
  `status.yml` notes, raise the fixture toward the surveyed app's real shape, and stop only when
  the failure is seen or 600 actions pass.
- Command: `bun test packages/action/src/client-scale.test.ts`, then `bun run typecheck`.

## Done when
- The 300-action fixture typechecks; `bun run typecheck` wall time on this repo is not worse by
  more than 5% (measure, state the number in the PR).
- `x new` writes `shared/browser-client.ts`; the scaffold-smoke CI job stays green.
