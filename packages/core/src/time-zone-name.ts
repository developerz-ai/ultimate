// Single responsibility: re-export `@ultimat3/schema`'s IANA zone-name predicate, so `app.config.ts`
// and `t.timezone` judge a zone with ONE function.
//
// This file held a character-for-character copy of it until 2026-08-27 — `core` and `schema` are
// both tier 0 and neither could import the other — kept equal by a 123-line pin test in
// `@ultimat3/cli`, a tier-5 package pinning a tier-0 invariant that no rule required to exist.
// `core -> schema` is now a declared edge (`scripts/lib/tiers.ts`), so the copy is gone.
//
// The rule itself, and why a bare `new Intl.DateTimeFormat(…)` probe is not it — ICU 78 resolves
// `CET`, `EST`, `Japan`, `GMT` and `Zulu`, so `defaultTimeZone: 'CET'` passed validation at boot
// and threw `X_TIMEZONE_INVALID` on the first `format` call (issue #257) — is written down in
// `packages/schema/src/time-zone-name.ts` and in `packages/time/src/zone-canonical.ts`.

export { isIanaZoneName } from '@ultimat3/schema';
