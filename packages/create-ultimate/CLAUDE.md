# create-ultimate — boundary

Unlisted — sits above tier 5, may import anything below it. Its only real import is
`@ultimat3/cli` (the sideways edge declared in `scripts/lib/tiers.ts`).

| Rule | Detail |
|---|---|
| Scope | argv in, `dispatch({ argv: ['new', ...] })` out. Nothing else. |
| Templates | none here — they live in `@ultimat3/cli/templates` |
| Prompts | never; every choice is a flag with a default |

Commands: `bun test`, `bunx tsc --noEmit -p tsconfig.json`.
