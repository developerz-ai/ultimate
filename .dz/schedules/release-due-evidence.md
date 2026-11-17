# Evidence: historical sample envelope

Back to the brief: [release-due.md](release-due.md).

Captured from `bun run scripts/release-due.ts --json` on 2026-10-22T01:02:38Z, exit 0. This
checkout had tags fetched, so this is an `ok:true` answer, not a refusal. It is evidence only;
the sibling brief defines the operational rule:

```json
{"ok":true,"script":"release-due","summary":"no release due (settling): the oldest shipping commit is younger than 24h, so its author may still release it: due at 2026-10-22T15:17:08.000Z","findings":[],"data":{"lastTag":"v27.13.2","stamped":"27.13.2","settleHours":24,"shipping":[{"sha":"7ebb9c3a39adb5ebe8e4891a2fa5123791766097","subject":"fix(cli): expose `headSha` on every `x ci` run row; document `ok: true` means \"no failed run\" (#826)","author":"developerz-ai[bot]","committedAt":1792627464,"packages":["cli"]},{"sha":"c56f7d97a130d2f67db08c6e7a03cea23336ad12","subject":"Give Finding.at one meaning: a path an agent can open (#821)","author":"developerz-ai[bot]","committedAt":1792595828,"packages":["cli"]}],"inert":9,"notes":["[Unreleased] in CHANGELOG.md is empty, so the release notes would be the commit subjects alone. Write them under `## [Unreleased]` before bumping."],"breaking":[],"bump":"patch","next":"27.13.3","due":false,"reason":"settling","detail":"the oldest shipping commit is younger than 24h, so its author may still release it: due at 2026-10-22T15:17:08.000Z","dueAt":"2026-10-22T15:17:08.000Z"}}
```
