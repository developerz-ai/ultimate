// What a package's `src/index.ts` exports, and whether a name carried a `@deprecated` JSDoc — the
// two facts `scripts/deprecation-window.ts` compares across a release tag. Pure text reads: the
// barrels here are explicit named re-exports (no `export *`), which is what makes this decidable.

export interface ExportedName {
  /** The name a consumer imports. */
  readonly name: string;
  /** The name in the module it comes from — differs from `name` under `a as b`. */
  readonly local: string;
  /** The module specifier of a re-export, `./x`; absent for a declaration in the barrel itself. */
  readonly from?: string;
}

const IDENT = '[A-Za-z_$][\\w$]*';
const DECLARATION = `(?:declare\\s+)?(?:async\\s+)?(?:abstract\\s+)?(?:const|let|var|function\\*?|class|interface|type|enum|namespace)\\s+`;

const withoutComments = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:'"`])\/\/[^\n]*/g, '$1');

/** Every name the module exports, in source order. */
export function exportedNames(source: string): readonly ExportedName[] {
  const code = withoutComments(source);
  const names: ExportedName[] = [];
  const lists = /export\s+(?:type\s+)?\{([^}]*)\}(?:\s*from\s*['"]([^'"]+)['"])?/g;
  for (const match of code.matchAll(lists)) {
    const from = match[2];
    for (const raw of (match[1] ?? '').split(',')) {
      const spec = raw.trim().replace(/^type\s+/, '');
      if (spec === '') continue;
      const [local = spec, name = local] = spec.split(/\s+as\s+/).map((part) => part.trim());
      names.push({ name, local, ...(from === undefined ? {} : { from }) });
    }
  }
  for (const match of code.matchAll(new RegExp(`export\\s+${DECLARATION}(${IDENT})`, 'g'))) {
    const name = match[1] ?? '';
    names.push({ name, local: name });
  }
  for (const match of code.matchAll(
    new RegExp(`export\\s+\\*\\s+as\\s+(${IDENT})\\s+from\\s*['"]([^'"]+)['"]`, 'g'),
  )) {
    const name = match[1] ?? '';
    names.push({ name, local: name, from: match[2] ?? '' });
  }
  return names;
}

const escapeName = (name: string): string => name.replace(/\$/g, '\\$');

/**
 * Whether a `/** … @deprecated … *\/` block sits directly on `name` in `source`: on its
 * declaration, on its specifier inside an export list, or on the whole export statement naming it.
 */
export function deprecatedIn(source: string, name: string): boolean {
  const id = escapeName(name);
  const attached = [
    new RegExp(`^\\s*(?:type\\s+)?${id}\\b`),
    new RegExp(`^\\s*(?:export\\s+)?${DECLARATION}${id}\\b`),
    new RegExp(`^\\s*export\\s+(?:type\\s+)?\\{[^}]*\\b${id}\\b[^}]*\\}`),
  ];
  for (const block of source.matchAll(/\/\*\*[\s\S]*?\*\//g)) {
    if (!block[0].includes('@deprecated')) continue;
    const after = source.slice((block.index ?? 0) + block[0].length);
    if (attached.some((pattern) => pattern.test(after))) return true;
  }
  return false;
}

/** The files a relative specifier can name, from the directory of the barrel that imports it. */
export function moduleCandidates(dir: string, from: string): readonly string[] {
  if (!from.startsWith('.')) return [];
  const parts = `${dir}/${from}`.split('/');
  const out: string[] = [];
  for (const part of parts) {
    if (part === '.' || part === '') continue;
    if (part === '..') out.pop();
    else out.push(part);
  }
  const base = out.join('/').replace(/\.js$/, '');
  if (/\.tsx?$/.test(base)) return [base];
  return [`${base}.ts`, `${base}.tsx`, `${base}/index.ts`];
}
