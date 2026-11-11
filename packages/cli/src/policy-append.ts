// A second permission set into a slice's existing `policy.ts`: the generated module's body
// appended, its imports folded into the ones already there. A pure merge edit over two sources —
// `x g policy <name> --feature <slice>` used to overwrite the author's rules or refuse outright.

/** `import { a, b } from 'm';` on one line: the shape every policy template emits. */
const NAMED_IMPORT = /^import \{ (?<names>[^}]+) \} from '(?<from>[^']+)';$/;

/** Every top-level binding a module exports by declaration. */
const exportedNames = (source: string): ReadonlySet<string> =>
  new Set(
    [...source.matchAll(/^export (?:const|let|function|class|interface|type|enum) (\w+)/gm)].map(
      (match) => match[1] ?? '',
    ),
  );

/** Biome's order for named specifiers, case-folded and by code unit: never `Intl`, whose order
 * moves with the machine's ICU. */
const sortNames = (names: readonly string[]): readonly string[] =>
  [...names].sort((a, b) => {
    const [x, y] = [a.toLowerCase(), b.toLowerCase()];
    return x < y ? -1 : x > y ? 1 : 0;
  });

/** A named import over one line or several, as Biome wraps one past the line width. */
const importOf = (from: string): RegExp =>
  new RegExp(
    `^import \\{(?<names>[^}]*)\\} from '${from.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}';$`,
    'm',
  );

const namesIn = (list: string): readonly string[] =>
  list
    .split(',')
    .map((name) => name.trim())
    .filter((name) => name !== '');

/** Where a new import line goes: before the first import whose specifier sorts after it. */
function insertImport(source: string, line: string, from: string): string {
  const statements = [...source.matchAll(/^import [^;]*? from '(?<from>[^']+)';$/gm)];
  const next = statements.find((each) => {
    const specifier = each.groups?.['from'] ?? '';
    return !specifier.startsWith('.') && specifier > from;
  });
  const last = statements.at(-1);
  const at = next?.index ?? (last === undefined ? 0 : (last.index ?? 0) + last[0].length + 1);
  return `${source.slice(0, at)}${line}\n${source.slice(at)}`;
}

/** `existing` with each named import of `wanted` present, merged into one from the same module. */
function foldImports(existing: string, wanted: readonly string[]): string {
  let source = existing;
  for (const line of wanted) {
    const groups = NAMED_IMPORT.exec(line)?.groups;
    if (groups === undefined) continue;
    const from = groups['from'] ?? '';
    const names = namesIn(groups['names'] ?? '');
    const held = importOf(from).exec(source);
    if (held === null) {
      source = insertImport(source, line, from);
      continue;
    }
    const merged = sortNames([...new Set([...namesIn(held.groups?.['names'] ?? ''), ...names])]);
    source = source.replace(importOf(from), `import { ${merged.join(', ')} } from '${from}';`);
  }
  return source;
}

/**
 * `existing` with `generated`'s permission set appended, or `undefined` when the two cannot be
 * merged: `generated` exports a name `existing` already does (the same set, generated again), or
 * an import is in a shape this does not read. Nothing the author wrote is moved or rewritten
 * except an import line gaining a specifier.
 */
export function appendPolicy(existing: string, generated: string): string | undefined {
  const held = exportedNames(existing);
  const adding = exportedNames(generated);
  if (adding.size === 0 || [...adding].some((name) => held.has(name))) return undefined;
  const lines = generated.split('\n');
  const lastImport = lines.findLastIndex((line) => line.startsWith('import '));
  if (lastImport === -1) return undefined;
  const imports = lines.slice(0, lastImport + 1).filter((line) => line.startsWith('import '));
  if (imports.some((line) => !NAMED_IMPORT.test(line))) return undefined;
  const body = lines
    .slice(lastImport + 1)
    .join('\n')
    .trim();
  return `${foldImports(existing, imports).trimEnd()}\n\n${body}\n`;
}
