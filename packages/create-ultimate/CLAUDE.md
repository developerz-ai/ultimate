# create-ultimate — boundary

Tier 5, sideways import of `@ultimat3/cli` only (the single exception in the tier table, declared
in `scripts/lib/tiers.ts`).

| Rule | Detail |
|---|---|
| Scope | argv in, `dispatch({ argv: ['new', ...] })` out. Nothing else. |
| Templates | none here — they live in `@ultimat3/cli/templates` |
| Prompts | never; every choice is a flag with a default |

Commands: `bun test`, `bunx tsc --noEmit -p tsconfig.json`.
