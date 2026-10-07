// No value `@ultimat3/core` exports is published again by another package, in any spelling: a
// re-export is a second import path for one value, and an agent picks one at random (axiom 1). The
// values are core's real module namespaces, never a hand list. Run by `bun run flight-copies`.

import * as coreIndex from '../../packages/core/src/index';
import * as corePage from '../../packages/core/src/page';
import { maskLiterals, stripComments } from '../../packages/core/src/source-mask';
import type { Finding } from './log';
import { lineOf } from './source-scan';

/** Core's `package.json` `exports`, each with its namespace — a test holds the two in agreement. */
export const CORE_ENTRIES: readonly {
  readonly subpath: string;
  readonly specifier: string;
  readonly values: readonly string[];
}[] = [
  { subpath: '.', specifier: '@ultimat3/core', values: Object.keys(coreIndex) },
  { subpath: './page', specifier: '@ultimat3/core/page', values: Object.keys(corePage) },
];

/** Every core value, to the specifier it should be imported from — the root entry when both carry it. */
export const CORE_VALUES: ReadonlyMap<string, string> = new Map(
  [...CORE_ENTRIES]
    .reverse()
    .flatMap((entry) => entry.values.map((name) => [name, entry.specifier] as const)),
);

const CORE_SPECIFIERS: ReadonlySet<string> = new Set(CORE_ENTRIES.map((e) => e.specifier));

/**
 * `<file>#<value>` re-exports allowed to stand, each with the argument for it. Empty on purpose:
 * every candidate measured on 2026-10-06 was a convenience path, deleted rather than pinned.
 */
export const CORE_REEXPORT_EXEMPT: ReadonlyMap<string, string> = new Map<string, string>([]);

/**
 * `<file>#<value>` re-exports found when the rule widened (2026-10-06) in packages another change
 * owned at the time: each is a DEBT with its owner, never an argument, and the gate stays green
 * only while the debt is real — `flight-copies.test.ts` fails on a row the tree no longer needs,
 * so a fixed site deletes its pin in the same change. Never add a row: fix the re-export instead.
 */
export const CORE_REEXPORT_PENDING: ReadonlyMap<string, string> = new Map<string, string>();

/** Whether `at#name` is allowed to stand today — a real exemption or a tracked debt. */
const pinned = (key: string): boolean =>
  CORE_REEXPORT_EXEMPT.has(key) || CORE_REEXPORT_PENDING.has(key);

export interface CoreReexport {
  /** The core export's own name, or `*` for the whole namespace. */
  readonly name: string;
  /** The name it is published under. */
  readonly alias: string;
  readonly index: number;
}

const SPEC = /^\s*(type\s+)?([\w$]+)(?:\s+as\s+([\w$]+))?\s*$/;

interface Spec {
  readonly local: string;
  readonly alias: string;
  readonly offset: number;
}

/** The value specifiers of a `{ … }` list starting at `start` — `type x` dropped. */
function valueSpecs(list: string, start: number): readonly Spec[] {
  const specs: Spec[] = [];
  for (const part of list.matchAll(/[^,]+/g)) {
    const spec = SPEC.exec(part[0]);
    if (spec === null || spec[1] !== undefined || spec[2] === undefined) continue;
    const offset = start + part.index + part[0].indexOf(spec[2]);
    specs.push({ local: spec[2], alias: spec[3] ?? spec[2], offset });
  }
  return specs;
}

/** The module specifier whose opening quote is at `quote` in the comment-stripped view. */
const specifierAt = (stripped: string, quote: number): string => {
  const end = stripped.indexOf(stripped[quote] as string, quote + 1);
  return end < 0 ? '' : stripped.slice(quote + 1, end);
};

const isCore = (stripped: string, match: RegExpMatchArray): boolean =>
  CORE_SPECIFIERS.has(specifierAt(stripped, (match.index ?? 0) + match[0].length - 1));

const RE_EXPORT = /\bexport\s*\{([^}]*)\}\s*from\s*['"]/g;
const NAMED_IMPORT = /\bimport\s*(type\s+)?\{([^}]*)\}\s*from\s*['"]/g;
const NAMESPACE_IMPORT = /\bimport\s*\*\s*as\s+([\w$]+)\s+from\s*['"]/g;
const LOCAL_EXPORT = /\bexport\s*\{([^}]*)\}(?!\s*from\b)/g;
const ALIAS_BINDING =
  /\bexport\s+(?:const|let|var)\s+([\w$]+)\s*(?::[^=;]+)?=\s*([\w$]+)(?:\s*\.\s*([\w$]+))?\s*;/g;

/**
 * Structure is read from the MASKED view, so a scaffold template that writes a re-export into a
 * generated app is a string and not a re-export; the specifier, a string, from the stripped view
 * at the same offset.
 */
export function coreReexports(text: string): readonly CoreReexport[] {
  const masked = maskLiterals(text);
  const stripped = stripComments(text);
  const hits: CoreReexport[] = [];
  const brace = (match: RegExpMatchArray): number => (match.index ?? 0) + match[0].indexOf('{') + 1;

  for (const match of masked.matchAll(RE_EXPORT)) {
    if (!isCore(stripped, match)) continue;
    for (const spec of valueSpecs(match[1] ?? '', brace(match))) {
      if (CORE_VALUES.has(spec.local)) hits.push({ ...spec, name: spec.local, index: spec.offset });
    }
  }

  // Local bindings of core values: `import { x as y }` binds `y` to core's `x`.
  const bound = new Map<string, string>();
  const namespaces = new Set<string>();
  for (const match of masked.matchAll(NAMED_IMPORT)) {
    if (match[1] !== undefined || !isCore(stripped, match)) continue;
    for (const spec of valueSpecs(match[2] ?? '', brace(match))) {
      if (CORE_VALUES.has(spec.local)) bound.set(spec.alias, spec.local);
    }
  }
  for (const match of masked.matchAll(NAMESPACE_IMPORT)) {
    if (isCore(stripped, match) && match[1] !== undefined) namespaces.add(match[1]);
  }
  if (bound.size === 0 && namespaces.size === 0) return hits;

  for (const match of masked.matchAll(LOCAL_EXPORT)) {
    for (const spec of valueSpecs(match[1] ?? '', brace(match))) {
      const name = namespaces.has(spec.local) ? '*' : bound.get(spec.local);
      if (name !== undefined) hits.push({ name, alias: spec.alias, index: spec.offset });
    }
  }
  for (const match of masked.matchAll(ALIAS_BINDING)) {
    const [, alias = '', head = '', member] = match;
    const name =
      member === undefined
        ? bound.get(head)
        : namespaces.has(head) && CORE_VALUES.has(member)
          ? member
          : undefined;
    if (name !== undefined) hits.push({ name, alias, index: match.index ?? 0 });
  }
  return hits.sort((a, b) => a.index - b.index);
}

/** Every `<file>#<value>` re-export in a file, pinned or not — what a stale pin is measured against. */
export const coreReexportKeys = (file: { readonly at: string; readonly text: string }): string[] =>
  file.at.startsWith('packages/core/')
    ? []
    : coreReexports(file.text).map((hit) => `${file.at}#${hit.name}`);

/** One finding per re-exported value, at its line; core itself and pinned rows are not. */
export function coreReexportViolations(file: {
  readonly at: string;
  readonly text: string;
}): readonly Finding[] {
  if (file.at.startsWith('packages/core/')) return [];
  return coreReexports(file.text)
    .filter((hit) => !pinned(`${file.at}#${hit.name}`))
    .map((hit): Finding => {
      const from = CORE_VALUES.get(hit.name) ?? '@ultimat3/core';
      const value = hit.name === '*' ? 'core namespace' : hit.name;
      const use =
        hit.name === '*'
          ? `import * as core from '${from}'`
          : `import { ${hit.name} } from '${from}'`;
      return {
        code: 'X_HELPER_COPY',
        cause: `${file.at}:${lineOf(file.text, hit.index)} is a second ${value} — a re-export of ${from}'s${hit.alias === hit.name ? '' : ` as \`${hit.alias}\``}, so one value has two import paths; ${from} is its one home`,
        fix: `${use} at every caller and delete the re-export in ${file.at}`,
        at: file.at,
      };
    });
}
