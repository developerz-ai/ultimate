// Each exported name of an entry `.d.ts`, followed through re-exports to its normalised
// declaration text — what `public-api-surface.ts` hashes and shapes. Keyed by name, never by position, so reordering an export list or the imports above it
// changes nothing; a non-exported local type a declaration names is folded into its text.

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

/**
 * name → that name's normalised declaration, then a `local …` line per local type it names, then
 * an `inherits …` line per ancestor interface (shape only: `public-api-surface.ts` never hashes it).
 */
export type SymbolTexts = Readonly<Record<string, string>>;

export const digest = (text: string): string =>
  new Bun.CryptoHasher('sha256').update(text).digest('hex').slice(0, 16);

const sortedRecord = (map: ReadonlyMap<string, string>): Record<string, string> =>
  Object.fromEntries([...map].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));

/** The resolver over one emitted tree; memoised per file, cycle-safe. */
export function symbolReader(tree: DtsTree): (file: string) => SymbolTexts {
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

  /** The interfaces an `interface … extends A, B<…> {` line names, by their first word. */
  const parentsOf = (line: string): string[] => {
    const words = line.split(' ');
    const from = words.indexOf('extends');
    const open = words.indexOf('{');
    if (words[0] !== 'interface' || from === -1 || (open !== -1 && open < from)) return [];
    const names: string[] = [];
    let depth = 0;
    let expecting = true;
    for (const word of words.slice(from + 1, open === -1 ? undefined : open)) {
      if (depth === 0 && expecting && /^[\w$]+$/.test(word)) names.push(word);
      expecting = depth === 0 && word === ',';
      if (word === '<') depth += 1;
      else if (word === '>') depth -= 1;
    }
    return names;
  };

  /**
   * One `inherits <declaration>` line per ancestor interface, followed through imports. Read by the
   * shape, never by the hash (`public-api-surface.ts`): a parent is judged as its own symbol, and
   * this only lets a member re-declared from it be told from a new requirement.
   */
  const inheritsOf = (
    file: string,
    module: DtsModule,
    line: string,
    seen: Set<string>,
  ): string[] => {
    const out: string[] = [];
    for (const parent of parentsOf(line)) {
      if (seen.has(parent)) continue;
      seen.add(parent);
      const [head = '', ...rest] = textOf(file, module, parent).split('\n');
      if (!head.startsWith('interface ')) continue;
      out.push(`inherits ${head}`);
      const carried = rest.filter((one) => one.startsWith('inherits '));
      if (carried.length > 0) out.push(...carried);
      else if (module.declarations.some((one) => one.name === parent)) {
        out.push(...inheritsOf(file, module, head, seen));
      }
    }
    return out;
  };

  /** `textOf`, with the `inherits` lines of an interface's ancestors after it. */
  const withParents = (file: string, module: DtsModule, local: string): string => {
    const text = textOf(file, module, local);
    const lines = inheritsOf(file, module, text.split('\n')[0] ?? '', new Set([local]));
    return lines.length === 0 ? text : [text, ...lines].join('\n');
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
      if (one.exported) out.set(one.name, withParents(file, module, one.name));
    }
    for (const spec of module.lists) out.set(spec.name, withParents(file, module, spec.local));
    for (const spec of module.reexports) out.set(spec.name, foreign(file, spec.from, spec.local));
    visiting.delete(file);
    exported.set(file, out);
    return out;
  };

  return (file) => sortedRecord(exportsOf(file));
}
