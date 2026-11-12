// The browser-graph half of `x fix boundary`, pure: HOW an entry (an island) reaches a module, and
// WHAT a module takes from a barrel. A server barrel found three hops below an island is the
// island's mistake when the module importing it is server code — the edge to cut is the entry's
// first hop, and only the chain says which one that is.

import { stripComments } from '@ultimat3/core';
import type { ClosureHost } from './import-closure';
import { parseModule, resolveSpec } from './import-closure';
import { lineIndex } from './ts-scan';

/** The path an entry takes to a module, and the import in the entry that starts it. */
export interface ImportChain {
  /** Entry first, the module last; `[module]` when the module is the entry. */
  readonly chain: readonly string[];
  /** The entry's specifier for `chain[1]` and the line it is written on; absent for `[module]`. */
  readonly hop?: { readonly spec: string; readonly line: number };
}

/** Every specifier a module's text can load: value imports, side effects, re-exports, stars. */
const specifiersOf = (source: string): readonly string[] => {
  const shape = parseModule(source);
  return [
    ...shape.imports.map((one) => one.spec),
    ...shape.effects,
    ...shape.reexports.map((one) => one.spec),
    ...shape.stars,
  ];
};

/** The 1-based line of the first import or re-export in `source` that names `spec`. */
export function specLine(source: string, spec: string): number {
  const code = stripComments(source);
  const quoted = [`'${spec}'`, `"${spec}"`].map((one) => code.indexOf(one)).filter((at) => at >= 0);
  return quoted.length === 0 ? 1 : lineIndex(code)(Math.min(...quoted));
}

/** Breadth first, so the chain printed is the shortest — the one a reader can follow by eye. */
export function importChain(
  host: ClosureHost,
  entry: string,
  target: string,
): ImportChain | undefined {
  if (entry === target) return { chain: [target] };
  const parent = new Map<string, { readonly from: string; readonly spec: string }>();
  const queue = [entry];
  const seen = new Set(queue);
  for (let at = queue.shift(); at !== undefined; at = queue.shift()) {
    for (const spec of specifiersOf(host.read(at) ?? '')) {
      const next = resolveSpec(host, at, spec);
      if (next === undefined || seen.has(next)) continue;
      seen.add(next);
      parent.set(next, { from: at, spec });
      if (next === target) return chainTo(host, parent, entry, target);
      queue.push(next);
    }
  }
  return undefined;
}

function chainTo(
  host: ClosureHost,
  parent: ReadonlyMap<string, { readonly from: string; readonly spec: string }>,
  entry: string,
  target: string,
): ImportChain {
  const chain = [target];
  let spec = '';
  for (let step = parent.get(target); step !== undefined; step = parent.get(step.from)) {
    chain.unshift(step.from);
    spec = step.spec;
  }
  return { chain, hop: { spec, line: specLine(host.read(entry) ?? '', spec) } };
}

/**
 * The value names `source` takes from `spec`, or `'*'` when it takes the whole module (a namespace,
 * a side-effect import, a dynamic `import()`, an `export *`) — which no browser entry can promise.
 */
export function namesFrom(source: string, spec: string): readonly string[] | '*' {
  const shape = parseModule(source);
  if (shape.effects.includes(spec) || shape.stars.includes(spec)) return '*';
  const names = new Set<string>();
  for (const one of shape.imports) {
    if (one.spec !== spec) continue;
    if (one.names === '*') return '*';
    for (const name of one.names) names.add(name);
  }
  for (const one of shape.reexports) {
    if (one.spec === spec) for (const name of one.map.values()) names.add(name);
  }
  return [...names].sort();
}

const DECLARED =
  /\bexport\s+(?:declare\s+)?(?:async\s+)?(?:function\*?|const|let|var|class|abstract\s+class|enum|type|interface|namespace)\s+([\w$]+)/g;
const LISTED = /\bexport\s+(?:type\s+)?\{([^}]*)\}/g;

/**
 * Every name a module exports, types included, or `undefined` when an `export *` makes the list
 * unknowable from its own text — the caller then cannot promise a swap is safe.
 */
export function exportedNames(source: string): ReadonlySet<string> | undefined {
  const code = stripComments(source);
  if (/\bexport\s+\*/.test(code)) return undefined;
  const names = new Set<string>();
  for (const found of code.matchAll(DECLARED)) names.add(found[1] ?? '');
  for (const found of code.matchAll(LISTED)) {
    for (const part of (found[1] ?? '').split(',')) {
      const name = part
        .trim()
        .replace(/^type\s+/, '')
        .split(/\s+as\s+/)
        .at(-1)
        ?.trim();
      if (name !== undefined && name !== '') names.add(name);
    }
  }
  return names;
}
