// The `guards/` directory `x new` writes, and the one list that names every guard in it.
//
// `x new` shipped ZERO guards while the `AGENTS.md` it writes stated nine non-negotiables — five of
// which nothing enforced, each measured green on `x verify` in a scaffolded app. The mechanism was
// never missing: `guards/` is discovered, not registered, and runs inside the `boundaries` step
// (`packages/cli/src/guards.ts`). What was missing is any guard to discover. Four of the five are
// here; the fifth, money-as-float, has no static signature and is answered by the `Money` type
// instead — `scaffold-docs.ts` says so where an author reads it.
//
// The other five are about what the app is like to USE, which no row of `AGENTS.md` had ever been
// about: a control a keyboard cannot reach, a focus ring taken away and not replaced, an image with
// no box, an animation the compositor cannot run, and an island nobody has seen fail. Each is
// statically decidable from the file alone — the reason those five and not the many that are not.

import { animatedLayoutPropertyGuardFiles } from './guard-animated-layout-property';
import { bareErrorGuardFiles } from './guard-bare-error';
import { focusVisibleGuardFiles } from './guard-focus-visible';
import { imageDimensionsGuardFiles } from './guard-image-dimensions';
import { islandWithoutStatesGuardFiles } from './guard-island-without-states';
import { rawColourGuardFiles } from './guard-raw-colour';
import { semanticInteractiveGuardFiles } from './guard-semantic-interactive';
import { untranslatedStringGuardFiles } from './guard-untranslated-string';
import { unzonedDateGuardFiles } from './guard-unzoned-date';
import type { GeneratedFile } from './naming';

/**
 * Every guard `x new` ships, each with its test. One module per guard, because an app deletes a
 * rule it does not want by deleting one file — and a guard the app then writes for itself is
 * `x g guard <name>`, the same shape.
 */
export const scaffoldGuardFiles = (): readonly GeneratedFile[] => [
  ...animatedLayoutPropertyGuardFiles(),
  ...bareErrorGuardFiles(),
  ...focusVisibleGuardFiles(),
  ...imageDimensionsGuardFiles(),
  ...islandWithoutStatesGuardFiles(),
  ...rawColourGuardFiles(),
  ...semanticInteractiveGuardFiles(),
  ...untranslatedStringGuardFiles(),
  ...unzonedDateGuardFiles(),
];
