# Publishing and provenance — the record

Moved out of the root `CLAUDE.md` on 2026-09-23 (plan 101, slice 17 f): the procedure is [`PUBLISHING.md`](../../PUBLISHING.md) and every current fact is a command in the root `CLAUDE.md`'s fact table. This is how each of those facts came to be.

**There is no package awaiting its first publish**, `As of 2026-08-26` —
`bun run scripts/registry-audit.ts --json` answers `31/31 publishable packages are on npm at
<version>, every one attested`. This block said `@ultimat3/notify` "has never been published" and
owed step 1 of [`PUBLISHING.md`](../../PUBLISHING.md) **before** the next release run; that was true when
written and the 16.0.0 run published it, so the sentence outlived its fact and would have sent the
next agent to perform a hand publish npm answers with `E403 … cannot publish over the previously
published versions`. Step 1 comes due again for the **next package added after a release run**, and
for nothing else: it is a package's only manual publish, ever, and `@ultimat3/notify`,
`@ultimat3/scraping` and `@ultimat3/flags` were the last three to need it. Ask the audit rather than
this paragraph — that is the rule this whole table exists for.

**A lightweight tag is not a release trigger, and `--follow-tags` will not push one.** `v4.0.0` was
first created with a bare `git tag v4.0.0`; `git push --follow-tags` pushed the commit, said nothing,
and left the tag local — `--follow-tags` pushes **annotated** tags only. The GitHub Release could
then not be created against a ref the remote did not have. `git tag -a` is the only form
[`PUBLISHING.md`](../../PUBLISHING.md) writes, for this reason.

**There are no publication holes, and `scripts/registry-audit.ts` is what keeps it that way.**
`@ultimat3/scraping` was the last one, bootstrapped by hand at 2.0.0 on 2026-08-19 —
`npm publish --access public --provenance=false`, the one-time step every package needs before a
trusted publisher can attach — and npm now answers `E403 … cannot publish over the previously
published versions: 2.0.0` on a retry. `@ultimat3/flags` was the same shape and was closed the same
way. Publication is a step apart from versioning, so the two can disagree silently: the audit runs
in CI and files a `registry-drift` issue when they do, which is exactly what it did during 4.0.0's
release window while the publish sat behind the `npm-publish` environment gate (issue #221, closed
when the run finished). The publish list itself is **derived** from `scripts/list-workspaces.ts`,
which is what keeps a new package from being silently absent from it. Step 1 of `PUBLISHING.md`
comes due again for the next package added after a release run, and nothing else.

**Every package has an OIDC trusted publisher.** `developerz-ai` / `ultimate` / `release.yml` /
environment `npm-publish`, publish permission, all 30, verified per package with
`npx -y npm@12 trust list <pkg> --json` — `npm trust` shipped in **npm 12** and Bun's bundled npm
answers it as an unknown command, which is why `scripts/trust-publishers.ts` pins the runner. That
attachment is what lets [`.github/workflows/release.yml`](../../.github/workflows/release.yml) publish at
all: one tarball per publishable workspace per release, each attested,
`_npmUser: GitHub Actions`, on every release from 3.0.0 on.

**The `npm-publish` environment carries no required reviewers**, by the owner's decision of
2026-09-05. Until then this page said the run reaches `waiting` until a named reviewer approves;
now the gate is the `check` job in `release.yml` — it waits for `ci.yml`'s verdict on the tagged
commit and runs `scripts/release.ts --check` — plus the environment's `v*` deployment tag rule.
`publish` cannot start without `check`.

**2.0.0 is the one release with no provenance**: no publisher was attached, so the OIDC exchange had
nothing to verify against, the workflow could not publish, and 2.0.0 went out by hand —
`_npmUser: sebyx07`, no `dist.attestations`, where 1.1.0, 1.2.0 and every release from 3.0.0 carry both. Not
"for the first time" — this file said that until 2026-08-19 and `CHANGELOG.md`'s 3.0.0 header still
does: 1.1.0 and 1.2.0 published under **earlier** publisher configurations, one per package, and
`npm view @ultimat3/core@1.2.0 _npmUser.trustedPublisher` answers an `oidcConfigId` that differs from
3.0.0's. 1.0.0 was the manual bootstrap.

Releases publish with **provenance** — which 2.0.0 did not get, because no trusted publisher existed for the exchange to verify against. All 30 were attached on 2026-08-19, and every release from 3.0.0 on has gone out through the workflow: `npm view @ultimat3/core@<version> dist.attestations _npmUser`. See [`PUBLISHING.md`](../../PUBLISHING.md).
