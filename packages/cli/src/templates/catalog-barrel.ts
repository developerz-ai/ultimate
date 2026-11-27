// The module a split locale's directory holds beside its namespace files: each file imported and
// set at the key path its name stands for, so `packages/i18n/src/index.ts` imports one locale as
// one object and `typeof` it is still the typed key space. Derived from the file list alone, so
// every writer re-derives it and none can drift from another.

import { catalogFilePrefix } from '@ultimat3/i18n';
import { pascal } from './naming';

/** The export every barrel declares — `import { catalog as en } from '../catalogs/en'`. */
export const BARREL_EXPORT = 'catalog';

interface Node {
  binding?: string;
  readonly children: Map<string, Node>;
}

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;

/** `'my-ns'` where a segment is not an identifier; bare where it is, as Biome formats it. */
const property = (segment: string): string => (IDENTIFIER.test(segment) ? segment : `'${segment}'`);

/**
 * One binding per file, `ns` + its prefix in PascalCase: `site/home.json` → `nsSiteHome`. The
 * prefix keeps every binding clear of a reserved word (`default.json`, `new.json`) and of a leading
 * digit (`404.json`); a second file reshaped to the same name takes a counter.
 */
function bindingsOf(prefixes: readonly string[]): ReadonlyMap<string, string> {
  const taken = new Set<string>();
  const bindings = new Map<string, string>();
  for (const prefix of prefixes) {
    const base = `ns${pascal(prefix.replaceAll('.', '-'))}`;
    let binding = base;
    for (let n = 2; taken.has(binding); n += 1) binding = `${base}${n}`;
    taken.add(binding);
    bindings.set(prefix, binding);
  }
  return bindings;
}

/** A node as an expression: a file alone is its binding; children make an expanded object. */
function render(node: Node, indent: string): string {
  if (node.children.size === 0) return node.binding ?? '{}';
  const inner = `${indent}  `;
  const lines = node.binding === undefined ? [] : [`${inner}...${node.binding},`];
  for (const [segment, child] of node.children) {
    lines.push(`${inner}${property(segment)}: ${render(child, inner)},`);
  }
  return `{\n${lines.join('\n')}\n${indent}}`;
}

/**
 * The barrel for a locale directory holding `files` (names relative to it: `billing.json`,
 * `site/home.json`). Imports in file-name order — Biome's import sort is told to leave them, as
 * it puts `site/home.json` before `site.json` by a rule no writer here restates — and every object
 * expanded one entry per line: the shape Biome's formatter keeps, and the one `x merge-driver`
 * merges when two branches each add a namespace.
 */
export function catalogBarrel(files: readonly string[]): string {
  const names = [...new Set(files)].sort();
  const prefixes = names.map(catalogFilePrefix);
  const bindings = bindingsOf(prefixes);
  const root: Node = { children: new Map() };
  for (const prefix of [...prefixes].sort()) {
    let node = root;
    for (const segment of prefix.split('.')) {
      const child = node.children.get(segment) ?? { children: new Map() };
      node.children.set(segment, child);
      node = child;
    }
    const binding = bindings.get(prefix);
    if (binding !== undefined) node.binding = binding;
  }
  const imports = names.map((name, index) => {
    const prefix = prefixes[index] ?? '';
    return `import ${bindings.get(prefix) ?? ''} from './${name}';`;
  });
  const block = imports.length === 0 ? '' : `${imports.join('\n')}\n\n`;
  return `// Generated from the namespace files beside it — never hand-edited: \`bunx x i18n split\` and
// every x i18n command re-derive it. Each file sits at the key path its name stands for.
// biome-ignore-all assist/source/organizeImports: in file-name order, the order every writer derives

${block}export const ${BARREL_EXPORT} = ${render(root, '')};
`;
}
