// The guard the whole design rests on: a `*.island.states.ts` file is PURE DATA, so the command
// that photographs the states, the harness page and a test can all read it — and one import of a
// sibling module leaves it readable by a bundler alone. Static, because a module importing Solid
// evaluates fine under Bun, so no amount of loading it can notice.

import {
  IslandStatesNotPureError,
  IslandStatesOpaqueImportError,
  IslandStatesSiblingImportError,
} from './island-state-errors';

/** Line and block comments blanked, so a specifier written in prose is never read as an import. */
const stripComments = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

/**
 * One edge of the file's module graph, carrying the single distinction that decides whether the
 * edge EXISTS at runtime: `verbatimModuleSyntax` erases a statement that begins `import type` /
 * `export type` and keeps every other one — including `import { type X } from './y'`, which it
 * emits as `import {} from './y'` and which therefore evaluates `./y`.
 */
export interface ModuleEdge {
  readonly specifier: string;
  readonly typeOnly: boolean;
}

/**
 * `from '<spec>'`, `import '<spec>'`, `import('<spec>')`, `require('<spec>')` — every static and
 * dynamic edge a Bun module graph can have, read off the text rather than by loading it. The
 * leading `type` is captured with the statement rather than guessed at afterwards; the lookahead
 * is what keeps `import type from './y'` (a default import NAMED type) a value import.
 */
const EDGE =
  /\b(?:import|export)\s+(?<only>type\s+(?!from\s*['"]))?[^'"();]*?\bfrom\s*['"](?<from>[^'"]+)['"]|\bimport\s*\(\s*['"](?<dynamic>[^'"]+)['"]|\brequire\s*\(\s*['"](?<required>[^'"]+)['"]|\bimport\s+['"](?<bare>[^'"]+)['"]/g;

/** Every module edge the text declares, in source order, type-only ones included. */
export function moduleEdges(source: string): readonly ModuleEdge[] {
  const edges: ModuleEdge[] = [];
  for (const match of stripComments(source).matchAll(EDGE)) {
    const groups = match.groups;
    if (groups === undefined) continue;
    const from = groups['from'];
    const specifier = from ?? groups['dynamic'] ?? groups['required'] ?? groups['bare'];
    if (specifier === undefined) continue;
    edges.push({ specifier, typeOnly: from !== undefined && groups['only'] !== undefined });
  }
  return edges;
}

/** Backwards-compatible view: the specifiers alone, which cannot say whether one is erased. */
export function importSpecifiers(source: string): readonly string[] {
  return moduleEdges(source).map((edge) => edge.specifier);
}

/**
 * An `import(…)` / `require(…)` whose argument is not a string literal. Captured up to the closing
 * paren or the end of the line, so the refusal can quote the expression the reader must rewrite.
 */
const COMPUTED = /\b(?:import|require)\s*\(\s*(?!['")])(?<expression>[^)\n]{1,60})/g;

/** A specifier resolved against this file's own directory, `.json` excluded — see below. */
const RELATIVE = /^\.\.?\//;

/**
 * A specifier that is PROVABLY a browser module: JSX, or the renderer one import earlier. Its own
 * predicate because it is what the older refusal — delete this import — is the right edit for.
 */
export function browserSpecifier(specifier: string): boolean {
  return (
    specifier === 'solid-js' ||
    specifier.startsWith('solid-js/') ||
    specifier.endsWith('.tsx') ||
    specifier.endsWith('.jsx')
  );
}

/**
 * What a states file may not reach for at RUNTIME, which is a wider set than the one above.
 *
 * Any RELATIVE specifier counts, and that is the rule with teeth: it names a module whose own
 * imports this scanner never sees. `./settings.island` resolves to `./settings.island.tsx` under
 * Bun and read as pure until 2026-08-23 — an extension test answers about the spelling and not
 * about the graph — and `./helpers` is the same edge one hop longer. The relativeness is the rule
 * rather than the `.island` stem, which is also why nothing here restates `@ultimat3/render`'s
 * `ISLAND_EXTENSION`.
 *
 * `.json` is the one exemption, and it is the only one that can be safe: a JSON module has no
 * imports, so it is the single relative target whose graph needs no following.
 *
 * A BARE specifier other than `solid-js` is not followed either and is deliberately not refused —
 * a package list here would be the drift a list always is. `@ultimat3/ui` in a states file is
 * therefore an open hole, named in this package's CLAUDE.md rather than left silent.
 */
export function impureSpecifier(specifier: string): boolean {
  return browserSpecifier(specifier) || (RELATIVE.test(specifier) && !specifier.endsWith('.json'));
}

/** Which refusal the fault carries — the reader's edit differs by kind, so the class does too. */
export type IslandFaultKind = 'browser' | 'sibling' | 'opaque';

export interface IslandStatesFault {
  readonly kind: IslandFaultKind;
  /** The specifier, or — for `opaque` — the expression text that stands where one should be. */
  readonly specifier: string;
}

/**
 * The first thing that breaks the rule, or `undefined`. NOT total: a specifier this cannot read is
 * reported as `opaque` rather than passed, because "unreadable, therefore pure" is exactly the
 * optimism that let an extensionless import of the component through.
 */
export function islandStatesFault(source: string): IslandStatesFault | undefined {
  for (const edge of moduleEdges(source)) {
    // A type-only edge is erased before the module is ever evaluated — proved against Bun in
    // `island-states-pure.test.ts`, because the whole exemption rests on it. It is also the one
    // way a states file may name its component, and the reference app types its props that way.
    if (edge.typeOnly) continue;
    if (!impureSpecifier(edge.specifier)) continue;
    // A specifier that is PROVABLY a browser module keeps the older refusal and its older edit —
    // deleting `import './x.island.tsx'` is the instruction, not writing it as a type import.
    return {
      kind: browserSpecifier(edge.specifier) ? 'browser' : 'sibling',
      specifier: edge.specifier,
    };
  }
  const computed = stripComments(source).match(COMPUTED);
  const expression = computed?.[0]?.replace(/^\s*(?:import|require)\s*\(\s*/, '').trim();
  return expression === undefined ? undefined : { kind: 'opaque', specifier: expression };
}

/** The first specifier that breaks the rule, or `undefined`. */
export function islandStatesImportFault(source: string): string | undefined {
  return islandStatesFault(source)?.specifier;
}

/** The same rule, as a refusal. `file` is only ever named back to the reader, never resolved here. */
export function assertIslandStatesPure(file: string, source: string): void {
  const fault = islandStatesFault(source);
  if (fault === undefined) return;
  if (fault.kind === 'opaque') {
    throw new IslandStatesOpaqueImportError({ file, expression: fault.specifier });
  }
  const input = { file, specifier: fault.specifier };
  throw fault.kind === 'sibling'
    ? new IslandStatesSiblingImportError(input)
    : new IslandStatesNotPureError(input);
}
