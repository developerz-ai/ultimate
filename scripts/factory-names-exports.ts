// What one entry module EXPORTS, read for `scripts/factory-names.ts` beyond what
// `Bun.Transpiler#scan` names: every TYPE export, the LOCAL binding behind an `export { a as b }`,
// and every `export * from`, which names nothing a reader can check. Biome formats every entry, so
// an export clause is `export { … }` or a column-0 `export <keyword> <Name>`. A reading, not a parse.

export interface ExportedName {
  /** The name an app imports. */
  readonly name: string;
  /** The binding it names in its own module: `a` for `export { a as b }`, else `name`. */
  readonly local: string;
  readonly type: boolean;
  /** The specifier of `export { … } from '<from>'`; absent for a binding this module holds. */
  readonly from?: string;
}

export interface ModuleExports {
  readonly names: readonly ExportedName[];
  /** `export * from '<from>'` — the names it adds are another module's, unread here. */
  readonly stars: readonly string[];
  /** `import { a as b } from '<from>'`: a local binding that is another module's, by local name. */
  readonly imported: ReadonlyMap<string, string>;
}

/** Comments out, strings kept: a `//` inside a quoted specifier is not a comment. */
export function stripComments(text: string): string {
  return text.replace(
    /'(?:\\.|[^'\\\n])*'|"(?:\\.|[^"\\\n])*"|\/\/[^\n]*|\/\*[\s\S]*?\*\//g,
    (m) => (m.startsWith('/') ? ' ' : m),
  );
}

const CLAUSE = /\bexport\s+(type\s+)?\{([^}]*)\}(?:\s*from\s*['"]([^'"]+)['"])?/g;
const STAR = /\bexport\s+\*\s*(as\s+[A-Za-z_$][\w$]*\s*)?from\s*['"]([^'"]+)['"]/g;
const IMPORT = /\bimport\s+(?:type\s+)?\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/g;
const DECLARED =
  /^export\s+(?:declare\s+)?(?:async\s+)?(?:abstract\s+)?(const\s+enum|interface|type|class|function\*?|const|let|var|enum|namespace)\s+([A-Za-z_$][\w$]*)/gm;

const TYPE_KEYWORDS = new Set(['interface', 'type']);

/** `type a as b` → `{ local: 'a', name: 'b', type: true }`; `, ` padding and a trailing comma drop. */
function specifiers(list: string, allType: boolean): readonly Omit<ExportedName, 'from'>[] {
  return list
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part !== '')
    .map((part) => {
      const typed = /^type\s+/.test(part);
      const [local = '', name = local] = part.replace(/^type\s+/, '').split(/\s+as\s+/);
      return { name: name.trim(), local: local.trim(), type: allType || typed };
    });
}

export function exportsIn(text: string): ModuleExports {
  const code = stripComments(text);
  const names: ExportedName[] = [];
  for (const match of code.matchAll(CLAUSE)) {
    const from = match[3];
    for (const one of specifiers(match[2] ?? '', match[1] !== undefined)) {
      names.push(from === undefined ? one : { ...one, from });
    }
  }
  for (const match of code.matchAll(DECLARED)) {
    const name = match[2] ?? '';
    names.push({ name, local: name, type: TYPE_KEYWORDS.has(match[1] ?? '') });
  }
  const stars: string[] = [];
  for (const match of code.matchAll(STAR)) {
    // `export * as ns from` names `ns`, a value Bun's scan already lists: only a bare star is blind.
    if (match[1] === undefined) stars.push(match[2] ?? '');
  }
  const imported = new Map<string, string>();
  for (const match of code.matchAll(IMPORT)) {
    for (const one of specifiers(match[1] ?? '', false)) imported.set(one.name, match[2] ?? '');
  }
  return { names, stars, imported };
}

/** `'./x'` is this package's module; `'@ultimat3/core'` is another package's binding. */
export const isRelative = (specifier: string): boolean => specifier.startsWith('.');

/**
 * The name the PACKAGE declares behind an export, or undefined when the binding is another
 * package's: `export { a as b } from './x'` → `a`; `export { t } from '@ultimat3/schema'` → none;
 * `export { c }` of a binding imported from another package → none.
 */
export function ownLocal(
  one: ExportedName,
  imported: ReadonlyMap<string, string>,
): string | undefined {
  if (one.from !== undefined) return isRelative(one.from) ? one.local : undefined;
  const source = imported.get(one.local);
  return source === undefined || isRelative(source) ? one.local : undefined;
}
