# Contributing

**One page teaches this: [`CONTRIBUTING.md`](https://github.com/developerz-ai/ultimate/blob/main/CONTRIBUTING.md)** — setup, the gate, the tier table, code rules, tests, a new package, commits and PRs. This wiki page was a second copy with different sections; two copies of one job is the second path axiom 1 forbids, so it points instead.

| Need | The one source |
|---|---|
| set up, run the gate, open a PR | [`CONTRIBUTING.md`](https://github.com/developerz-ai/ultimate/blob/main/CONTRIBUTING.md) |
| the coding contract in full | [`docs/architecture/00-conventions.md`](https://github.com/developerz-ai/ultimate/blob/main/docs/architecture/00-conventions.md) |
| adding a feature, step by step | [`docs/architecture/15-adding-a-feature.md`](https://github.com/developerz-ai/ultimate/blob/main/docs/architecture/15-adding-a-feature.md) |
| a new error code | `bun run new-error-code <CODE> --package <pkg> --title '…' --cause '…' --fix '…'` — writes the registration and its [Error codes](Error-Codes) row together |
| the package tiers | `scripts/lib/tiers.ts`; the table, [Project layout](Project-Layout#framework-package-tiers) |
| a security issue | [`SECURITY.md`](https://github.com/developerz-ai/ultimate/blob/main/SECURITY.md), never a public issue |
