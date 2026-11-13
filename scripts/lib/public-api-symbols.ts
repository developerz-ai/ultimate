// Each exported name of an entry `.d.ts`, followed through re-exports to its declaration and
// hashed. Keyed by name, never by position, so reordering an export list or the imports above it
// changes nothing; a non-exported local type a declaration names is folded into its hash.

// why: Bun ships no path API; `posix` because every key here is `/`-separated on every OS.
import { posix } from 'node:path';
import type { Declared, DtsModule } from './public-api-dts';
import { parseDts } from './public-api-dts';

export interface DtsTree {
  /** Emitted `.d.ts` text by `/`-separated path. */
  readonly files: ReadonlyMap<string, string>;
  /** A bare specifier (`@ultimat3/core/page`) → the `.d.ts` path that answers it. */
  readonly specifiers: ReadonlyMap<string, string>;
}

/** name → sha-256 (16 hex) of that name's normalised declaration. */
export type SymbolHashes = Readonly<Record<string, string>>;

export const digest = (text: string): string =>
  new Bun.CryptoHasher('sha256').update(text).digest('hex').slice(0, 16);

const sortedRecord = (map: ReadonlyMap<string, string>): Record<string, string> =>
  Object.fromEntries([...map].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));

/** The resolver over one emitted tree; memoised per file, cycle-safe. */
export function symbolReader(tree: DtsTree): (file: string) => SymbolHashes {
  const parsed = new Map<string, DtsModule>();
  const exported = new Map<string, ReadonlyMap<string, string>>();
  const visiting = new Set<string>();

  const moduleOf = (file: string): DtsModule | undefined => {
    const cached = parsed.get(file);
    if (cached !== undefined) return cached;
    const text = tree.files.get(file);
    if (text === undefined) return undefined;
    const module = parseDts(text);
    parsed.set(file, module);
    return module;
  };

  const resolve = (from: string, spec: string): string | undefined => {
    if (!spec.startsWith('.')) return tree.specifiers.get(spec);
    const base = posix.join(posix.dirname(from), spec).replace(/\.(?:d\.ts|tsx?|m?js)$/, '');
    return [`${base}.d.ts`, `${base}/index.d.ts`].find((candidate) => tree.files.has(candidate));
  };

  const hiddenDecls = new WeakMap<DtsModule, ReadonlyMap<string, readonly Declared[]>>();
  const hiddenOf = (module: DtsModule): ReadonlyMap<string, readonly Declared[]> => {
    const cached = hiddenDecls.get(module);
    if (cached !== undefined) return cached;
    const listed = new Set(module.lists.map((spec) => spec.local));
    const hidden = new Map<string, Declared[]>();
    for (const one of module.declarations) {
      if (one.exported || listed.has(one.name)) continue;
      hidden.set(one.name, [...(hidden.get(one.name) ?? []), one]);
    }
    hiddenDecls.set(module, hidden);
    return hidden;
  };

  /** A declaration's own text plus, transitively, every non-exported local it names. */
  const localText = (module: DtsModule, name: string): string | undefined => {
    const own = module.declarations.filter((one) => one.name === name);
    if (own.length === 0) return undefined;
    const hidden = hiddenOf(module);
    const seen = new Set([name]);
    const texts = own.map((one) => one.text);
    const queue = [...texts];
    while (queue.length > 0) {
      for (const word of (queue.shift() ?? '').split(' ')) {
        const found = hidden.get(word);
        if (found === undefined || seen.has(word)) continue;
        seen.add(word);
        const more = found.map((one) => one.text);
        texts.push(...more.map((text) => `local ${text}`));
        queue.push(...more);
      }
    }
    return texts.join('\n');
  };

  const foreign = (from: string, spec: string, name: string): string => {
    const target = resolve(from, spec);
    if (target === undefined) return `external ${spec} ${name}`;
    if (name === '*') return namespaceText(target);
    return exportsOf(target).get(name) ?? `unresolved ${spec} ${name}`;
  };

  const namespaceText = (file: string): string =>
    Object.entries(sortedRecord(exportsOf(file)))
      .map(([name, text]) => `${name}=${digest(text)}`)
      .join(',');

  /** What `local` names inside `file`: a declaration there, or an import followed out. */
  const textOf = (file: string, module: DtsModule, local: string): string => {
    const own = localText(module, local);
    if (own !== undefined) return own;
    const binding = module.imports.find((one) => one.local === local);
    if (binding === undefined) return `unresolved ${local}`;
    return foreign(file, binding.from, binding.imported);
  };

  const exportsOf = (file: string): ReadonlyMap<string, string> => {
    const done = exported.get(file);
    if (done !== undefined) return done;
    const module = moduleOf(file);
    if (module === undefined || visiting.has(file)) return new Map();
    visiting.add(file);
    const out = new Map<string, string>();
    for (const star of module.stars) {
      if (star.as !== undefined) {
        const target = resolve(file, star.from);
        out.set(star.as, target === undefined ? `external ${star.from} *` : namespaceText(target));
        continue;
      }
      const target = resolve(file, star.from);
      if (target !== undefined) for (const [name, text] of exportsOf(target)) out.set(name, text);
    }
    for (const one of module.declarations) {
      if (one.exported) out.set(one.name, textOf(file, module, one.name));
    }
    for (const spec of module.lists) out.set(spec.name, textOf(file, module, spec.local));
    for (const spec of module.reexports) out.set(spec.name, foreign(file, spec.from, spec.local));
    visiting.delete(file);
    exported.set(file, out);
    return out;
  };

  return (file) => {
    const hashes = new Map<string, string>();
    for (const [name, text] of exportsOf(file)) hashes.set(name, digest(text));
    return sortedRecord(hashes);
  };
}
