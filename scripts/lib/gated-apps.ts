// The apps this repo tracks and blocks on. As of 2026-11, both expectedRed tables are empty:
// every declared step is asserted. Data only; `scripts/reference-app-gate.ts` owns the ratchet.
// `--unpin` is retained for future pins; neither tracked app currently has a pin to remove.

import type { VerifyStepName } from '@ultimat3/cli';

/** Where the pin tables live, so `X_REFERENCE_APP_PIN_STALE` can name the file to edit. */
export const PINS_FILE = 'scripts/lib/gated-apps.ts';

export interface GatedApp {
  /** Repo-relative app root. Also how every finding names the app. */
  readonly dir: string;
  /** The root `tsconfig.json` `references` entry the app must join once it typechecks. */
  readonly reference: string;
  /**
   * Steps allowed to fail, each naming the work that owns it. Both current tables are empty, so
   * every declared step is asserted. A step absent from the table MUST pass; a new red step is a
   * regression, never a reason to add a pin. Lines are only ever deleted: a pinned step that turns
   * green fails the gate until its line goes. `--unpin` is retained for future pins, not a current
   * removal. The step count is `VERIFY_STEP_NAMES.length`, never restated here.
   */
  readonly expectedRed: Readonly<Record<string, string>>;
}

/**
 * Both tracked apps, in the order the gate runs them: the curated reference app first, the demo
 * second. `satisfies` against the gate's own step names, so a pin for a step that does not exist
 * is a compile error rather than a line that quietly excuses nothing.
 */
export const GATED_APPS: readonly GatedApp[] = [
  {
    dir: 'examples/dummy',
    reference: './examples/dummy',
    expectedRed: {} satisfies Partial<Record<VerifyStepName, string>>,
  },
  {
    // The deployed demo (.github/workflows/deploy-social-demo.yml publishes its image on every
    // push to main). It was tracked, deployed and gated by nothing until 2026-08 — 237 files whose
    // only claim to working was that someone had once run them. It entered the ratchet at 3 red,
    // went to 2 when `typecheck` came off the pin, back to 3 when `drift` learned to read the
    // entity registry and found what the source-text hash could not, to 2 again when the
    // migration that answers it landed, and to 0 — `{}` — once its last two steps went green. It
    // is gated not because it is the reference app, but because an image this repo ships to a live
    // URL is a claim, and axiom 3 says a claim that is not a build error does not exist.
    dir: 'dummy/social-media-clone',
    reference: './dummy/social-media-clone',
    expectedRed: {} satisfies Partial<Record<VerifyStepName, string>>,
  },
];
