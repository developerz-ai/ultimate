#!/usr/bin/env bun
// Enforce, as a build error, that an error factory cannot die formatting its own message. Three
// separate fixes shipped for one cause — `entity`, `flags`, `cli` — because nothing was watching:
// a value typed `unknown` reached a `cause:` or a `fix:` through `JSON.stringify` or a template,
// both of which throw, and the constructor threw INSTEAD of the refusal. Runs on `x verify`'s
// `errors` step through the host-check seam `boundaries` already uses for the tier table.
//
// WHAT IT SEES: a PARAMETER typed `unknown`/`any` that reaches a `cause:`/`fix:` property or a
// `const cause =` in the same top-level declaration, by bare interpolation, `JSON.stringify` or
// `String()`.
//
// WHAT IT CANNOT SEE, and no static scan of this kind can: a value laundered through a local
// helper first (`const message = String(error)` two lines above, then `cause: message` — which is
// what `@ultimat3/ui`'s `ErrorState.tsx` and `@ultimat3/jobs`' `scheduler.ts` do); a value read
// off an object property (`init.given`); a `cause` assembled by a function that returns it; a
// value that is `unknown` by inference rather than by annotation; and a renderer that is on the
// allowlist by NAME but is not actually total. It is a floor, not a proof.
//
//   bun run scripts/error-render.ts [--json]

import { maskLiterals } from '@ultimat3/cli';
import { collectSourceFiles, type SourceFile } from './boundaries';
import { parseScriptArgs } from './lib/args';
import type { Finding } from './lib/log';
import { report } from './lib/log';
import { repoRoot } from './lib/run';

/**
 * How a value that may not be a string reached the text of a refusal. Three named mechanisms,
 * each MEASURED to throw on a value an app controls, and nothing open-ended: an earlier draft also
 * reported "passed through a call I cannot prove is total", which named `@ultimat3/realtime`'s
 * `str(value, 'code')` — a validator — as a defect. A check whose findings have to be argued with
 * is a check an agent learns to skip.
 */
export type UnsafeKind = 'interpolation' | 'stringify' | 'conversion';

export interface UnsafeRender {
  readonly file: string;
  readonly line: number;
  readonly field: 'cause' | 'fix';
  /** The binding declared `unknown` (or `any`) that reaches the text. */
  readonly binding: string;
  readonly kind: UnsafeKind;
}

/**
 * Calls that are total by construction, so a value passing through one is rendered, not thrown on.
 * `renderCauseValue` / `renderFixLiteral` are `@ultimat3/core`'s; the rest are the shipped local
 * copies this list exists to retire — each is the same function under a package-local name, and
 * every one that adopts core's is a name that leaves here. Allowlisted BY NAME, which is the
 * check's weakest joint: a new `renderValue` that is not total would pass unread.
 */
const SAFE_RENDERERS: ReadonlySet<string> = new Set([
  'renderCauseValue',
  'renderFixLiteral',
  'renderValue', // @ultimat3/entity
  'asLiteral', // @ultimat3/entity
  'renderGiven', // @ultimat3/flags
]);

const OPENERS = new Set(['(', '[', '{']);
const CLOSERS = new Set([')', ']', '}']);
const QUOTES = new Set(["'", '"', '`']);

/**
 * Source with comments and every literal's TEXT blanked, but a template's `${…}` expressions left
 * as code — which is neither of the two masks `@ultimat3/cli` ships. `stripComments` would read
 * the word `version` inside `"version"` as the binding of that name; `maskLiterals` blanks the
 * substitutions, which is the only place the defect can hide. So: `maskLiterals` for its
 * regex-vs-division handling, then the substitutions copied back in.
 *
 * The `${` and its `}` stay blank on purpose — a bare `${value}` must read as a value with no call
 * around it, and an unblanked brace would also unbalance the segment depth.
 */
export function maskToCode(source: string): CodeMask {
  const out = maskLiterals(source).split('');
  const substitutions: Range[] = [];
  for (let i = 0; i < source.length; i += 1) {
    if (source[i] !== '`' || out[i] !== '`') continue;
    const close = source.indexOf('`', i + 1);
    const end = close === -1 ? source.length : close;
    for (let j = i + 1; j < end - 1; j += 1) {
      if (source[j] !== '$' || source[j + 1] !== '{') continue;
      let depth = 1;
      let k = j + 2;
      for (; k < end && depth > 0; k += 1) {
        const ch = source[k] as string;
        if (QUOTES.has(ch)) {
          const quote = source.indexOf(ch, k + 1);
          k = quote === -1 ? end : quote;
        } else if (ch === '{') depth += 1;
        else if (ch === '}') depth -= 1;
      }
      for (let copy = j + 2; copy < k - 1; copy += 1) out[copy] = source[copy] as string;
      substitutions.push({ start: j + 2, end: k - 1 });
      j = k - 1;
    }
    i = end;
  }
  return { code: out.join(''), substitutions };
}

/**
 * `cause:` / `fix:` as a property, and `const cause =` as its assignment — the same value under
 * two spellings, and `@ultimat3/core`'s own `toUltimateError` builds it the second way. The
 * lookbehind rejects `e.fix` and `prefix:`.
 */
const FIELD_KEY = /(?<![.\w$])(cause|fix)\s*[:=]\s*/g;

/**
 * `value: unknown`, `given?: unknown`, `raw: any` — counted only INSIDE a parameter list, which is
 * what the enclosing paren depth decides. A field of a type declared in the body is a different
 * thing wearing the same name: `@ultimat3/ai`'s `describeFailure` casts to
 * `{ cause?: unknown }` and then binds `const cause` to a narrowed string, and counting the cast's
 * field reported the string. A parameter is also the only binding an app fills.
 */
const UNKNOWN_BINDING = /([A-Za-z_$][\w$]*)\s*\??\s*:\s*(?:unknown|any)\b/g;

/** Parenthesis depth at every index, so "is this inside a parameter list" is one lookup. */
function parenDepths(code: string): Int32Array {
  const depths = new Int32Array(code.length);
  let depth = 0;
  for (let i = 0; i < code.length; i += 1) {
    if (code[i] === '(') depth += 1;
    depths[i] = depth;
    if (code[i] === ')') depth = Math.max(0, depth - 1);
  }
  return depths;
}

interface Range {
  readonly start: number;
  readonly end: number;
}

export interface CodeMask {
  /** The source with comments and literal text blanked, template substitutions kept. */
  readonly code: string;
  /** Every `${…}` body, so a bare value being converted to text is distinguishable. */
  readonly substitutions: readonly Range[];
}

/**
 * The file split at every top-level `}` and `;`, which is the scope a binding is read in. File-wide
 * would be wrong in the direction that costs an hour: `@ultimat3/query`'s `errors.ts` declares
 * `detail?: unknown` on an interface eight lines BELOW a class whose `detail` is a `string`, and a
 * file-wide set reports that class. Only `}` closes a segment — a `)` at depth 0 ends a parameter
 * list, and cutting there would separate a factory's parameters from the message they build.
 */
export function topLevelSegments(masked: string): readonly Range[] {
  const segments: Range[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < masked.length; i += 1) {
    const ch = masked[i] as string;
    if (OPENERS.has(ch)) depth += 1;
    else if (CLOSERS.has(ch)) {
      depth = Math.max(0, depth - 1);
      if (depth === 0 && ch === '}') {
        segments.push({ start, end: i + 1 });
        start = i + 1;
      }
    } else if (depth === 0 && ch === ';') {
      segments.push({ start, end: i + 1 });
      start = i + 1;
    }
  }
  segments.push({ start, end: masked.length });
  return segments;
}

/** End of the property's value: the next `,` or `;` at the property's own bracket depth. */
function valueEnd(masked: string, from: number): number {
  let depth = 0;
  for (let i = from; i < masked.length; i += 1) {
    const ch = masked[i] as string;
    if (OPENERS.has(ch)) depth += 1;
    else if (CLOSERS.has(ch)) {
      if (depth === 0) return i;
      depth -= 1;
    } else if (depth === 0 && (ch === ',' || ch === ';')) return i;
  }
  return masked.length;
}

/** The callee of the innermost call enclosing `at`, or `undefined` when nothing encloses it. */
function enclosingCallee(span: string, at: number): string | undefined {
  let depth = 0;
  for (let i = at - 1; i >= 0; i -= 1) {
    const ch = span[i] as string;
    if (CLOSERS.has(ch)) depth += 1;
    else if (OPENERS.has(ch)) {
      if (depth > 0) {
        depth -= 1;
        continue;
      }
      if (ch !== '(') return undefined;
      let end = i;
      while (end > 0 && /\s/.test(span[end - 1] as string)) end -= 1;
      let begin = end;
      while (begin > 0 && /[\w$.]/.test(span[begin - 1] as string)) begin -= 1;
      return begin === end ? undefined : span.slice(begin, end);
    }
  }
  return undefined;
}

const lineOf = (text: string, index: number): number => {
  let line = 1;
  for (let i = 0; i < index; i += 1) if (text[i] === '\n') line += 1;
  return line;
};

/** The two calls that render a value and can throw doing it. Anything else is not this check's. */
const CONVERTERS: Readonly<Record<string, UnsafeKind>> = {
  'JSON.stringify': 'stringify',
  String: 'conversion',
};

/**
 * The binding ITSELF, not a property of it. `${error.message}` and `cause: error.cause` are reads
 * of a field TypeScript already typed `string` — flagging them would report every narrowed
 * `unknown` in the framework and teach an agent to ignore the check. What is left is the value
 * whole, which is the only thing whose rendering can throw.
 */
const isBareValue = (code: string, at: number, length: number): boolean => {
  let before = at - 1;
  while (before >= 0 && /\s/.test(code[before] as string)) before -= 1;
  let after = at + length;
  while (after < code.length && /\s/.test(code[after] as string)) after += 1;
  return code[before] !== '.' && !['.', '[', '('].includes(code[after] as string);
};

/**
 * Which mechanism, if any, is turning this occurrence into text. A bare value inside a `${…}` is
 * interpolated; a bare value handed to `JSON.stringify` or `String` is converted. A bare value
 * anywhere else in the expression — `error instanceof Error ? … : …`, a `typeof` test, an argument
 * to a validator — is not being rendered at all, and reporting it would be reporting narrowing.
 */
function mechanismAt(
  text: string,
  at: number,
  length: number,
  interpolated: boolean,
): UnsafeKind | undefined {
  if (!isBareValue(text, at, length)) return undefined;
  const callee = enclosingCallee(text, at);
  if (callee === undefined) return interpolated ? 'interpolation' : undefined;
  if (SAFE_RENDERERS.has(callee)) return undefined;
  return CONVERTERS[callee];
}

/** Every way an `unknown` binding reaches one `cause:` / `fix:` value, read over the code mask. */
function unsafeUses(
  mask: CodeMask,
  span: Range,
  field: 'cause' | 'fix',
  bindings: ReadonlySet<string>,
  file: string,
): readonly UnsafeRender[] {
  const text = mask.code.slice(span.start, span.end);
  const found: UnsafeRender[] = [];
  for (const binding of bindings) {
    for (const match of text.matchAll(new RegExp(`(?<![\\w$])${binding}(?![\\w$])`, 'g'))) {
      const at = span.start + match.index;
      // Interpolated means the substitution IS the value — `${value}`. A value that merely appears
      // in one is usually being tested: `${cause instanceof Error ? cause.message : …}` renders
      // the branches, never the operand, and `@ultimat3/http` was reported for exactly that.
      const interpolated = mask.substitutions.some(
        (one) =>
          at >= one.start && at < one.end && mask.code.slice(one.start, one.end).trim() === binding,
      );
      const kind = mechanismAt(text, match.index, binding.length, interpolated);
      if (kind === undefined) continue;
      found.push({ file, line: lineOf(mask.code, at), field, binding, kind });
    }
  }
  return found;
}

const isTest = (path: string): boolean => /\.(?:test|spec|d)\.tsx?$/.test(path);

/** Every unsafe render in one file, in source order. */
export function checkFile(file: SourceFile): readonly UnsafeRender[] {
  if (isTest(file.path)) return [];
  const mask = maskToCode(file.source);
  const segments = topLevelSegments(mask.code);
  const depths = parenDepths(mask.code);
  const bindings = segments.map(
    (segment) =>
      new Set(
        [...mask.code.slice(segment.start, segment.end).matchAll(UNKNOWN_BINDING)]
          .filter((match) => (depths[segment.start + match.index] ?? 0) > 0)
          .map((match) => match[1] as string),
      ),
  );
  const found: UnsafeRender[] = [];
  for (const key of mask.code.matchAll(FIELD_KEY)) {
    const index = segments.findIndex((segment) => key.index < segment.end);
    const names = bindings[index];
    if (names === undefined || names.size === 0) continue;
    const start = key.index + key[0].length;
    found.push(
      ...unsafeUses(
        mask,
        { start, end: valueEnd(mask.code, start) },
        key[1] as 'cause' | 'fix',
        names,
        file.path,
      ),
    );
  }
  return found;
}

export const checkErrorRendering = (files: readonly SourceFile[]): readonly UnsafeRender[] =>
  files.flatMap((file) => checkFile(file));

const CAUSE: Readonly<Record<UnsafeKind, string>> = {
  interpolation:
    'interpolated into a template — a symbol throws there, and so does a hostile toString',
  stringify: 'passed to JSON.stringify — it throws on a bigint and on a cycle, and RUNS any toJSON',
  conversion: "passed to String() — it runs the value's own toString, which an app can make throw",
};

export function unsafeRenderFindingFor(unsafe: UnsafeRender): Finding {
  const render = unsafe.field === 'cause' ? 'renderCauseValue' : 'renderFixLiteral';
  return {
    code: 'X_ERROR_RENDER_UNSAFE',
    cause: `${unsafe.file}:${unsafe.line} builds its ${unsafe.field}: from "${unsafe.binding}", typed unknown, ${CAUSE[unsafe.kind]} — the constructor would throw instead of the error`,
    fix: `wrap it: ${render}(${unsafe.binding}${unsafe.field === 'fix' ? ", '<placeholder>'" : ''}) from @ultimat3/core, at ${unsafe.file}:${unsafe.line}`,
    at: `${unsafe.file}:${unsafe.line}`,
  };
}

/** What this repo contributes to `x verify`'s `errors` step. */
export const errorRendering = async (root: string): Promise<readonly Finding[]> =>
  checkErrorRendering(await collectSourceFiles(root)).map(unsafeRenderFindingFor);

if (import.meta.main) {
  const args = parseScriptArgs(Bun.argv.slice(2));
  const files = await collectSourceFiles(repoRoot());
  const findings = checkErrorRendering(files).map(unsafeRenderFindingFor);
  report(
    {
      ok: findings.length === 0,
      script: 'error-render',
      summary:
        findings.length === 0
          ? `${files.length} files, every cause: and fix: renders safely`
          : `${findings.length} unsafe render(s) in ${files.length} files`,
      findings,
    },
    args.json,
  );
}
