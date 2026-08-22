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
// runs a hostile `toString` and throws outright on a Symbol; `JSON.stringify` throws on a bigint
// and on a cycle. Each turns a coded refusal into an uncoded crash, in the exact place the process
// has no second chance. `renderThrowable(value)` is the total form and is one import.
//
// WHAT IT CANNOT SEE: a caught value handed to a helper that renders it two files away, a
// `.message` read on its own (a getter can throw too), and a rethrow whose renderer is the
// constructor's. A floor, like the check beside it.
//
//   bun run scripts/catch-render.ts [--json]
//   bun run scripts/catch-render.ts --unpin <pkg>[,<pkg>]   # shrink the ratchet

import type { SourceFile } from './boundaries';
import { collectSourceFiles } from './boundaries';
import { enclosingCallee, lineOf, localDuckRenderers, maskToCode, valueEnd } from './error-render';
import { flagList, parseScriptArgs } from './lib/args';
import {
  applyCatchRenderUnpin,
  CATCH_PINS_FILE,
  CATCH_RENDER_PINS,
  catchRenderPinnedFor,
} from './lib/catch-render-pins';
import type { Finding } from './lib/log';
import { report } from './lib/log';
import { repoRoot } from './lib/run';
import { packageOf } from './test-fix-citations';

const SCRIPT = 'catch-render';

/** How a caught value reached the text. Four mechanisms, each measured to throw on a real value. */
export type CatchRenderKind = 'instanceof' | 'conversion' | 'stringify' | 'interpolation';

export interface CatchRenderSite {
  readonly path: string;
  readonly line: number;
  readonly field: 'cause' | 'fix' | 'detail';
  readonly binding: string;
  readonly kind: CatchRenderKind;
}

/**
 * `catch (error)` and `catch (error: unknown)`. A bare `catch {` has no binding and so has nothing
 * to render; the optional annotation is matched because `catch (error: unknown)` is legal and is
 * what `useUnknownInCatchVariables` writes out by hand.
 */
const CATCH_BINDING = /\bcatch\s*\(\s*([A-Za-z_$][\w$]*)\s*(?::\s*(?:unknown|any)\s*)?\)/g;

/** The three fields a refusal renders into. `detail` is `@ultimat3/http`'s and carries the same risk. */
const FIELD_KEY = /(?<![.\w$])(cause|fix|detail)\s*[:=]\s*/g;

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
export function scanCatchRenders(path: string, source: string): readonly CatchRenderSite[] {
  const mask = maskToCode(source);
  const code = mask.code;
  const ducks = localDuckRenderers(code);
  const seen = new Set<string>();
  const sites: CatchRenderSite[] = [];
  for (const caught of code.matchAll(CATCH_BINDING)) {
    const binding = caught[1] as string;
    const block = blockAfter(code, caught.index + caught[0].length - 1);
    if (block === undefined) continue;
    const body = code.slice(block.start, block.end);
    for (const key of body.matchAll(FIELD_KEY)) {
      const start = block.start + key.index + key[0].length;
      const end = valueEnd(code, start);
      const span = code.slice(start, end);
      for (const hit of mechanisms(span, start, binding, mask.substitutions, ducks)) {
        const line = lineOf(code, start + hit.at);
        const field = key[1] as CatchRenderSite['field'];
        const key_ = `${String(line)}:${field}:${binding}`;
        if (seen.has(key_)) continue;
        seen.add(key_);
        sites.push({ path, line, field, binding, kind: hit.kind });
      }
    }
  }
  return sites;
}

const isTest = (path: string): boolean => /\.(?:test|spec|d)\.tsx?$/.test(path);

export type CatchRenderGapKind = 'over' | 'stale' | 'unscanned';

export interface CatchRenderGap {
  readonly kind: CatchRenderGapKind;
  readonly pkg: string;
  readonly found: number;
  readonly pinned: number;
  readonly first?: CatchRenderSite;
}

export interface CatchRenderInput {
  readonly files: readonly SourceFile[];
  readonly pins: Readonly<Record<string, number>>;
}

/** The ratchet: a package may hold what it is pinned at, may fall, may never rise. */
export function checkCatchRenders(input: CatchRenderInput): readonly CatchRenderGap[] {
  if (input.files.length === 0) {
    return [{ kind: 'unscanned', pkg: '', found: 0, pinned: 0 }];
  }
  const found = new Map<string, CatchRenderSite[]>();
  for (const file of input.files) {
    if (isTest(file.path)) continue;
    for (const site of scanCatchRenders(file.path, file.source)) {
      const list = found.get(packageOf(site.path)) ?? [];
      list.push(site);
      found.set(packageOf(site.path), list);
    }
  }
  const gaps: CatchRenderGap[] = [];
  for (const pkg of new Set([...found.keys(), ...Object.keys(input.pins)])) {
    const hits = found.get(pkg) ?? [];
    const pinned = catchRenderPinnedFor(pkg, input.pins);
    if (hits.length > pinned) {
      gaps.push({
        kind: 'over',
        pkg,
        found: hits.length,
        pinned,
        ...(hits[0] === undefined ? {} : { first: hits[0] }),
      });
      continue;
    }
    if (hits.length < pinned) gaps.push({ kind: 'stale', pkg, found: hits.length, pinned });
  }
  return gaps.sort((a, b) => (a.pkg < b.pkg ? -1 : a.pkg > b.pkg ? 1 : 0));
}

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
  fix: `bun run scripts/catch-render.ts --unpin ${gap.pkg}`,
  at: CATCH_PINS_FILE,
});

const unscannedFinding = (): Finding => ({
  code: 'X_CATCH_RENDER_UNSCANNED',
  cause:
    'no source file was read, so every package reports zero and the ratchet enforces nothing — a glob that matches nothing reads exactly like a clean tree',
  fix: 'edit SOURCE_PATTERNS in scripts/boundaries.ts so it matches this repo layout, then bun run scripts/catch-render.ts',
  at: 'scripts/catch-render.ts',
});

const FINDINGS: Readonly<Record<CatchRenderGapKind, (gap: CatchRenderGap) => Finding>> = {
  over: overFinding,
  stale: staleFinding,
  unscanned: unscannedFinding,
};

export const catchRenderFindingFor = (gap: CatchRenderGap): Finding => FINDINGS[gap.kind](gap);

export const catchRenderGaps = async (root: string): Promise<readonly CatchRenderGap[]> =>
  checkCatchRenders({ files: await collectSourceFiles(root), pins: CATCH_RENDER_PINS });

/** What this rule contributes to `x verify`'s `errors` step, through `errorRendering`'s caller. */
export const catchRenderFindings = async (root: string): Promise<readonly Finding[]> =>
  (await catchRenderGaps(root)).map(catchRenderFindingFor);

/** Every site per package, for `--unpin` and for the number a maintainer wants when lowering one. */
export async function catchRenderCounts(root: string): Promise<Readonly<Record<string, number>>> {
  const counts: Record<string, number> = {};
  for (const file of await collectSourceFiles(root)) {
    if (isTest(file.path)) continue;
    for (const site of scanCatchRenders(file.path, file.source)) {
      counts[packageOf(site.path)] = (counts[packageOf(site.path)] ?? 0) + 1;
    }
  }
  return counts;
}

if (import.meta.main) {
  const args = parseScriptArgs(Bun.argv.slice(2));
  const root = repoRoot();
  const unpin = flagList(args, 'unpin');
  if (unpin.length > 0) {
    const lowered = await applyCatchRenderUnpin(root, unpin, await catchRenderCounts(root));
    report(
      {
        ok: true,
        script: SCRIPT,
        summary:
          lowered.length === 0
            ? 'nothing to lower — every named package is already at what this tree measures'
            : `lowered ${String(lowered.length)} pin(s): ${lowered.join(', ')}`,
        findings: [],
      },
      args.json,
    );
  } else {
    const gaps = await catchRenderGaps(root);
    report(
      {
        ok: gaps.length === 0,
        script: SCRIPT,
        summary:
          gaps.length === 0
            ? 'no package renders a caught value into a refusal above its pin'
            : `${String(gaps.length)} package(s) off the catch-render ratchet`,
        findings: gaps.map(catchRenderFindingFor),
        data: { counts: await catchRenderCounts(root) },
      },
      args.json,
    );
  }
}
