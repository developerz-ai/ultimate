// The four ways `x shot --island` refuses, beside their one thrower rather than in `errors.ts` —
// which is at the 500-line ceiling. The codes, their titles and the single `registerErrorCodes`
// call stay in `error-codes.ts`: one owner, one registration, one place a duplicate can surface.

import { renderCauseValue, renderFixLiteral, UltimateError } from '@ultimat3/core';

// No `docs:` on the subclasses below. `UltimateError` fills it from `describeErrorCode(code).docs`.

/** Neither path is the framework's: both arrive from an app's own declaration. */
const STATES_PLACEHOLDER = '<the states file the cause names>';

/**
 * A `*.island.states.ts` that exports no manifest — the author wrote `defineIslandStates(…)` and
 * did not `export` the result, or exported it from a file nothing else names. It expands to no
 * picture, so a run over it photographs nothing and reports success, which is the one outcome this
 * whole command exists to make impossible.
 */
export class IslandStatesFileEmptyError extends UltimateError {
  constructor(input: { readonly file: string }) {
    super({
      code: 'X_SHOT_ISLAND_STATES_EMPTY',
      cause: `${renderCauseValue(input.file)} exports no defineIslandStates() result, so it declares no picture`,
      fix: `in ${renderFixLiteral(input.file, STATES_PLACEHOLDER)} write: export const states = defineIslandStates({ island: '…', states: [...] })`,
    });
  }
}

/**
 * The page could not be photographed, and the reason is named. Every clause is something a picture
 * would have hidden rather than shown: a host element that never attached photographs the harness
 * chrome, a zero-sized box photographs whatever is behind it, and a box with no children is a
 * component that mounted and rendered nothing — each of which comes out as a plausible-looking
 * image of the wrong thing.
 */
export class IslandUnphotographableError extends UltimateError {
  constructor(input: {
    readonly island: string;
    readonly state: string;
    readonly theme: string;
    readonly reason: string;
    readonly fix: string;
  }) {
    super({
      code: 'X_SHOT_ISLAND_UNPHOTOGRAPHABLE',
      cause: `${input.island} in state ${renderCauseValue(input.state)} (${input.theme}) ${input.reason}`,
      fix: input.fix,
      meta: { island: input.island, state: input.state, theme: input.theme },
    });
  }
}

/**
 * The component asked the network for something no stub answers. Refused rather than allowed
 * through, because the alternative is the failure this command was built to prevent: a `fetch`
 * that quietly hangs leaves the component painting its own loading branch, and the picture then
 * shows a fixture gap dressed up as a real component state.
 */
export class IslandRequestUnstubbedError extends UltimateError {
  constructor(input: {
    readonly island: string;
    readonly state: string;
    readonly requests: readonly string[];
    readonly statesFile: string;
  }) {
    super({
      code: 'X_SHOT_ISLAND_UNSTUBBED_REQUEST',
      cause: `${input.island} in state ${renderCauseValue(input.state)} made ${input.requests.length} request(s) no stub answers: ${input.requests.join(', ')}`,
      fix: `in ${renderFixLiteral(input.statesFile, STATES_PLACEHOLDER)} add to that state: routes: [{ match: '${input.requests[0] ?? 'GET /api/x'}', respond: { kind: 'json', body: {} } }]`,
      meta: { island: input.island, state: input.state, requests: [...input.requests] },
    });
  }
}

/**
 * The gate that does not depend on the browser's own verdict: every declared state expands to a
 * file, and a file that is not on disk when the run ends is a picture nobody took. A capture loop
 * that swallowed one failure and exited 0 is exactly what this refuses, and it is checked against
 * the expansion computed before a browser existed rather than against what the loop believes it did.
 */
export class IslandShotsMissingError extends UltimateError {
  constructor(input: {
    readonly island: string;
    readonly missing: readonly string[];
    readonly expected: number;
    readonly dir: string;
  }) {
    super({
      code: 'X_SHOT_ISLAND_MISSING',
      cause: `${input.missing.length} of ${input.expected} declared picture(s) are not on disk under ${renderCauseValue(input.dir)}: ${input.missing.join(', ')}`,
      fix: `x shot --island ${input.island} --json   # the run above names why each one was refused`,
      meta: { island: input.island, missing: [...input.missing] },
    });
  }
}
