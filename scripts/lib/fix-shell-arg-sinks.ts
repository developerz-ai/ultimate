// Where a `fix` VALUE is, for `scripts/fix-shell-arg.ts`: a `fix:` key, a `const fix =`, and the
// argument of any factory declaring a parameter named `fix` — plus which `const`s already hold a
// screened value. Reads MASKED code (literal text blanked, `${…}` bodies kept); `valueEnd` is
// injected because it lives in `scripts/error-render.ts`, which imports the rule that imports this.

import { isShellScreened } from './fix-shell-arg-scan';

/** Where a value starting at `from` ends in masked code — `scripts/error-render.ts`'s `valueEnd`. */
export type ValueEnd = (masked: string, from: number) => number;

/** `fix:` as a property and `const fix =` as its assignment. The lookbehind rejects `e.fix`. */
const FIX_KEY = /(?<![.\w$])fix\s*[:=]\s*/g;

/** Factory name → the argument positions that are a `fix`. Built by `fixParamsOf`, over a corpus. */
export type FixParams = ReadonlyMap<string, ReadonlySet<number>>;

export const NO_PARAMS: FixParams = new Map();

/** `function name(` and `const name = (` / `= async (` — where a factory's parameter list opens. */
const DECLARATION =
  /(\bexport\s+)?(?:\bfunction\s+([A-Za-z_$][\w$]*)\s*\(|\b(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\()/g;

/** A parameter's own name, past a modifier or `...`; its type and default are not the question. */
const PARAM_NAME =
  /^\s*(?:(?:public|private|protected|readonly|override)\s+)*(?:\.\.\.)?([A-Za-z_$][\w$]*)/;

/** `class Name … {` — a constructor taking a positional `fix` makes `new Name(…)` a sink. */
const CLASS = /(\bexport\s+)?\bclass\s+([A-Za-z_$][\w$]*)[^{]*\{/g;

/** `constructor(` — only counted at the class body's own depth, never inside a method. */
const CONSTRUCTOR = /\bconstructor\s*\(/g;

/** `const name =` — a binding whose value may be a screening call. */
const CONST_BINDING = /\bconst\s+([A-Za-z_$][\w$]*)\s*=\s*/g;

export type Span = readonly [start: number, end: number];

/** The arguments between the `(` at `open` and its match, each as a span of the masked code. */
function argSpans(valueEnd: ValueEnd, code: string, open: number): readonly Span[] {
  const spans: Span[] = [];
  let from = open + 1;
  for (;;) {
    const end = valueEnd(code, from);
    spans.push([from, end]);
    if (code[end] !== ',') return spans;
    from = end + 1;
  }
}

interface Declaration {
  readonly name: string;
  readonly exported: boolean;
  /** The positions of its parameters named `fix` — empty for a function that takes none. */
  readonly fixAt: readonly number[];
}

/** The positions of the parameters named `fix` in the list whose `(` sits at `open`. */
const fixPositions = (valueEnd: ValueEnd, code: string, open: number): readonly number[] =>
  argSpans(valueEnd, code, open).flatMap(([start, end], index) =>
    PARAM_NAME.exec(code.slice(start, end))?.[1] === 'fix' ? [index] : [],
  );

/** The `}` matching the `{` at `open` in masked code, or the end when it is never closed. */
function braceClose(code: string, open: number): number {
  let depth = 0;
  for (let i = open; i < code.length; i += 1) {
    if (code[i] === '{') depth += 1;
    else if (code[i] === '}') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return code.length;
}

/** How many `{` are open at `at` in masked code. */
const depthAt = (code: string, at: number): number => {
  let depth = 0;
  for (let i = 0; i < at; i += 1) {
    if (code[i] === '{') depth += 1;
    else if (code[i] === '}') depth -= 1;
  }
  return depth;
};

/** Every class whose own constructor names a `fix` parameter, as a declaration of the class. */
function classesOf(valueEnd: ValueEnd, code: string): readonly Declaration[] {
  return [...code.matchAll(CLASS)].map((match) => {
    const open = match.index + match[0].length - 1;
    const body = code.slice(open, braceClose(code, open) + 1);
    let fixAt: readonly number[] = [];
    for (const ctor of body.matchAll(CONSTRUCTOR)) {
      // Depth 1 is the class body itself; a `constructor(` deeper is some nested class's.
      if (depthAt(body, ctor.index) !== 1) continue;
      fixAt = fixPositions(valueEnd, code, open + ctor.index + ctor[0].length - 1);
      break;
    }
    return { name: match[2] as string, exported: match[1] !== undefined, fixAt };
  });
}

/** Every function and class declared in `code`, with where its `fix` parameters sit. */
function declarationsOf(valueEnd: ValueEnd, code: string): readonly Declaration[] {
  const functions = [...code.matchAll(DECLARATION)].map((match) => ({
    name: (match[2] ?? match[3]) as string,
    exported: match[1] !== undefined,
    fixAt: fixPositions(valueEnd, code, match.index + match[0].length - 1),
  }));
  return [...functions, ...classesOf(valueEnd, code)];
}

const addSinks = (into: Map<string, Set<number>>, one: Declaration): void => {
  if (one.fixAt.length === 0) return;
  const at = into.get(one.name) ?? new Set<number>();
  for (const index of one.fixAt) at.add(index);
  into.set(one.name, at);
};

/**
 * The first pass: every EXPORTED factory, in every file, that declares a parameter named `fix`. A
 * name, not a type — `fix: string` is how every error factory in this tree spells it, and a sink
 * that names it otherwise is the gap the header states. Exported only, because a module-private
 * helper is reachable from its own file alone, and two private `finding()`s with the fix in
 * different places (`cmd-doctor.ts`, `doctor-offline.ts`) must not read each other's argument.
 */
export function fixParamsOf(valueEnd: ValueEnd, masked: readonly string[]): FixParams {
  const params = new Map<string, Set<number>>();
  for (const code of masked) {
    for (const one of declarationsOf(valueEnd, code)) {
      if (one.exported) addSinks(params, one);
    }
  }
  return params;
}

/** The sinks one file sees: its own declarations, which shadow any same-named export elsewhere. */
function sinksFor(valueEnd: ValueEnd, code: string, global: FixParams): FixParams {
  const local = declarationsOf(valueEnd, code);
  const declared = new Set(local.map((one) => one.name));
  const sinks = new Map<string, Set<number>>();
  for (const [name, at] of global) if (!declared.has(name)) sinks.set(name, new Set(at));
  for (const one of local) addSinks(sinks, one);
  return sinks;
}

const escapeName = (name: string): string => name.replace(/\$/g, '\\$');

/**
 * Every span of `code` that is a fix value: a `fix:` key's value, or the `fix` argument of a sink —
 * an export from anywhere in `global`, shadowed by this file's own declarations.
 */
export function fixSpans(valueEnd: ValueEnd, code: string, global: FixParams): readonly Span[] {
  const params = sinksFor(valueEnd, code, global);
  const spans: Span[] = [];
  for (const key of code.matchAll(FIX_KEY)) {
    const start = key.index + key[0].length;
    spans.push([start, valueEnd(code, start)]);
  }
  if (params.size === 0) return spans;
  const names = [...params.keys()].map(escapeName).join('|');
  const call = new RegExp(`(?<![\\w$.]|function\\s+)(${names})\\s*\\(`, 'g');
  for (const match of code.matchAll(call)) {
    const args = argSpans(valueEnd, code, match.index + match[0].length - 1);
    for (const index of params.get(match[1] as string) ?? []) {
      const span = args[index];
      if (span !== undefined) spans.push(span);
    }
  }
  return spans;
}

/** Whether a `const` of this name, bound to a shell screen, is in scope at this offset. */
export type ScreenedConsts = (name: string, at: number) => boolean;

/** The `{` of the innermost block open at `at`, or -1 at module level. */
function enclosingOpen(code: string, at: number): number {
  let depth = 0;
  for (let i = at - 1; i >= 0; i -= 1) {
    if (code[i] === '}') depth += 1;
    else if (code[i] === '{') {
      if (depth === 0) return i;
      depth -= 1;
    }
  }
  return -1;
}

/**
 * Names bound by `const name = renderFixShellArg(…)` — one shell word wherever spliced, but only
 * inside the block that binds them, from the binding on. Per-file trust let a screened `uri` in
 * one function vouch for a raw `uri` in the next (security audit of plan 101 sweep 1c, L2).
 */
export function screenedConsts(valueEnd: ValueEnd, code: string): ScreenedConsts {
  const scopes: { readonly name: string; readonly from: number; readonly to: number }[] = [];
  for (const match of code.matchAll(CONST_BINDING)) {
    const start = match.index + match[0].length;
    if (!isShellScreened(code.slice(start, valueEnd(code, start)))) continue;
    const open = enclosingOpen(code, match.index);
    const to = open === -1 ? code.length : braceClose(code, open);
    scopes.push({ name: match[1] as string, from: start, to });
  }
  return (name, at) => scopes.some((one) => one.name === name && at >= one.from && at <= one.to);
}
