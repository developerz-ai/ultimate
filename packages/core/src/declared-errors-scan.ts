// Single responsibility: the static half of `errors:` — the codes a handler's FIRST HOP names in
// its own source, as `X_…` literals and as `new <Class>` of a `defineError` class. Test-time only:
// it reads `Function.prototype.toString()` and the file a class was declared in, which an
// unminified server build keeps and nothing in production asks for.

import { definedErrorSites } from './define-error';

const CODE_LITERAL = /["'`](X(?:_[A-Z0-9]+)+)["'`]/g;
// Bun prints `new PostNotFound` with no parentheses when the call passes nothing, and keeps a
// namespace import's `E.PostNotFound`: the last segment is the binding a declaration exported.
const CONSTRUCTION = /\bnew\s+(?:[A-Za-z_$][\w$]*\.)*([A-Za-z_$][\w$]*)/g;

/**
 * Every code `source` names, sorted: its literals, and each `new <Class>` whose name is a key of
 * `classCodes`. First hop only — a helper the handler calls is its own source, reached by the
 * dynamic half when a test runs the path.
 */
export function scanHandlerSource(
  source: string,
  classCodes: ReadonlyMap<string, string>,
): readonly string[] {
  const codes = new Set<string>();
  for (const match of source.matchAll(CODE_LITERAL)) codes.add(match[1] as string);
  for (const match of source.matchAll(CONSTRUCTION)) {
    const code = classCodes.get(match[1] as string);
    if (code !== undefined) codes.add(code);
  }
  return [...codes].sort();
}

/** `file:line` out of one stack frame — `at /a/b.ts:8:29` or `at fn (file:///a/b.ts:8:29)`. */
export function frameSite(frame: string): { readonly file: string; readonly line: number } | null {
  const match = /(?:\(|at\s+)(?:file:\/\/)?([^()\s][^()]*?):(\d+):\d+\)?\s*$/.exec(frame.trim());
  if (match === null) return null;
  return { file: match[1] as string, line: Number(match[2]) };
}

const BINDING = /([A-Za-z_$][\w$]*)\s*(?::[^=]*)?=\s*defineError\b/;

/**
 * The name `defineError`'s result was bound to, read off the declaring line (or the one above it,
 * for `const X =` broken before the call). `null` for an inline or re-bound class: the dynamic
 * half still judges its throw.
 */
export function bindingAt(text: string, line: number): string | null {
  const lines = text.split('\n');
  const declaring = lines[line - 1] ?? '';
  const found = BINDING.exec(declaring) ?? BINDING.exec(`${lines[line - 2] ?? ''} ${declaring}`);
  return found === null ? null : (found[1] as string);
}

/** Reads a declaring file. Injected so a test answers without a disk; `Bun.file` otherwise. */
export type SourceReader = (file: string) => Promise<string>;

const readWithBun: SourceReader = (file) => Bun.file(file).text();

/**
 * Binding name → code, for every `defineError` class whose declaring line can still be read. A
 * file that cannot be read contributes nothing: the scan is a first hop, never the verdict.
 */
export async function definedErrorClassCodes(
  read: SourceReader = readWithBun,
): Promise<ReadonlyMap<string, string>> {
  const byName = new Map<string, string>();
  const texts = new Map<string, Promise<string | null>>();
  for (const [code, frame] of definedErrorSites()) {
    const site = frameSite(frame);
    if (site === null) continue;
    let text = texts.get(site.file);
    if (text === undefined) {
      text = read(site.file).catch(() => null);
      texts.set(site.file, text);
    }
    const source = await text;
    const name = source === null ? null : bindingAt(source, site.line);
    if (name !== null) byName.set(name, code);
  }
  return byName;
}
