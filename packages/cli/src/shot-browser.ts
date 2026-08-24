// Which browser a `x shot` run gets: start one in this container, or ATTACH to one somebody else is
// running. Three rules over plain inputs and no `ParsedArgs`, so each is testable without a boot —
// the `cmd-jobs.ts` / `jobs-report.ts` split, repeated for the one decision that is easy to get
// silently wrong.

import {
  browserBinaryExists,
  cdpUrlFrom,
  cdpUrlProblem,
  executablePathFrom,
} from './browser-launcher';
import { BadFlagError } from './errors';

/** A runnable example, not a placeholder: every refusal below hands one of these back. */
const CDP_FIX = 'x shot / --cdp-url wss://cdp.example.com/session/abc';

/**
 * Exactly one of these is set. `undefined` on both is the ordinary local run where the library
 * finds its own Chrome — which is why neither is required rather than a union of two shapes.
 */
export interface ShotBrowserChoice {
  /** Attach here. When set, nothing about a local executable was read. */
  readonly cdpUrl?: string | undefined;
  /** Launch this. Already proved to exist on disk. */
  readonly executablePath?: string | undefined;
}

export interface ShotBrowserInput {
  /** `--cdp-url` as typed. The env fallback is applied here, not by the caller. */
  readonly cdpFlag?: string | undefined;
  /** `--browser` as typed, before `PUPPETEER_EXECUTABLE_PATH` / `CHROME_PATH`. */
  readonly browserFlag?: string | undefined;
  readonly env: Readonly<Record<string, string | undefined>>;
}

/**
 * Decided before anything boots, because a typo must not cost an embedded Postgres — and, on the
 * attach path, a provider session — to report.
 *
 * The three rules, each chosen against a silent failure rather than for symmetry:
 *
 * 1. **Both FLAGS is refused, never ranked.** One names a Chrome to START and the other says the
 *    browser is somebody else's, so honouring either ignores what was typed.
 * 2. **An exported `SCRAPE_CDP_URL` loses to `--browser`.** A shell-wide default is not a typed
 *    intent. The alternative is a flag that parses, reports nothing and quietly attaches somewhere
 *    else — the `--critical` defect class `flag-reads.ts` exists for and cannot see here, because
 *    the flag IS read.
 * 3. **On an attach, no executable is read at all.** Checking the filesystem for a binary this run
 *    will never execute is how a correct remote capture gets refused on a box with no Chrome.
 */
export function shotBrowserChoice(input: ShotBrowserInput): ShotBrowserChoice {
  if (input.cdpFlag !== undefined && input.browserFlag !== undefined) {
    throw new BadFlagError({
      flag: 'cdp-url',
      command: 'shot',
      reason:
        '--browser names a Chrome to launch here and --cdp-url attaches to one already running',
      fix: CDP_FIX,
    });
  }
  const cdpUrl = input.browserFlag === undefined ? cdpUrlFrom(input.cdpFlag, input.env) : undefined;
  if (cdpUrl !== undefined) {
    const problem = cdpUrlProblem(cdpUrl);
    if (problem !== undefined) {
      throw new BadFlagError({
        flag: 'cdp-url',
        command: 'shot',
        reason: `"${cdpUrl}" ${problem}`,
        fix: CDP_FIX,
      });
    }
    return { cdpUrl };
  }
  const executablePath = executablePathFrom(input.browserFlag, input.env);
  if (executablePath !== undefined && !browserBinaryExists(executablePath)) {
    throw new BadFlagError({
      flag: 'browser',
      command: 'shot',
      reason: `no executable at "${executablePath}"`,
      fix: 'x shot / --browser /usr/bin/chromium',
    });
  }
  return executablePath === undefined ? {} : { executablePath };
}
