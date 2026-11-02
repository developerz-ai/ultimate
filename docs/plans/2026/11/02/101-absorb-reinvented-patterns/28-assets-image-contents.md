# 28 — The scaffolded image carries no tests

> Part of [`overview.md`](overview.md). Depends on: none. Tier: 5 (`cli`).

## Why
`packages/cli/src/templates/scaffold-container.ts:140-145` ignores no tests and no docs, so `COPY . .` puts both in every layer. Two of three adopters on the framework added the same lines by hand, each with a comment saying nothing in the image runs them. The third still ships them.

| Adopter | Tracked bytes | `*.test.*` + fixtures | `docs/` | Ignored by hand |
|---|---|---|---|---|
| one | 20.8 MB | 3.6 MB | 2.6 MB | no |
| two | 156.9 MB | 11.3 MB | 9.3 MB | yes |
| three | 31.2 MB | 8.0 MB | 2.7 MB | yes, one `docs/` subtree re-included because an MCP endpoint serves it |

Cost beyond bytes: any edit to a test invalidates `COPY . .` and everything below it, including `x build --target prebuilt`, the slowest line in the file. A test edit rebuilds Babel and Sass.

## Files to change
- `packages/cli/src/templates/scaffold-container.ts:145` — after `**/playwright-report`: `**/*.test.ts`, `**/*.test.tsx`, `docs`, with a one-line reason each.
- `dummy/social-media-clone/docker/Dockerfile.dockerignore`, `Dockerfile.monorepo.dockerignore`, `examples/dummy/docker/Dockerfile.dockerignore` — same lines, so `scripts/image-contract.ts` and the templates agree.
- `packages/cli/src/templates/scaffold-container.ts:150` — README line: an app that serves a file from `docs/` re-includes it with `!docs/<path>`.
- `docs/ops/` image page, if it lists the ignore file.

## Steps
1. The image's module scan already skips tests (`packages/cli/src/app-load.ts:213`), so no boot reads what these lines drop.
2. Anchored `docs`, not `**/docs`: a package may hold a directory of that name it reads at run time.
3. No `*.fixture.ts` line: a fixture can be reached by non-test source, and a missing module at boot is a worse failure than a few kilobytes.
4. Add the rule to `scripts/image-contract.ts` only if a tracked app could drift without a test noticing; `scaffold-container.test.ts` already judges the template.

## Error codes
None new. A file the app needs at run time and has now ignored fails at boot with the module's own load error; the README line names the re-include.

## Tests
- `packages/cli/src/templates/scaffold-container.test.ts`: the emitted ignore file holds the three lines; removing one reds it.
- `scaffold-smoke` in CI: a scaffolded image still boots.
- `bun test packages/cli/src/templates/scaffold-container.test.ts`

## Semver
Minor. Generated file for new apps. Existing apps own their copy; `wiki/Upgrading.md` carries an optional row, no action required.

## Done when
- A file under `docs/` or a `*.test.ts` changed in a scaffolded app leaves the `RUN x build --target prebuilt` layer cached (`docker build` reports `CACHED`).
- Both tracked apps build with the new lines.
