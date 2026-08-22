// The `guards/` directory `x new` writes, and the one list that names every guard in it.
//
// `x new` shipped ZERO guards while the `AGENTS.md` it writes stated nine non-negotiables — five of
// which nothing enforced, each measured green on `x verify` in a scaffolded app. The mechanism was
// never missing: `guards/` is discovered, not registered, and runs inside the `boundaries` step
// (`packages/cli/src/guards.ts`). What was missing is any guard to discover. Four of the five are
// here; the fifth, money-as-float, has no static signature and is answered by the `Money` type
// instead — `scaffold-docs.ts` says so where an author reads it.

import { bareErrorGuardFiles } from './guard-bare-error';
import { rawColourGuardFiles } from './guard-raw-colour';
import { untranslatedStringGuardFiles } from './guard-untranslated-string';
import { unzonedDateGuardFiles } from './guard-unzoned-date';
import type { GeneratedFile } from './naming';

/**
 * Every guard `x new` ships, each with its test. One module per guard, because an app deletes a
 * rule it does not want by deleting one file — and a guard the app then writes for itself is
 * `x g guard <name>`, the same shape.
 */
export const scaffoldGuardFiles = (): readonly GeneratedFile[] => [
  ...bareErrorGuardFiles(),
  ...rawColourGuardFiles(),
  ...untranslatedStringGuardFiles(),
  ...unzonedDateGuardFiles(),
];
