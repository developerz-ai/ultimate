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
//
// The seven after those are about the STYLESHEET, which Biome does not read at all: a length, a
// breakpoint, a layer, a shadow and a tempo off their scales, a class the sheet never compiled and
// a custom property nothing declares. Until they shipped, raw colour was the only one of the
// design system's rules a scaffolded app's gate held.
//
// And one is about DATA: a `repo.ts` reads through the typed handle. It ships because the generator
// used to emit string SQL, and every app that started from it copied the shape.

import { animatedLayoutPropertyGuardFiles } from './guard-animated-layout-property';
import { bareErrorGuardFiles } from './guard-bare-error';
import { focusVisibleGuardFiles } from './guard-focus-visible';
import { imageDimensionsGuardFiles } from './guard-image-dimensions';
import { islandWithoutStatesGuardFiles } from './guard-island-without-states';
import { rawBreakpointGuardFiles } from './guard-raw-breakpoint';
import { rawColourGuardFiles } from './guard-raw-colour';
import { rawLengthGuardFiles } from './guard-raw-length';
import { rawMotionGuardFiles } from './guard-raw-motion';
import { rawShadowGuardFiles } from './guard-raw-shadow';
import { rawZIndexGuardFiles } from './guard-raw-z-index';
import { repoRawSqlGuardFiles } from './guard-repo-raw-sql';
import { semanticInteractiveGuardFiles } from './guard-semantic-interactive';
import { undeclaredCustomPropertyGuardFiles } from './guard-undeclared-custom-property';
import { undefinedStyleClassGuardFiles } from './guard-undefined-style-class';
import { untranslatedStringGuardFiles } from './guard-untranslated-string';
import { unzonedDateGuardFiles } from './guard-unzoned-date';
import type { GeneratedFile } from './naming';

/**
 * Every guard the framework ships, by the name its file carries — the ONE list. `x new` writes all
 * of them (`scaffoldGuardFiles`), `x g guard <name>` writes the one it is asked for by name
 * (`shippedGuardFiles`), and `x doctor` names the ones an app does not have. Sorted, so the three
 * agree on an order. A new shipped guard is one module beside these and one row here.
 */
const SHIPPED: readonly (readonly [string, () => readonly GeneratedFile[]])[] = [
  ['animated-layout-property', animatedLayoutPropertyGuardFiles],
  ['bare-error', bareErrorGuardFiles],
  ['focus-visible', focusVisibleGuardFiles],
  ['image-dimensions', imageDimensionsGuardFiles],
  ['island-without-states', islandWithoutStatesGuardFiles],
  ['raw-breakpoint', rawBreakpointGuardFiles],
  ['raw-colour', rawColourGuardFiles],
  ['raw-length', rawLengthGuardFiles],
  ['raw-motion', rawMotionGuardFiles],
  ['raw-shadow', rawShadowGuardFiles],
  ['raw-z-index', rawZIndexGuardFiles],
  ['repo-raw-sql', repoRawSqlGuardFiles],
  ['semantic-interactive', semanticInteractiveGuardFiles],
  ['undeclared-custom-property', undeclaredCustomPropertyGuardFiles],
  ['undefined-style-class', undefinedStyleClassGuardFiles],
  ['untranslated-string', untranslatedStringGuardFiles],
  ['unzoned-date', unzonedDateGuardFiles],
];

/** The names, in the order every list of them is shown. */
export const SHIPPED_GUARD_NAMES: readonly string[] = SHIPPED.map(([name]) => name);

/**
 * The shipped guard of that name with its test, or `undefined` when the name is not one — which
 * is an app's own convention, and `x g guard` then writes the blank template instead.
 */
export const shippedGuardFiles = (name: string): readonly GeneratedFile[] | undefined =>
  SHIPPED.find(([shipped]) => shipped === name)?.[1]();

/**
 * The current text of a shipped guard's rule file (`guards/<name>.ts`), or `undefined` when the
 * name was never shipped — what `x doctor` compares an app's copy against.
 */
export const shippedGuardSource = (name: string): string | undefined => {
  const contents = shippedGuardFiles(name)?.find(
    (file) => file.path === `guards/${name}.ts`,
  )?.contents;
  // A guard is source text; bytes would be a template bug, and comparing them as text would hide it.
  return typeof contents === 'string' ? contents : undefined;
};

/**
 * Every guard `x new` ships, each with its test. One module per guard, because an app deletes a
 * rule it does not want by deleting one file — and a guard the app then writes for itself is
 * `x g guard <name>`, the same shape.
 */
export const scaffoldGuardFiles = (): readonly GeneratedFile[] =>
  SHIPPED.flatMap(([, files]) => files());
