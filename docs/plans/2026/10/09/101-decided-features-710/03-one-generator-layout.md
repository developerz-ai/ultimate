# 03 — The generator's directory form is the one layout (decision 10)

> Part of [`overview.md`](overview.md). Depends on: none. Tier: 5 + both tracked apps.

## Files to change
- `packages/cli/src/` — a refusal of a sibling `X.ts` beside a directory `X/` inside an app's `apps/` tree, run in the `boundaries` step; a new `X_*` code via `bun run new-error-code`.
- `examples/dummy/apps/**`, `dummy/social-media-clone/apps/**` — every feature's `actions.ts`/`action.ts`/`mutator.ts`/`jobs.ts`/`live.ts` split into `actions/<name>.ts`, `jobs/<name>.ts`, `live/<name>.ts`, one primitive per file; imports and `api/index.ts` follow.
- `docs/architecture/12-generated-app.md:126`, `wiki/Project-Layout.md` — the directory form is the one layout.

## Steps
1. Failing test first for the refusal; then migrate each app, one feature at a time, tests green after each.
2. The file name is the primitive's export name in kebab case (`createPost` → `actions/create-post.ts`).

## Done when
- No flat primitive file left in either app; the refusal fires on a planted sibling; both apps' gates green.
