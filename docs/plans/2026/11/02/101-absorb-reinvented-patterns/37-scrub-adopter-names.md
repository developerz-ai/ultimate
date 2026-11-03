# 37 — Adopter names out of the public tree, and kept out

> Part of [`overview.md`](overview.md). Depends on: none. Owns the private-name guard and `X_PRIVATE_NAME`; [`32-docs-guards.md`](32-docs-guards.md) has none. No committed hash table. Tier: `scripts/`, comments and test fixtures only.

## Why
Private adopter names sit in tracked files, published to npm with each package's source. Counted 2026-11-02, this repo's own name and domain excluded: 153 lines in 113 files, 67 of them non-test lines in 54 files, 59 test files. Adding names' stems (a domain without its suffix) reaches 176 lines, some of them generic words. No non-test `.ts` hit is outside a comment, so nothing at run time reads one. No tracked path contains a name. Each hit is a source note: the measured figure is the value, the name adds nothing.

## Scope
Everything tracked, except `CHANGELOG.md`, `docs/history/` and `docs/plans/`, whose records stand. Git history and published tarballs are not rewritten.

## Files to change
- Hits, about 113 files; regenerate, never from this page. Mostly `packages/cli` (over half), then `seo`, `ui`, `pwa`, `http`, `render`, `testing`; `wiki/` 5 lines; `scripts/`, `docs/`, `examples/` a few; the root `.gitignore` 2 lines.
- `scripts/private-names.ts` (new) + `scripts/private-names.test.ts` — the guard.
- `scripts/verify.ts:343` — add the guard to the `boundaries` host check, so `x verify` runs it.
- `package.json` — `private-names` script.
- `.github/workflows/ci.yml:62` — `ULTIMATE_PRIVATE_NAMES: ${{ secrets.ULTIMATE_PRIVATE_NAMES }}` in the workflow `env`.
- `docs/architecture/guards.md` — `bun run scripts/guards-doc.ts --write`.
- `wiki/Error-Codes.md`, the registration — by `new-error-code`.

## Steps
1. Build the list off-tree, in a temporary directory, never in this repo. Source: the directory names two levels above this checkout, organisations and repositories both, plus each adopter's package scope.
2. Trim it by hand: drop this repo, its organisation and its domain; drop a generic word that would hit ordinary prose. Add a stem only if it is distinctive. One name per line.
3. List hits: `git grep -n -I -i -w -F -f <list> -- . ':!CHANGELOG.md' ':!docs/history' ':!docs/plans'`. Paste no hit into a commit message, PR body or issue.
4. Rewrite each line.

| Hit | Becomes |
|---|---|
| comment naming the source, with a figure | "one adopter", the figure unchanged: count, unit, version and date stay |
| comment naming the source, no figure | the same sentence with "one adopter" |
| wiki or README | "one adopter", or a neutral example domain |
| test fixture string | an invented name or `example.com`; the assertion unchanged |
| two adopters in one passage | "one adopter" and "another" |
| `.gitignore` line | a pattern matching the same paths, or removed if it matches nothing tracked or built here |

5. Check no figure moved: `git diff` with digits filtered, added against removed, for the rewritten lines.
6. Write the guard. Read `ULTIMATE_PRIVATE_NAMES` (newline- or comma-separated) from the environment, never from a file. Unset, empty or whitespace is one case: an Actions secret a fork's PR cannot read arrives as an empty string. Print `private-names: skipped, ULTIMATE_PRIVATE_NAMES is unset`, exit 0.
7. When set: scan `git ls-files` minus the three excluded paths, line by line, skipping binaries; lowercase; match a whole token, where letters, digits, `.` and `-` are token characters. Also scan tracked paths.
8. A finding prints `file:line` and the entry's 1-based index in the variable, never the name or the matched text. Reason: public CI logs, and Actions masks a secret's whole value, not each line of it. `--json` follows the same rule. A clean run prints the count of names and files checked.
9. Set the secret: `gh secret set ULTIMATE_PRIVATE_NAMES < <list>`, by an admin. Delete the off-tree list after.
10. Split: first PR the 54 non-test files, second PR the 59 test files plus the guard, so each stays under 100 files and the guard lands at zero.

## Error codes
`bun run new-error-code X_PRIVATE_NAME --package cli --title 'A private name is in a tracked file' --cause 'a tracked file carries an entry of ULTIMATE_PRIVATE_NAMES' --fix 'replace the name at the reported file:line with "one adopter", keeping any figure; bun run private-names --json' --off-socket`

| Code | When | Fix |
|---|---|---|
| `X_PRIVATE_NAME` | a scanned line or path carries a listed name | replace it with "one adopter" or a neutral example, keep the figure, `bun run private-names --json` |

## Tests
Unit, `scripts/private-names.test.ts`, on a fixture git tree with invented names passed through the environment:
- A listed name in a tracked file is refused with `X_PRIVATE_NAME`, `file:line` and the index; stdout and `--json` do not contain the name.
- Case differs: refused. A listed name as part of a longer token: passes.
- A name in a tracked path: refused.
- The same name under `CHANGELOG.md`, `docs/history/`, `docs/plans/`: passes.
- Unset, empty, whitespace-only: exit 0 and the skip note, and the "checked" line absent, so a skip cannot read as a scan.
- An untracked file holding a name: passes.
- A repo assertion: no committed file declares a name list. `scripts/private-names.ts` reads only `process.env`.

`bun test scripts/private-names.test.ts`

## Semver
None. Comments, docs and test fixtures; no export, runtime string or package shape changes. No Upgrading entry.

## Done when
- Step 3's grep, run with the full list, prints nothing.
- `ULTIMATE_PRIVATE_NAMES=<list> bun run private-names --json` exits 0 with non-zero counts.
- With the variable unset, the same command prints the skip note and exits 0.
- A CI run on `main` logs the "checked" line, not the skip note, and no name appears in its log.
- `git ls-files` holds no name list, hashed or plain; no hit or name in any commit message or PR body.
- Every figure the rewritten lines carried is still there.
- `bun run verify` green; `docs/architecture/guards.md` lists the guard.
