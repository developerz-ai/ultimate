# How each major was made

Moved out of the root `CLAUDE.md` on 2026-09-23 (plan 101, slice 17 f): the pattern every major has followed, and the guard that mechanised half of it.

**Every major here has been one sweep, in two halves.** Things **declared and never wired** are
wired or deleted (`JobsConfig.driver`, `realtime.heartbeatMs`, `PrecacheAsset.critical`,
`CaptureOptions.timeoutMs`, `PERIODIC_SYNC_TAG`, `requiresApp`); things that **answered the wrong
thing** are corrected (`on delete` reaching the generated SQL, `in` with a non-array operand,
`t.date` accepting an offsetless date-time, `isValidCron` accepting an unsatisfiable day/month
pair, a local disk's signed URLs carrying the driver kind rather than the registered disk name).
No codemod ships: each entry names its own manual edit.
[`wiki/Upgrading.md`](../../wiki/Upgrading.md) walks every major, oldest first, and states its own count —
`bun run changelog-check` reads each count from that major's own `CHANGELOG.md` section.

**The declared-and-never-wired half is now mechanised.** `bun run scripts/config-readers.ts` is a
ratchet over every leaf key of `AppConfig`, written because twelve such keys across four releases
had each been found by hand, in a major — `jobs.driver` accepted `'postgres' | 'redis' | 'nats'`,
had no reader anywhere, and boot always built `createPgDriver`, so `jobs: { driver: 'redis' }` did
not throw, did not warn, and silently gave you Postgres. That is the dangerous direction, and it is
the one this repo keeps re-shipping; the guard's own header
([`scripts/config-readers.ts`](../../scripts/config-readers.ts)) calls it "the framework's most repeated
defect".

**The declared-and-never-wired half is now mechanised.** `bun run scripts/config-readers.ts` is a
ratchet over every leaf key of `AppConfig`, written because twelve such keys across four releases
had each been found by hand, in a major — `jobs.driver` accepted `'postgres' | 'redis' | 'nats'`,
had no reader anywhere, and boot always built `createPgDriver`, so `jobs: { driver: 'redis' }` did
not throw, did not warn, and silently gave you Postgres. That is the dangerous direction, and it is
the one this repo keeps re-shipping; the guard's own header
([`scripts/config-readers.ts`](../../scripts/config-readers.ts)) calls it "the framework's most repeated
defect".
