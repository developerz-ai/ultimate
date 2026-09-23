# 09 — admin + testing

> Part of [`overview.md`](overview.md). Depends on: 08. Tier: 5.

Rule: a destructive admin action runs only with a confirmation the gate derived itself. A test
matcher used under `.not` cannot pass on a receiver of the wrong type.

## Files to change

| # | Defect | File:line | Change | Semver |
|---|---|---|---|---|
| a | `args.confirmation !== args.expectedConfirmation` is `false` when both are omitted (`undefined !== undefined`), so a destructive action runs unconfirmed through the public `invokeAdminAction` | `packages/admin/src/action-gate.ts:137`, `index.ts:13` | Derive the expected token in the gate from `confirmationToken(action.entity ?? 'admin', args.subject?.id ?? '')` (`crud.ts:320`), and ignore a caller-passed `expectedConfirmation` | patch (keeping the input field; removing it is in 18) |
| b | `adminCreate`, `adminUpdate` and `adminDestroy` never check `resource.operations`, so a direct call deletes on a `['list','detail']` resource | `packages/admin/src/crud.ts:221,253,306` | Extract `operationOffered(resource, op)` (today inline in `canOperate`, `crud.ts:80-82`). `canOperate` and the three direct CRUD functions both call it, so there is one rule. Refuse with the code the policy denial already uses | patch |
| c | an admin action over MCP with an `id` never loads the row, so a row-level policy cannot fire (suspected) | `packages/admin/src/mcp.ts:114-128` | Reproduce with a row predicate. If real, load via the resource repo before `guard` | patch |
| d | `toDenyPolicy`, `toMatchOpenApi` and `toBeWithinBudget` answer `pass:false` for a wrong-typed receiver, so `.not` passes. `.not.toDenyPolicy` is used 5× in the repo | `packages/testing/src/matchers.ts:228-235,262-289`, `matchers.test.ts:81` | Throw synchronously (the `assertStandardSchema` pattern, `:62`) with new codes `X_TEST_POLICY_EXPECTED`, `X_TEST_OPENAPI_EXPECTED`, `X_TEST_NUMBER_EXPECTED`. Invert the hole test at `:81`. Then grep the 5 `.not.toDenyPolicy` call sites and check each still passes | patch |
| e | the README example passes a Promise and no context, so it can never pass | `packages/testing/README.md:193` | Rewrite it with `await` and a real ctx | none |
| f | the fake DOM's `VOID_TAGS` is missing `source`, `area`, `wbr`, `col`, `embed`, `track`, `base` and `param`, so `<picture><source><img>` nests wrong | `packages/testing/src/island-dom.ts:330` | Use the full HTML void-element set | patch |

## Steps
1. a first: a failing test with `destructive: true` and neither field set, expecting a refusal.
2. d: register the three codes with `bun run new-error-code … --package testing`.

## Tests
- `bun test packages/admin/src packages/testing/src`
- `bun run scripts/test-bare-error.ts`: no new bare errors.

## Done when
- An unconfirmed destructive admin action is refused.
- `expect(undefined).not.toDenyPolicy(ctx)` throws.
