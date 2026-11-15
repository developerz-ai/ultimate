# 08 — Upgrades without hand edits

> Part of [`overview.md`](overview.md). Depends on: [`07`](07-gate-truth.md). Tier: 5–6.

## Files to change
- `packages/cli/src/` guard generator + `x upgrade` — U1. Guards are vendored copies. 31.4.0/31.4.1 cost three apps +3,704 to +4,231 lines each; 20 of 24 guards differ from the template in one app, 9 in another; `wiki/Upgrading.md:202` tells the author to re-run `x g guard --force`.
- `packages/cli/src/` upgrade codemods — U2. Scaffold-owned files (authenticator, chart dashboard, format hook) were hand-ported on 31.20 in five apps (+526, +527 lines).
- `packages/cli/src/` doctor + a new superseded-workaround table — U3. Five apps still set `render: 'ssr'` "until a hole marker ships" (`packages/render/src/hole.ts` shipped in 30.0.0); one still says `x token` is unimplemented.
- `packages/cli/src/templates/scaffold-container.ts:37` + a shipped guard — U4. Runtime pin consistency (engines, image, CI): four adopters wrote their own, one in 523 LOC.
- root `package.json` / published packages' dependency ranges — U5. Three adopters pin `seroval`, `seroval-plugins`, `source-map-js` by `overrides` for advisories.
- `packages/cli/src/cmd-repro.ts` — U6. Turns a dead job or captured 5xx into a test in the app; nothing carries it to this repository (carried: 2026/11/02 slice 40).
- `.github/ISSUE_TEMPLATE/bug.yml`.

## Steps
1. U1: guards run from the installed framework version; an app's `guards/` holds only its own guards and a small config of severities and pins. A local edit to a shipped guard becomes a config row or an app guard. `x upgrade` migrates a vendored tree once: identical copies are deleted, differing ones are diffed into config or kept as app guards with the reason printed. One way to get a guard: installing the framework.
2. U2: every change to a scaffold-owned file ships with a codemod registered against the version that introduced it; `x upgrade` applies them in order and reports any file it could not transform, with the diff. A release that changes a template without a codemod fails a repository guard here.
3. U3: a table `{ pattern, shippedIn, replacement }`; `x doctor` and `x upgrade` report each hit with the fix. Seed it with the `'ssr'` downgrade and the `x token` note; every feature release that retires a known workaround adds a row (guarded by the changelog check).
4. U4: ship the runtime-pin guard; `x upgrade` migrates older apps to the digest pin the scaffold already writes.
5. U5: the framework's own packages depend on patched ranges so an app needs no `overrides`; `security-channel.yml` raises the range when an advisory lands.
6. U6: `x repro --bundle` writes a redacted, self-contained archive (framework version, schema, the failing input; every non-key value stood in by default, `--include-rows` opts in); the bug template asks for it; `create-ultimate repro` opens it. The maintainer's triage brief ([`12`](12-maintainer-loop.md) M2) starts from the bundle.

## Tests
- Fixture apps at 31.4, 31.15, 31.20 and 31.22 (their scaffold output, generated in the test): `x upgrade` to HEAD leaves `x verify` green with zero hand edits.
- `bun test ./packages/cli/src/upgrade-guards.test.ts` — a locally edited guard is preserved as config, never overwritten.
- `bun test ./packages/cli/src/cmd-repro.test.ts -t 'bundle'` — no secret or unrelated row in the archive.
- `security-auditor` on the bundle redaction.

## Done when
- Each adopter's upgrade PR in sweep R is produced by `x upgrade` alone; any hand edit it needed is a defect filed against this slice.
- A template change without a codemod fails `bun run verify`.
