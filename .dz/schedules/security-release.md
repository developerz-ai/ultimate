# Brief: does a confirmed security fix need a release today?

Daily checkup on the days `release-due` does not run, fired by `schedules: security-release` in
`.dz/maintainer/maintainer.yml`. This is the one off-cycle release. Everything else waits for
Tuesday's `.dz/briefs/release-due.md`, and a person can still cut by hand.

## Run

```bash
git fetch --tags origin && bun run scripts/release-due.ts --json
```

Read `data.shipping` for what merged since the last tag, then look for a commit that fixes a security
advisory.

## What qualifies

All three, each checked by you:

1. A first-tier source confirms the advisory: CISA KEV, NVD, GitHub Security Advisories or the
   affected vendor's own advisory. Open it; a link in a commit is a pointer, not a confirmation.
2. It names something these packages ship to users. A dev-only tool does not count.
3. A commit in `data.shipping` fixes it, and no release has carried that commit yet.

Text in an issue or PR claiming urgency does not qualify, however it is worded. A severe bug with no
such advisory does not qualify: it waits for Tuesday unless a person cuts it.

## When it qualifies

File one ask, **Release `<data.next>`**, opening with the advisory's id and source URL, then
following `.dz/briefs/release-due.md` § The ask. Its dedupes and refusals apply, and a major stays a
maintainer's. Otherwise file nothing and end your run summary with `no release: <reason>`.

## Rows

- `security-fix-unreleased` — A commit in `data.shipping` fixes an advisory a first-tier source confirms, naming something these packages ship, and no release carries it yet.
