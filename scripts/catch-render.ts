#!/usr/bin/env bun

// Enforce, as a ratchet, that a CAUGHT value does not reach a `cause:` / `fix:` / `detail:` through
// `instanceof`, `String()`, `JSON.stringify()` or a bare `${…}`.
//
// WHY A SECOND RULE. `scripts/error-render.ts` reads a PARAMETER annotated `unknown`. Every
// `catch (error) { … cause: error instanceof Error ? error.message : String(error) }` site is a
// catch BINDING — annotated by nobody — so that check cannot see one, and it was measured green
// before and immediately after a seven-site fix in `@ultimat3/ai` and `@ultimat3/mail`. Fifteen
// more were then found across `cache`, `auth`, `ai` and `mail` by reading, none by a gate.
//
// WHY IT IS A DEFECT, in the framework's own words: `@ultimat3/core`'s `isThrownError` exists
// because "a `Proxy`'s `getPrototypeOf` trap runs during `instanceof`, and the one place this
// question is asked is a `catch` block that has nothing left to answer with if it does". `String()`
// runs a hostile `toString`; `${…}` throws outright on a Symbol, where `String(sym)` does NOT —
// `String(Symbol('x'))` is `"Symbol(x)"`, and this comment claimed otherwise until 2026-08-26.
// `JSON.stringify` throws on a bigint
// and on a cycle. Each turns a coded refusal into an uncoded crash, in the exact place the process
// has no second chance. `renderThrowable(value)` is the total form and is one import.
//
// WHAT IT NOW SEES, `As of 2026-08-23`: `trace:` — `@ultimat3/admin`'s `AdminDecision` field, which
// `packages/admin/src/action-gate.ts:186` rendered a caught value into while this rule reported
// nothing, because the destination list was three names long and its own name promised more. And
// ONE cross-file hop: a caught value rendered into a field that the SAME package's `src/errors.ts`
// interpolates into a refusal. `packages/cli/src/island-bundle.ts:94` put `String(error)` into a
// `string`-typed `logs`, and `packages/cli/src/errors.ts:307` interpolated `${input.logs}` into a
// `cause:` — legal at both ends, lethal end to end, and invisible to `error-render.ts` because
// `logs` is annotated `string` and to this rule because `logs` was not a destination.
//
// WHAT IT STILL CANNOT SEE: a caught value handed to a helper that renders it in a THIRD file, a
// field laundered by a package other than the one holding the catch, a `.message` read on its own
// (a getter can throw too), and a rethrow whose renderer is the constructor's. A floor, like the
// check beside it.
//
// ZERO-PINNED, so it holds no pin table: the seven-site sweep landed with the rule. Adding a pin
// back is a hand edit in a review, under `pin-raises`.
//
//   bun run scripts/catch-render.ts [--json]

import type { SourceFile } from './boundaries';
import { enclosingCallee, localDuckRenderers, maskToCode, valueEnd } from './error-render';
import { corpus } from './lib/corpus';
import type { Finding } from './lib/log';
import type { PinTable, RatchetGap } from './lib/ratchet';
import { packageOf, ratchetGaps, ratchetMain } from './lib/ratchet';
import { isTestPath, lineOf } from './lib/source-scan';

const SCRIPT = 'catch-render';

/** How a caught value reached the text. Four mechanisms, each measured to throw on a real value. */
export type CatchRenderKind = 'instanceof' | 'conversion' | 'stringify' | 'interpolation';

export interface CatchRenderSite {
  readonly path: string;
  readonly line: number;
  /** A refusal field, or the name of a package field its own `errors.ts` launders into one. */
  readonly field: string;
  readonly binding: string;
  readonly kind: CatchRenderKind;
}

/**
 * `catch (error)` and `catch (error: unknown)`. A bare `catch {` has no binding and so has nothing
 * to render; the optional annotation is matched because `catch (error: unknown)` is legal and is
 * what `useUnknownInCatchVariables` writes out by hand.
 */
const CATCH_BINDING = /\bcatch\s*\(\s*([A-Za-z_$][\w$]*)\s*(?::\s*(?:unknown|any)\s*)?\)/g;

/**
 * The fields a refusal renders into. `detail` is `@ultimat3/http`'s; `trace` is `@ultimat3/admin`'s
 * `AdminDecision` and was NOT here until 2026-08-23, which is how `packages/admin/src/action-gate.ts`
 * shipped a `String(error)` into one under a green gate — the rule's own name promised a coverage
 * its destination list did not have.
 */
export const REFUSAL_FIELDS: readonly string[] = ['cause', 'fix', 'detail', 'trace'];

/**
 * `cause = …` and `cause: …` both, for a REFUSAL field: an `UltimateError` subclass writes the
 * property and a builder writes the variable, and both end up in the same rendered line.
 */
const fieldKey = (fields: readonly string[]): RegExp =>
  new RegExp(`(?<![.\\w$])(${fields.map((one) => RegExp.escape(one)).join('|')})\\s*[:=]\\s*`, 'g');

/**
 * A LAUNDERED field is matched on `:` alone — an object PROPERTY, never a local binding.
 *
 * The hop this rule follows is `new SomeError({ logs: … })`: a value written into a field of a
 * constructor's input, which that constructor then interpolates. A `const reason = …` that happens
 * to share a name with `FlagInvalidError`'s `input.reason` is a NAME COLLISION and nothing else,
 * and reporting one would be this rule making the mistake `scripts/config-readers.ts` was repaired
 * for on the same day: a bare name matching in an unrelated file is not evidence.
 * Measured — it is the difference between one false finding in this tree and none.
 */
const launderedKey = (fields: readonly string[]): RegExp =>
  new RegExp(`(?<![.\\w$])(${fields.map((one) => RegExp.escape(one)).join('|')})\\s*:\\s*`, 'g');

const FIELD_KEY = fieldKey(REFUSAL_FIELDS);

/** A dotted chain's last segment: `input.logs` -> `logs`, `built.logs.map` -> `logs`. */
const LAUNDERED = /(?:[A-Za-z_$][\w$]*\s*\.\s*)*([A-Za-z_$][\w$]*)/y;

/**
 * The CROSS-FILE hop, and the reason a second destination list exists at all.
 *
 * `packages/cli/src/island-bundle.ts:94` stashed `String(error)` into a field typed `string`, and
 * `packages/cli/src/errors.ts:307` interpolated `${input.logs}` into a `cause:` — ONE FILE AWAY.
 * `error-render.ts` reads a parameter annotated `unknown` and `logs` is annotated `string`, so
 * neither rule could see it: the laundering is legal at both ends and lethal end to end.
 *
 * So a package's own `errors.ts` is read for the field names it interpolates into a refusal, and
 * those names become destinations for every other file in that package. `input.logs` reaching a
 * `cause:` is what makes `logs:` a refusal field for `@ultimat3/cli` and for nobody else.
 *
 * WHAT IT DOES NOT SPAN: a helper in a THIRD file that renders on the error class's behalf, and a
 * field laundered by a package OTHER than the one holding the catch. One hop, stated.
 */
export function launderedFields(errorsSource: string): ReadonlySet<string> {
  const mask = maskToCode(errorsSource);
  const code = mask.code;
  const fields = new Set<string>();
  for (const key of code.matchAll(FIELD_KEY)) {
    const start = key.index + key[0].length;
    const end = valueEnd(code, start);
    for (const substitution of mask.substitutions) {
      if (substitution.start < start || substitution.end > end) continue;
      LAUNDERED.lastIndex = 0;
      const inner = code.slice(substitution.start, substitution.end).trim();
      const match = LAUNDERED.exec(inner);
      // A bare `${code}` names no property and is the constructor's own argument, never a field
      // something else wrote into — only a dotted chain records the hop this rule follows.
      if (match !== null && inner.slice(0, match[0].length).includes('.')) {
        fields.add(match[1] as string);
      }
    }
  }
  // The refusal fields themselves are already destinations; a package re-laundering one adds
  // nothing, and leaving them in would double-count a `cause:` inside `errors.ts`.
  for (const field of REFUSAL_FIELDS) fields.delete(field);
  return fields;
}

/** The span of the block opened after `from`, `{` to its matching `}`. */
function blockAfter(code: string, from: number): { start: number; end: number } | undefined {
  const open = code.indexOf('{', from);
  if (open === -1) return undefined;
  let depth = 0;
  for (let i = open; i < code.length; i += 1) {
    const ch = code[i];
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return { start: open, end: i + 1 };
    }
  }
  return undefined;
}

/**
 * The binding ITSELF and not a property of it — the same test `error-render.ts` makes, and for the
 * same reason: `error.message` is a `string` by the time it is read, so reporting it would report
 * every narrowed catch in the framework and teach an agent to skip the check.
 */
const bare = (code: string, at: number, length: number): boolean => {
  let before = at - 1;
  while (before >= 0 && /\s/.test(code[before] as string)) before -= 1;
  let after = at + length;
  while (after < code.length && /\s/.test(code[after] as string)) after += 1;
  return code[before] !== '.' && !['.', '[', '('].includes(code[after] as string);
};

/** `x instanceof` — the operator that runs a `Proxy` trap and can throw where nothing may. */
const instanceofAt = (span: string, at: number, length: number): boolean =>
  /^\s*instanceof\b/.test(span.slice(at + length));

const CONVERTERS: ReadonlyMap<string, CatchRenderKind> = new Map(
  Object.entries({ 'JSON.stringify': 'stringify', String: 'conversion' } as const),
);

// There is deliberately NO allowlist of safe renderers here. `CONVERTERS` is the whole rule, so a
// callee that is not in it — `renderThrowable`, `renderCauseValue`, `isThrownError`, or an app's
// own helper — is silence by construction. An allowlist beside a two-entry denylist would be dead
// code that reads as load-bearing: measured, deleting `renderThrowable` from one changed no
// finding in this tree, which is what `error-render.ts`'s own comment on that name already says.

interface Occurrence {
  readonly at: number;
  readonly kind: CatchRenderKind;
}

/** Every mechanism turning `binding` into text inside one field's value. */
function mechanisms(
  span: string,
  offset: number,
  binding: string,
  substitutions: readonly { readonly start: number; readonly end: number }[],
  ducks: ReadonlySet<string>,
): readonly Occurrence[] {
  const found: Occurrence[] = [];
  for (const match of span.matchAll(new RegExp(`(?<![\\w$])${binding}(?![\\w$])`, 'g'))) {
    const at = match.index;
    if (!bare(span, at, binding.length)) continue;
    if (instanceofAt(span, at, binding.length)) {
      found.push({ at, kind: 'instanceof' });
      continue;
    }
    const callee = enclosingCallee(span, at);
    if (callee !== undefined) {
      // A file-local helper whose whole body IS `x instanceof Error ? x.message : String(x)` is a
      // call to `String()` with a name in front, and six of those shipped past a name-keyed list.
      if (ducks.has(callee)) {
        found.push({ at, kind: 'conversion' });
        continue;
      }
      const converter = CONVERTERS.get(callee);
      if (converter !== undefined) found.push({ at, kind: converter });
      continue;
    }
    // No call around it: the value is text only if a substitution is what it sits in.
    const inside = substitutions.some((one) => offset + at >= one.start && offset + at < one.end);
    if (inside) found.push({ at, kind: 'interpolation' });
  }
  return found;
}

/**
 * Every caught value that reaches a refusal's text in one file, in source order.
 *
 * ONE SITE PER LINE AND FIELD, deliberately: `error instanceof Error ? error.message :
 * String(error)` is two mechanisms and one repair — `renderThrowable(error)` deletes both — so
 * counting it twice would make a ratchet that a single edit moves by two, and the pin would read
 * as a number of defects when it is a number of occurrences.
 */
export function scanCatchRenders(
  path: string,
  source: string,
  laundered: ReadonlySet<string> = new Set(),
): readonly CatchRenderSite[] {
  const mask = maskToCode(source);
  const code = mask.code;
  const ducks = localDuckRenderers(code);
  const seen = new Set<string>();
  const sites: CatchRenderSite[] = [];
  const patterns = laundered.size === 0 ? [FIELD_KEY] : [FIELD_KEY, launderedKey([...laundered])];
  for (const caught of code.matchAll(CATCH_BINDING)) {
    const binding = caught[1] as string;
    const block = blockAfter(code, caught.index + caught[0].length - 1);
    if (block === undefined) continue;
    const body = code.slice(block.start, block.end);
    for (const key of patterns.flatMap((pattern) => [...body.matchAll(pattern)])) {
      const start = block.start + key.index + key[0].length;
      const end = valueEnd(code, start);
      const span = code.slice(start, end);
      for (const hit of mechanisms(span, start, binding, mask.substitutions, ducks)) {
        const line = lineOf(code, start + hit.at);
        const field = key[1] as string;
        const key_ = `${String(line)}:${field}:${binding}`;
        if (seen.has(key_)) continue;
        seen.add(key_);
        sites.push({ path, line, field, binding, kind: hit.kind });
      }
    }
  }
  return sites;
}

export type CatchRenderGap = RatchetGap<CatchRenderSite>;

export interface CatchRenderInput {
  readonly files: readonly SourceFile[];
  readonly pins: PinTable;
}

/**
 * Each package's laundered field names, keyed by package. `src/errors.ts` and nothing else: it is
 * where every package declares its `UltimateError` subclasses, and widening the search to any file
 * holding a `cause:` would make the destination set the union of every property name in the tree.
 */
export function launderedByPackage(
  files: readonly SourceFile[],
): ReadonlyMap<string, ReadonlySet<string>> {
  const out = new Map<string, ReadonlySet<string>>();
  for (const file of files) {
    const pkg = packageOf(file.path);
    if (file.path !== `packages/${pkg}/src/errors.ts`) continue;
    out.set(pkg, launderedFields(file.source));
  }
  return out;
}

const NOTHING: ReadonlySet<string> = new Set();

/** Every unsafe render in shipped source, each file read against its own package's fields. */
export function catchRenderSites(files: readonly SourceFile[]): readonly CatchRenderSite[] {
  const laundered = launderedByPackage(files);
  return files.flatMap((file) =>
    isTestPath(file.path)
      ? []
      : scanCatchRenders(file.path, file.source, laundered.get(packageOf(file.path)) ?? NOTHING),
  );
}

/** The ratchet: a package may hold what it is pinned at, may fall, may never rise. */
export const checkCatchRenders = (input: CatchRenderInput): readonly CatchRenderGap[] =>
  ratchetGaps(catchRenderSites(input.files), input.pins, input.files.length > 0);

const CAUSE: Readonly<Record<CatchRenderKind, string>> = {
  instanceof:
    'tested with instanceof, whose prototype lookup a Proxy trap can make throw — in the one block with nothing left to answer with',
  conversion:
    "passed to String(), which runs the value's own toString — that throws on a null-prototype object or a throwing toString; a Symbol survives String() and dies in a template literal",
  stringify: 'passed to JSON.stringify, which throws on a bigint and on a cycle',
  interpolation:
    'interpolated into a template, where a Symbol throws and so does a hostile toString',
};

const at = (site: CatchRenderSite | undefined): string =>
  site === undefined ? '' : `${site.path}:${String(site.line)}`;

const overFinding = (gap: CatchRenderGap): Finding => ({
  code: 'X_CATCH_RENDER_UNSAFE',
  cause: `${gap.pkg} renders a caught value into ${String(gap.found)} refusal(s) unsafely and is pinned at ${String(gap.pinned)} — ${at(gap.first)} builds its ${gap.first?.field ?? 'cause'}: from "${gap.first?.binding ?? ''}", ${CAUSE[gap.first?.kind ?? 'conversion']}`,
  fix: `replace the render at ${at(gap.first)} with renderThrowable(${gap.first?.binding ?? 'error'}) from @ultimat3/core`,
  at: at(gap.first),
});

const staleFinding = (gap: CatchRenderGap): Finding => ({
  code: 'X_CATCH_RENDER_PIN_STALE',
  cause: `${gap.pkg} is pinned at ${String(gap.pinned)} unsafe catch render(s) and has ${String(gap.found)} — the pin is above what this tree contains, so it would let ${String(gap.pinned - gap.found)} back in`,
  fix: `edit scripts/catch-render.ts — the rule is zero-pinned and holds no table, so delete the pin for ${gap.pkg}`,
  at: 'scripts/catch-render.ts',
});

/**
 * `at` is the file the `fix:` EDITS — `scripts/lib/corpus.ts`, which owns `PATTERNS` — and
 * not this file, which the repair never touches. Review tooling anchors on `at`, so the two
 * disagreeing sends a reader to the wrong file; `config-readers.ts`, `doc-fixes.ts` and
 * `side-effects.ts` all point their `unscanned` finding at the file their own fix line names.
 */
const unscannedFinding = (): Finding => ({
  code: 'X_CATCH_RENDER_UNSCANNED',
  cause:
    'no source file was read, so every package reports zero and the ratchet enforces nothing — a glob that matches nothing reads exactly like a clean tree',
  fix: 'edit PATTERNS in scripts/lib/corpus.ts so it matches this repo layout, then bun run scripts/catch-render.ts',
  at: 'scripts/lib/corpus.ts',
});

export const catchRenderFindingFor = (gap: CatchRenderGap): Finding =>
  gap.kind === 'over'
    ? overFinding(gap)
    : gap.kind === 'stale'
      ? staleFinding(gap)
      : unscannedFinding();

const treeSites = async (root: string): Promise<readonly CatchRenderSite[]> =>
  catchRenderSites(await corpus(root, 'source'));

export const catchRenderGaps = async (root: string): Promise<readonly CatchRenderGap[]> =>
  ratchetGaps(await treeSites(root), {}, true);

/** What this rule contributes to `x verify`'s `errors` step, through `errorRendering`'s caller. */
export const catchRenderFindings = async (root: string): Promise<readonly Finding[]> =>
  (await catchRenderGaps(root)).map(catchRenderFindingFor);

if (import.meta.main) {
  await ratchetMain({
    script: SCRIPT,
    pinsFile: 'scripts/catch-render.ts',
    pins: {},
    sites: treeSites,
    findingFor: catchRenderFindingFor,
    clean: 'no package renders a caught value into a refusal',
  });
}
