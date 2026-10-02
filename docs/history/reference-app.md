# Reference app — history

Decision records moved out of `examples/dummy/CLAUDE.md` to keep it under its size ceiling. That file
wins where the two disagree.

## Two shipped guards, measured against this app

Both produced only false positives here; both were fixed in `packages/cli/src/templates/`, never in
the app, and both report zero against it.

| Guard | Was measured here | The defect, and its repair |
|---|---|---|
| `raw-colour` | **87 findings, 87 of them `rgb(`** | `CHANNEL_FUNCTION` matched `rgb(` unconditionally, and `rgb(var(--color-surface))` is what `@ultimat3/ui`'s own `tokens.role()` COMPILES to (`packages/ui/src/tokens/_colors.scss:98`, `tokens.ts` returns `rgb(var(--color-bg) / 1)`) — so the finding's own cause, "a value no theme can restate", was false of every one. The rule now reads the BALANCED argument list: a channel function whose slots are all `var(--…)` references or `#{…}` interpolations, with at most a trailing numeric alpha after `/` or `,`, is the token form. `rgb(1 2 3)` and `rgb(var(--x) 2 3)` are still refused, and the cause now names the whole call instead of the bare `rgb(` |
| `untranslated-string` | **12 findings, 12 of them `t()` calls** | its `EXPRESSION` mask was `/\{[^{}]*\}/g`, which does not nest: `{t('app.feed.heading', { org: actor.org.name })}` had its INNER brace group masked first, leaving `{t('app.feed.heading',  )}` unmatched, and the leftover read as typed prose — so every `t()` call carrying an interpolation object or a template-literal key was reported, the exact opposite of the rule. It is a brace-DEPTH scan now (`withoutExpressions`), so a nested child is removed whole and prose typed beside one is still refused |
