# 13 — scripts, CI

> Part of [`overview.md`](overview.md). Depends on: none. Tier: —. Path-disjoint from 11, 12.
> A guard that passes vacuously is worse than no guard (axiom 3).

## Files to change
| Where | Change | Row |
|---|---|---|
| `scripts/lib/args.ts:22-26,43` | `flagBool` refuses a string value, as the CLI's `X_CLI_BAD_FLAG` | `s1-t5 #5` |
| `scripts/to-throw-returns.ts:37-40,52-53` | optional name prefix; match across newlines with `scripts/lib/balanced-paren.ts`; a factory typed `: Error` | `s1-t5 #8` |
| `scripts/test-bare-error.ts:43` | `new\s+` optional | `s1-t5` low |
| `scripts/pin-raises.ts:25`, `:62-76` | `PIN_FILES` lists `scripts/doc-commands.ts`, `scripts/readme-fences-backlog.ts`, `scripts/lib/gated-apps.ts`; the stating comment must differ from the base ref's text for that row | `s2-atss #11, #12` |
| `scripts/budget-raises.ts:94-96` | the `measured:` comment must be new, and measured ≤ the new budget | `s2-atss #11` |
| `scripts/image-contract.ts:9`, `:127-129`, `:204` | `--from` external images and stage indices resolved through `libcOf`; a Dockerfile with no `.dockerignore` is a finding; every tracked Dockerfile checked | `s2-atss #13` |
| `scripts/lib/coverage-units.ts:37` | `test: ./packages/${name}` | `s1-t5` low |
| `scripts/registry-audit.ts:221`, `scripts/release.ts:186`, `scripts/list-workspaces.ts` | a floor on the workspace list — zero is a failure; an unknown `--tier` is refused | `s1-t5` gaps |
| `scripts/lib/release-writes.ts:151-194` | the lockfile and footer steps inside the same `try` as the manifests; a partial bump names what was written | `s1-t5` gaps |
| `scripts/new-package.ts:261-279` | kebab-case name check; `--tier` required for a name not in the table | `s1-t5` low |
| `scripts/lib/verify-shard.ts:103` | `Object.hasOwn` on the timings read | `s1-t5` gaps |
| `scripts/doc-commands.ts` | globs include `examples/` and `dummy/` markdown | `s2-atss` gaps |
| `scripts/doc-fixes.ts` | each `fix:` command shape resolved against the registry, positionals included | `s2-arch H2` |
| `scripts/lib/config-reader-pins.ts`, `scripts/config-readers.ts` | a pin saying "read by app code" is checked against both tracked apps | `s1-arch #7` |
| `packages/cli/src/error-unthrown.ts:23` | the "not thrown" waiver is a listed set, not a prose match | `s1-arch` low |
| `.github/workflows/release.yml:117` | `version` through `env:`, as every other step | `s1-sec M10` |
| `.github/workflows/ci.yml`, `registry-audit.yml`, `deploy-social-demo.yml:79` | actions pinned by SHA, as `release.yml` | `s1-sec L5` |
| `docker/helm/templates/_helpers.tpl:88` | per-role secret references; an `emptyDir` `sizeLimit`; a NetworkPolicy template | `s2-sec L9` |

## Steps
1. `flagBool` first — `release.ts --bump minor --dry-run=true` currently performs the release writes. The test goes through `parseScriptArgs`; do **not** run `release.ts` to prove it.
2. Pin ratchets: after widening `PIN_FILES`, run `bun run scripts/pin-raises.ts` against `main` — any row it now flags was raised under a stale comment; restate or lower it in the same commit.
3. `to-throw-returns` and `test-bare-error` will surface real sites once fixed — fix the tests they find, or pin them in `scripts/lib/test-bare-error-pins.ts` with a `why:`. Do not widen a pin without one (`X_PIN_RAISE_UNSTATED`, if that is the code — grep `scripts/pin-raises.ts`).
4. Every new guard states its header so `bun run scripts/guards-doc.ts --write` regenerates `docs/architecture/guards.md`; `--check` is in the gate.
5. `image-contract`: the demo's `dummy/social-media-clone/docker/Dockerfile.monorepo` is the image CI deploys — it must be in the checked set.

## Tests
- `scripts/lib/args.test.ts`, `scripts/release.test.ts`, `scripts/to-throw-returns.test.ts`, `scripts/test-bare-error.test.ts`, `scripts/pin-raises.test.ts`, `scripts/budget-raises.test.ts`, `scripts/image-contract.test.ts`, `scripts/coverage-gate.test.ts`, `scripts/new-package.test.ts`, `scripts/lib/workspaces.test.ts`.
- `bun test ./scripts`

## Owned elsewhere
- `scripts/lib/workspaces.ts:141` (publish order — `s1-t5 #6` re-proves it), `release.yml:144` (gate waits on `verify` only), `scripts/lib/corpus.ts:24`, `scripts/lib/verify-args.ts:91-93` (`s1-t5` low re-proves it), `deploy-social-demo.yml:144,157`, `wiki.yml:24` — **2026-09-28 plan, slice 07. All open** (`s3-prior`).
- The publish gate living in the tagged ref, `npm-publish` reviewers — slice 15 (reverses a recorded owner decision).
- The ratchet backlog itself (241 unmapped error codes, 155 README fences, bare errors in tests) — `s1-arch` *Known-red inventory*; burn-down is not this plan.
- Unaudited: ~40 guard scripts and most of `bench/` (`s2-atss`, last table).

## Done when
- `--dry-run=true` is refused by every script.
- A pin or budget raised under a pre-existing comment is a finding.
- `bun run scripts/guards-doc.ts --check` green; `bun run coverage:package scripts` at or above its pin (`scripts/lib/coverage-pins.ts`).
- `bun run scripts/release-workflow.ts --json` and `bun run scripts/release.ts --check <version>` unchanged in verdict.
