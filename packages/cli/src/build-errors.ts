// The CLI's build and bundle refusals: an entry an app does not have, an island that will not
// compile, a framework browser script that will not bundle. Split from `errors.ts` at its 500-line
// ceiling; `errors.ts` re-exports every name, so no import site moves.

import { UltimateError } from '@ultimat3/core';
import type { Finding } from './output';
import { quoteArg } from './shell-quote';

/**
 * A build target names an entry file the app does not have. `x build` refuses before it spawns the
 * builder: `bun build`'s own "module not found" says nothing about which file an Ultimate app is
 * supposed to own, and `docker build`'s says nothing about which target wanted it.
 */
export class BuildEntryMissingError extends UltimateError {
  constructor(input: { target: string; entry: string }) {
    super({
      code: 'X_BUILD_ENTRY_MISSING',
      cause: `x build --target ${input.target} builds from ${input.entry}, and the app does not have it`,
      fix: `x new scratch-app --dry-run --json   # its file list carries ${input.entry}; copy that file into this app`,
    });
  }
}

/**
 * A client entry would not compile. `X_BUILD_FAILED`, not a code of its own: an island is a bundle
 * entry point like any other, and the target's own logs are what says which line. The fix builds
 * exactly that one file, so the next message an author reads is the compiler's and not the CLI's.
 */
export class IslandBuildFailedError extends UltimateError {
  constructor(input: { file: string; logs: string }) {
    super({
      code: 'X_BUILD_FAILED',
      cause: `${input.file} is an island entry point and would not bundle: ${input.logs}`,
      fix: `bun build --target browser ${input.file}`,
    });
  }
}

/** Which framework script a page ships: the sync worker, the page boot, or the client router. */
export type FrameworkScriptKind = 'sync worker' | 'page boot' | 'client router';

/**
 * One of the page's framework scripts would not bundle. Same code as an island: "a browser entry
 * the framework builds did not build" is one condition, and the entry here is framework code, not
 * the app's — the cause names WHICH script, so the reader knows what the page is now missing.
 */
export class FrameworkScriptBuildFailedError extends UltimateError {
  constructor(input: { what: FrameworkScriptKind; entry: string; logs: string }) {
    super({
      code: 'X_BUILD_FAILED',
      cause: `the ${input.what} (${input.entry}) would not bundle for the browser: ${input.logs}`,
      fix: `bun build --target browser --format iife ${quoteArg(input.entry)}`,
    });
  }
}

/**
 * A static build over an app whose modules did not all import. The route registry is filled BY the
 * import, so a page whose module threw is not skipped but absent — and an export without it, with
 * `x build` green, is a deploy that deletes a page. The `manifest` step owns load findings
 * (`load-findings.ts`), so the fix is the command that lists every one with its own fix.
 */
export class PrerenderLoadFailedError extends UltimateError {
  constructor(findings: readonly Finding[]) {
    const listed = findings.map((finding) =>
      finding.at === undefined
        ? `${finding.code} ${finding.cause}`
        : `${finding.at}: ${finding.code} ${finding.cause}`,
    );
    super({
      code: 'X_BUILD_FAILED',
      cause: `the static export renders the routes the app's modules register, and ${findings.length} module load finding(s) left it short: ${listed.join('; ')}`,
      fix: 'x verify --only manifest --json',
    });
  }
}
