// What a package DECLARES at the top level of its source — as opposed to what it re-exports — read
// for `scripts/factory-names.ts`: which names are its own bindings, which are classes, what each
// class implements and what each function says it returns. A reading, not a type check.
//
// WHY A READING. `Bun.Transpiler#scan` names a module's exports and nothing about them, and the
// TypeScript checker would link every package to answer two questions. Biome formats every source
// file, so a top-level declaration starts in column 0 and an indented one is a local: the column is
// the scope. What this cannot see — a return type the checker infers, a class built by a function —
// it reports as absent, never guessed.

// why: Bun exposes no path-join primitive; Bun.file takes one already joined.
import { join } from 'node:path';

export interface Declaration {
  readonly kind: 'class' | 'value';
  /** A class's `implements` list, by name, generics dropped. Empty for a value. */
  readonly implements: readonly string[];
  /** A function's declared return type's leading name, a `Promise<…>` unwrapped. */
  readonly returns?: string;
}

const TOP_LEVEL =
  /^(?:export\s+)?(?:declare\s+)?(?:async\s+)?(?:abstract\s+)?(class|function\*?|const|let|var|enum)\s+([A-Za-z_$][\w$]*)/gm;

/** The index just past the bracket that closes the one at `from`, or -1 when it never closes. */
function skipBalanced(text: string, from: number): number {
  const open = text[from];
  const close = open === '(' ? ')' : open === '<' ? '>' : open === '{' ? '}' : undefined;
  if (close === undefined) return -1;
  let depth = 0;
  for (let at = from; at < text.length; at += 1) {
    const char = text[at];
    // `=>` inside a parameter default is an arrow, never a closing `>`.
    if (char === '>' && text[at - 1] === '=') continue;
    if (char === open) depth += 1;
    else if (char === close) {
      depth -= 1;
      if (depth === 0) return at + 1;
    }
  }
  return -1;
}

const skipSpace = (text: string, at: number): number => {
  let next = at;
  while (next < text.length && /\s/.test(text[next] ?? '')) next += 1;
  return next;
};

/** `(…): Type` at `at` (after a name or an `=`) → `Type`'s leading name, `Promise<…>` unwrapped. */
function returnTypeAt(text: string, from: number): string | undefined {
  let at = skipSpace(text, from);
  if (text.startsWith('async', at)) at = skipSpace(text, at + 'async'.length);
  if (text[at] === '<') at = skipSpace(text, skipBalanced(text, at));
  if (text[at] !== '(') return undefined;
  const closed = skipBalanced(text, at);
  if (closed === -1) return undefined;
  const rest = text.slice(closed);
  const annotated = /^\s*:\s*(?:Promise\s*<\s*)?([A-Z][\w$]*)/.exec(rest);
  return annotated?.[1];
}

/** `class X<…> extends Y<…> implements A<…>, B {` → `['A', 'B']`. */
function implementsAt(text: string, from: number): readonly string[] {
  let at = skipSpace(text, from);
  if (text[at] === '<') at = skipBalanced(text, at);
  const body = text.indexOf('{', at);
  if (at === -1 || body === -1) return [];
  const head = text.slice(at, body);
  const clause = /\bimplements\s+([\s\S]+)$/.exec(head)?.[1];
  if (clause === undefined) return [];
  return [...clause.replace(/<[^<>]*>/g, '').matchAll(/[A-Za-z_$][\w$.]*/g)].map((m) => m[0]);
}

/** Every top-level declaration in one module's text, by name. */
export function declarationsIn(text: string): ReadonlyMap<string, Declaration> {
  const found = new Map<string, Declaration>();
  for (const match of text.matchAll(TOP_LEVEL)) {
    const keyword = match[1] ?? '';
    const name = match[2] ?? '';
    const after = (match.index ?? 0) + match[0].length;
    if (keyword === 'class') {
      found.set(name, { kind: 'class', implements: implementsAt(text, after) });
      continue;
    }
    if (found.get(name)?.kind === 'class') continue;
    const returns = keyword.startsWith('function')
      ? returnTypeAt(text, after)
      : /^\s*=/.test(text.slice(after))
        ? returnTypeAt(text, text.indexOf('=', after) + 1)
        : undefined;
    // An overload's first signature names the type; a later bare body must not erase it.
    const earlier = found.get(name)?.returns;
    const kept = returns ?? earlier;
    found.set(name, {
      kind: 'value',
      implements: [],
      ...(kept === undefined ? {} : { returns: kept }),
    });
  }
  return found;
}

const isSource = (path: string): boolean =>
  /\.tsx?$/.test(path) && !/\.(?:test|d)\.tsx?$/.test(path);

/** Every top-level declaration under `<dir>/src`, test files excluded: the package's own bindings. */
export async function readDeclarations(
  root: string,
  dir: string,
): Promise<ReadonlyMap<string, Declaration>> {
  const found = new Map<string, Declaration>();
  const files = [...new Bun.Glob('src/**/*.{ts,tsx}').scanSync({ cwd: join(root, dir) })].sort();
  for (const file of files.filter(isSource)) {
    const text = await Bun.file(join(root, dir, file)).text();
    for (const [name, declaration] of declarationsIn(text)) {
      // A class anywhere in the package wins: two modules may each hold a local of one name.
      if (found.get(name)?.kind !== 'class') found.set(name, declaration);
    }
  }
  return found;
}
