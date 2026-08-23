// The ten X_TEST_ISLAND_STATE* codes, apart from ./errors only because one file has one job and the
// catalogue is already at its ceiling. The codes themselves, their titles and the single
// `registerErrorCodes` call stay in ./errors — one owner, one registration, one place a duplicate
// can surface.

import { renderCauseValue, renderFixLiteral, UltimateError } from '@ultimat3/core';

// No `docs:` on the subclasses below. `UltimateError` fills it from `describeErrorCode(code).docs`.

/** Neither path is controlled by the framework: both arrive from an app's own declaration. */
const ISLAND_PLACEHOLDER = '<the island path the cause names>';

/** The same, for the three refusals whose subject is the states file rather than the island. */
const STATES_PLACEHOLDER = '<the states file the cause names>';

/**
 * The file a `defineIslandStates` call for this island lives in, by convention: the island's own
 * name with `.states.ts` where `.tsx` was. Spelled here, in the leaf module, because every error
 * below has to name the file the reader must edit and an error may never import the module that
 * throws it. Only `.tsx` is read — the island EXTENSION is `@ultimat3/render`'s constant and is
 * deliberately not restated in this package.
 */
export function islandStatesFile(island: string): string {
  return island.endsWith('.tsx')
    ? `${island.slice(0, -'.tsx'.length)}.states.ts`
    : `${island}.states.ts`;
}

const at = (island: string): string =>
  renderFixLiteral(islandStatesFile(island), ISLAND_PLACEHOLDER);

/**
 * A manifest that declares no states. It parses, it registers and it expands to nothing — so the
 * command that photographs it produces no file and exits 0, which is the one outcome a reader
 * cannot tell from success. Refused at the declaration, where the file to edit is known.
 */
export class IslandStatesEmptyError extends UltimateError {
  constructor(input: { readonly island: string }) {
    super({
      code: 'X_TEST_ISLAND_STATES_EMPTY',
      cause: `defineIslandStates(${renderCauseValue(input.island)}) declares no states, so it can never produce a picture`,
      fix: `in ${at(input.island)} add: states: [{ id: 'empty', title: 'no rows yet', props: {} }]`,
    });
  }
}

/**
 * A state id that is not a slug. The id becomes a FILENAME stem, so a space, a slash or a capital
 * is either an unguessable path or a path outside the shot directory. The suggestion is the id
 * slugified, so the edit is a paste rather than a decision.
 */
export class IslandStateIdInvalidError extends UltimateError {
  constructor(input: { readonly island: string; readonly id: string; readonly slug: string }) {
    super({
      code: 'X_TEST_ISLAND_STATE_ID_INVALID',
      cause: `island state id ${renderCauseValue(input.id)} is not a slug — it becomes the screenshot filename stem`,
      fix:
        input.slug.length === 0
          ? `in ${at(input.island)} give the state an id of lowercase letters, digits and single dashes: id: 'over-quota'`
          : `in ${at(input.island)} write: id: '${input.slug}'`,
    });
  }
}

/**
 * Two states with one id. The second picture overwrites the first at the same path, so the run
 * reports two states and leaves one file — a loss with nothing in the output pointing at it.
 */
export class IslandStateDuplicateError extends UltimateError {
  constructor(input: { readonly island: string; readonly id: string }) {
    super({
      code: 'X_TEST_ISLAND_STATE_DUPLICATE',
      cause: `two island states share the id ${renderCauseValue(input.id)}; the second picture would overwrite the first`,
      fix: `in ${at(input.island)} rename one of them — id: '${input.id}-2', or the state it really is: id: 'over-quota'`,
    });
  }
}

/**
 * A value that `JSON.stringify` does not carry. Island props ride the `data-x-props` script tag,
 * which is JSON — so a `Date`, a function, a `Map` or an `undefined` is not "slightly wrong" in the
 * picture, it is a prop the component never receives. Refused where the path is still known.
 */
export class IslandStateJsonInvalidError extends UltimateError {
  constructor(input: { readonly island: string; readonly path: string; readonly reason: string }) {
    super({
      code: 'X_TEST_ISLAND_STATE_JSON_INVALID',
      cause: `${input.path} is ${input.reason}, and island props travel as JSON in data-x-props`,
      fix: `in ${at(input.island)} write ${input.path} as JSON — a string, a number, a boolean, null, an array or a plain object`,
    });
  }
}

/**
 * The zone a picture is rendered in. A harness that freezes the INSTANT and leaves the zone ambient
 * renders every date in the host machine's, so the same state photographs differently on two
 * machines and the review diff reports a component change that never happened.
 *
 * Its own class beside the one below, sharing one code: two conditions, two instructions, and a
 * `fix:` assembled by a ternary is a `fix:` the gate's own scanner reads only half of.
 */
export class IslandStateZoneInvalidError extends UltimateError {
  constructor(input: { readonly island: string; readonly value: unknown }) {
    super({
      code: 'X_TEST_ISLAND_STATE_CLOCK_INVALID',
      cause: `timeZone ${renderCauseValue(input.value)} is not an IANA zone, so a rendered date would fall back to the host's`,
      fix: `in ${at(input.island)} write: timeZone: 'UTC' — or one of Intl.supportedValuesOf('timeZone')`,
    });
  }
}

/** The frozen instant, with no offset on it — a different moment on every machine that reads it. */
export class IslandStateInstantInvalidError extends UltimateError {
  constructor(input: { readonly island: string; readonly value: unknown }) {
    super({
      code: 'X_TEST_ISLAND_STATE_CLOCK_INVALID',
      cause: `now ${renderCauseValue(input.value)} carries no explicit offset, so it means a different moment on every machine`,
      fix: `in ${at(input.island)} write: now: '2026-01-01T00:00:00.000Z' — an ISO instant ending in Z or an offset`,
    });
  }
}

/**
 * A route stub whose `match` cannot match. It is a `"<METHOD> <pathname>"` prefix, so a bare path
 * or a lowercase verb silently stubs nothing: the component fetches for real, the request is
 * refused by the sealed network, and the picture shows an error state nobody declared.
 */
export class IslandStateStubInvalidError extends UltimateError {
  constructor(input: { readonly island: string; readonly match: string }) {
    super({
      code: 'X_TEST_ISLAND_STATE_STUB_INVALID',
      cause: `route stub ${renderCauseValue(input.match)} is not "<METHOD> <pathname>", so it would match no request`,
      fix: `in ${at(input.island)} write: { match: 'GET /api/settings', respond: { kind: 'json', body: {} } }`,
    });
  }
}

/**
 * A states file that imports the component it describes. The whole design rests on this file being
 * readable from Bun with no browser and no bundle — the command must know the complete expected
 * screenshot list BEFORE a browser exists, or "produced nothing and exited 0" is indistinguishable
 * from success. One JSX import makes the file unreadable by every consumer but the browser.
 */
export class IslandStatesNotPureError extends UltimateError {
  constructor(input: { readonly file: string; readonly specifier: string }) {
    super({
      code: 'X_TEST_ISLAND_STATES_NOT_PURE',
      cause: `${renderCauseValue(input.file)} imports ${renderCauseValue(input.specifier)} — a states file is pure data and is read without a browser`,
      fix: `in ${renderFixLiteral(input.file, STATES_PLACEHOLDER)} delete the import of ${renderCauseValue(input.specifier)} and declare the props as JSON instead`,
    });
  }
}

/**
 * A states file that value-imports a SIBLING module. Its own class beside the one above, sharing
 * one code, because the edit is a different one: `./settings.island` resolves to
 * `./settings.island.tsx` under Bun, so the import the reader must repair is usually a missing
 * `type` keyword rather than an import to delete — and `./helpers` may reach the component one hop
 * further on, which a rule reading ONE file's text can never follow.
 */
export class IslandStatesSiblingImportError extends UltimateError {
  constructor(input: { readonly file: string; readonly specifier: string }) {
    super({
      code: 'X_TEST_ISLAND_STATES_NOT_PURE',
      cause: `${renderCauseValue(input.file)} imports ${renderCauseValue(input.specifier)} at runtime, and a sibling module can reach the component the states file may not`,
      fix: `in ${renderFixLiteral(input.file, STATES_PLACEHOLDER)} write: import type { Props } from ${renderFixLiteral(input.specifier, '<the specifier the cause names>')} — a type-only import is erased, and a value one must be inlined as JSON`,
    });
  }
}

/**
 * A specifier this scanner cannot read: `import(`./${name}.island`)`, `require(SPEC)`. Its own
 * class for the same reason as the one above — the edit is to write the specifier as a literal, so
 * a static reader can judge it. Answering PURE over an unreadable import is the optimism the
 * extensionless case already shipped once.
 */
export class IslandStatesOpaqueImportError extends UltimateError {
  constructor(input: { readonly file: string; readonly expression: string }) {
    super({
      code: 'X_TEST_ISLAND_STATES_NOT_PURE',
      cause: `${renderCauseValue(input.file)} computes the import ${renderCauseValue(input.expression)}, so no reader can say where it goes without running it`,
      fix: `in ${renderFixLiteral(input.file, STATES_PLACEHOLDER)} write the specifier as a string literal, or delete the import and inline what it exports as JSON`,
    });
  }
}

/**
 * A declared island that is not on disk. Always a real defect and never a warning: the state list
 * is the expected screenshot set, so a manifest pointing at a moved file expands to pictures that
 * can never be taken.
 */
export class IslandStatesMissingFileError extends UltimateError {
  constructor(input: { readonly island: string; readonly root: string }) {
    super({
      code: 'X_TEST_ISLAND_STATES_MISSING_FILE',
      cause: `no file at ${renderCauseValue(input.island)} under ${renderCauseValue(input.root)}, so its declared states can never be photographed`,
      fix: `in ${at(input.island)} set island to the path that exists — it is relative to the app root, not to the states file`,
    });
  }
}

/**
 * A name nothing answers to. Listing every valid name is the whole value: a typo and an island
 * whose states were never declared are one symptom and two different edits, and only the list tells
 * them apart without opening a directory.
 */
export class IslandStatesUnknownError extends UltimateError {
  constructor(input: { readonly name: string; readonly known: readonly string[] }) {
    super({
      code: 'X_TEST_ISLAND_STATES_UNKNOWN',
      cause:
        input.known.length === 0
          ? `no island states are declared in this process, so ${renderCauseValue(input.name)} resolves to nothing`
          : `no island states answer to ${renderCauseValue(input.name)}; declared: ${input.known.join(', ')}`,
      fix:
        input.known.length === 0
          ? "declare one beside the island: export const states = defineIslandStates({ island: 'apps/web/app/settings/settings.island.tsx', states: [...] })"
          : `name one of them instead: ${input.known[0] ?? ''}`,
    });
  }
}

/**
 * Two manifests answering to one name. Resolution is loose on purpose — `Settings`, `settings` and
 * `settings.island.tsx` are one name — and that looseness is exactly what makes two islands with
 * the same basename ambiguous. Refused when the set is loaded, not when a picture is missing.
 */
export class IslandStatesAmbiguousError extends UltimateError {
  constructor(input: { readonly name: string; readonly islands: readonly string[] }) {
    super({
      code: 'X_TEST_ISLAND_STATES_AMBIGUOUS',
      cause: `${input.islands.length} islands answer to ${renderCauseValue(input.name)}: ${input.islands.join(', ')}`,
      fix: `rename one island file so the two basenames differ — the basename is the shot directory, so today they would share one`,
    });
  }
}
