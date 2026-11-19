# Brief: does a confirmed security fix need a release today?

Devops session on Thursdays and Sundays, so a confirmed fix waits at most three days with the Tuesday `release-due`, fired by `schedules: security-release` in
`.dz/maintainer/maintainer.yml`. This is the one off-cycle release. Everything else waits for
Tuesday's `.dz/briefs/release-due.md`, and a person can still cut by hand.

## Run

```bash
bun run scripts/release-due.ts --json
```

You have a shell, no `git` writes and no `gh`; the runner ships what you leave in the tree. A refusal
(`ok:false`): report its `cause` and stop.

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

Follow `.dz/briefs/release-due.md` § Cut the release, opening `PR.md` and the `### Highlights` with the
advisory's id and source URL. A major stays a maintainer's. Otherwise change no file and end
`REPORT.md` with `no release: <reason>`.
