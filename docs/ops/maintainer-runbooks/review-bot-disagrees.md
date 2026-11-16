# A review bot disagrees

**A review comment is a claim; the gate is the verdict.** Every PR is reviewed by the maintainer
bot and by a third-party review bot (`review.force: true`, `pr.wait_for_other_bots` in
`.dz/maintainer/maintainer.yml`). When one asks for a change the author believes wrong, or the two
contradict each other, a test decides — never seniority, never the louder thread.

## Notice

| Signal | Command |
|---|---|
| every open thread, every review verdict, and each bot that posted a "did not review" notice | `bun run x -- pr review --pr <n> --json` |
| a thread in full | `bun run x -- pr review --pr <n> --full --json` |
| the gate | `gh pr checks <n> --json name,state` — `verify` is the required check |

## Do

| The comment claims | Do |
|---|---|
| a defect | write the failing test it implies. Red: it was right — fix it in the PR, reply with the test's name. Green: reply with the test and its output, then resolve |
| a style or convention point | the convention exists only if a check enforces it (axiom 3). Enforced: the gate already says so. Not enforced: decline with that reason, or file the check as an issue if the point is good |
| a design change beyond the PR's scope | decline in the thread; file it as an issue linking the thread |
| the opposite of the other bot | the test above decides. Reply on both threads with the same evidence |
| nothing (a "did not review" notice: rate or size limit) | not a review. The PR is reviewed by the other reviewer; never wait on a bot that said it will not come |

Reply and resolve: `bun run x -- pr reply <thread-id> --body '<evidence>'`, then
`bun run x -- pr resolve <thread-id>`. A thread is resolved by evidence in it, never silently.

## Never

- Merge over an open thread that claims a defect nobody tested.
- Change code only to make a bot stop commenting.
- Turn a reviewer off for a PR. A reviewer that is wrong often is an issue about the reviewer.
