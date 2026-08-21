#!/usr/bin/env bun
// One rule: `Object.freeze` over an object literal whose type is a CLOSED-KEY `Record` must pass
// that type as an explicit type argument — `Object.freeze<Record<K, V>>({…})`, never
// `const X: Readonly<Record<K, V>> = Object.freeze({…})`.
//
// The second form looks like it constrains a closed set and does not. `Object.freeze<T>(o: T)`
// INFERS `T` from the literal, so the literal is no longer fresh by the time the annotation is
// checked, and excess-property checking never runs: a missing key is an error, an extra key
// compiles in silence. Measured on 21 sites — every one of them silent before, every one a
// `TS2353` after.
//
// It is not a style rule. `spa: 'cache-first'` sat in `@ultimat3/pwa`'s render-mode table after
// `spa` was deleted from the vocabulary, mapping a mode that did not exist onto the one strategy
// that gives an `app/` route a SHARED cache entry — one member's authed HTML served to the next —
// and `tsc` had nothing to say about it.
//
//   bun run scripts/frozen-records.ts [--json]

import { parseScriptArgs } from './lib/args';
import { report } from './lib/log';
import { repoRoot } from './lib/run';

const SCRIPT = 'frozen-records';

/**
 * Key types that are legitimately OPEN: every key is already known, so no excess-property check
 * is possible or wanted. `Record<string, …>` over SQLSTATE codes or error-code titles is a real
 * dictionary, and demanding a closed key there would be a worse change than the bug.
 */
export const OPEN_KEY_TYPES: readonly string[] = ['string', 'number', 'symbol', 'PropertyKey'];

export type FreezeShape =
  /** `Object.freeze<T>({…})` — the literal is contextually typed. Correct. */
  | 'explicit'
  /** `const X: …Record<ClosedKey, V>… = Object.freeze({…})` — the defect. */
  | 'annotated-closed'
  /** The same shape over an open key type. Nothing to enforce; left alone on purpose. */
  | 'annotated-open'
  /** No `Record` in the annotation, or no annotation, or the argument is not a literal. */
  | 'unconstrained';

export interface FreezeSite {
  readonly at: string;
  readonly line: number;
  readonly name: string;
  readonly shape: FreezeShape;
  readonly keyType?: string;
}

export interface SourceFile {
  readonly at: string;
  readonly text: string;
}

export interface Finding {
  readonly at: string;
  readonly cause: string;
  readonly fix: string;
}

/** `const NAME: <annotation> = Object.freeze(` and `const NAME = Object.freeze<`, at column 0. */
const DECLARED_FREEZE =
  /^(?:export )?const ([A-Za-z_$][\w$]*)(?::([\s\S]{0,400}?))?\s*=\s*Object\.freeze(<)?\s*\(?/gm;

const lineOf = (text: string, index: number): number => text.slice(0, index).split('\n').length;

/**
 * The first type argument of the OUTERMOST `Record<…>` in an annotation, by angle-bracket depth.
 * Depth-counted rather than split on the first comma: `Record<MailToken, Readonly<Record<Scheme,
 * string>>>` has three commas' worth of nesting and a naive split reads the inner key.
 */
export function recordKeyType(annotation: string): string | undefined {
  const start = annotation.indexOf('Record<');
  if (start === -1) return undefined;
  let depth = 0;
  for (let i = start + 'Record'.length; i < annotation.length; i += 1) {
    const ch = annotation[i];
    if (ch === '<') depth += 1;
    else if (ch === '>') {
      depth -= 1;
      if (depth === 0) return annotation.slice(start + 'Record<'.length, i).trim();
    } else if (ch === ',' && depth === 1) {
      return annotation.slice(start + 'Record<'.length, i).trim();
    }
  }
  return undefined;
}

/** A key type is open when ANY member of it is. `string | 'a'` accepts every string. */
export const isOpenKey = (keyType: string): boolean =>
  keyType.split('|').some((part) => OPEN_KEY_TYPES.includes(part.trim()));

/**
 * Every `Object.freeze` a file declares a `const` from, classified. Read as TEXT, deliberately not
 * with `tsc`: this runs in the `unit` step, where a type-checker is not available and would be a
 * second build of the whole graph.
 *
 * What it CANNOT see, and therefore what still needs review rather than a green check:
 *   - a `freeze` that is not the initialiser of a top-level `const` — a `return Object.freeze({…})`
 *     inside a factory, a nested `Object.freeze` in a property value, an indented declaration;
 *   - a type laundered through an alias: `const X: FrozenModes = Object.freeze({…})` where
 *     `FrozenModes = Readonly<Record<Mode, V>>` resolves to a closed key this scan cannot follow;
 *   - `Object.freeze({…}) as Record<K, V>` — a cast, which loses freshness the same way;
 *   - an interface annotation (`const c: Clock = Object.freeze({…})`), which also admits an extra
 *     property. Deliberately out of scope: an extra property on a config object is dead weight,
 *     where an extra ROW in a closed-key table is a lookup nothing can reach.
 * Each of those is silence, not a pass. The vacuity guard below is what keeps the silence from
 * becoming the whole answer.
 */
export function scanFreezeSites(text: string, at: string): readonly FreezeSite[] {
  const sites: FreezeSite[] = [];
  for (const match of text.matchAll(DECLARED_FREEZE)) {
    const name = match[1] as string;
    const annotation = match[2];
    const line = lineOf(text, match.index);
    if (match[3] === '<') {
      sites.push({ at, line, name, shape: 'explicit' });
      continue;
    }
    // Only an object LITERAL is fresh; `Object.freeze(fromEntries(…))` has nothing to check.
    const literal = text
      .slice(match.index + match[0].length)
      .trimStart()
      .startsWith('{');
    const keyType = annotation === undefined ? undefined : recordKeyType(annotation);
    if (annotation === undefined || keyType === undefined || !literal) {
      sites.push({ at, line, name, shape: 'unconstrained' });
      continue;
    }
    const shape: FreezeShape = isOpenKey(keyType) ? 'annotated-open' : 'annotated-closed';
    sites.push({ at, line, name, shape, keyType });
  }
  return sites;
}

const finding = (site: FreezeSite): Finding => ({
  at: `${site.at}:${site.line}`,
  cause: `${site.name} in ${site.at} annotates a Record keyed on ${site.keyType ?? ''} but lets Object.freeze infer it, so an extra key compiles silently`,
  fix: `write it as Object.freeze<...>({ ... }) with the type argument spelled out, and drop the annotation — run \`bun run scripts/frozen-records.ts --json\` to re-read the sites`,
});

const vacuous = (cause: string): Finding => ({
  at: 'scripts/frozen-records.ts',
  cause,
  fix: 'fix the scan in scripts/frozen-records.ts — a rule that reads nothing reports the same "ok" as a clean tree',
});

export interface FrozenReport {
  readonly findings: readonly Finding[];
  readonly counts: Readonly<Record<FreezeShape, number>>;
}

/**
 * The rule, plus the counts that make its `ok` mean something. A scan that matched nothing would
 * otherwise answer exactly what a clean tree answers — the failure both of this repo's other
 * source-scanning guards had to be built against.
 */
export function checkFrozenRecords(files: readonly SourceFile[]): FrozenReport {
  const counts = { explicit: 0, 'annotated-closed': 0, 'annotated-open': 0, unconstrained: 0 };
  const findings: Finding[] = [];
  for (const file of files) {
    for (const site of scanFreezeSites(file.text, file.at)) {
      counts[site.shape] += 1;
      if (site.shape === 'annotated-closed') findings.push(finding(site));
    }
  }
  const total = Object.values(counts).reduce((sum, one) => sum + one, 0);
  if (total === 0) return { findings: [vacuous('the scan found no Object.freeze at all')], counts };
  if (counts.explicit === 0) {
    return {
      findings: [
        vacuous('the scan found no Object.freeze<T>({…}) site, so it recognises no correct form'),
      ],
      counts,
    };
  }
  return { findings, counts };
}

export const SOURCE_GLOB = 'packages/*/src/**/*.{ts,tsx}';

const isTest = (path: string): boolean => /\.(test|spec)\.tsx?$/.test(path);

export async function readSources(root: string): Promise<readonly SourceFile[]> {
  const files: SourceFile[] = [];
  for await (const path of new Bun.Glob(SOURCE_GLOB).scan({ cwd: root })) {
    if (isTest(path) || path.includes('/dist/')) continue;
    files.push({ at: path, text: await Bun.file(`${root}/${path}`).text() });
  }
  return files.sort((a, b) => a.at.localeCompare(b.at));
}

export const frozenRecordReport = async (root: string): Promise<FrozenReport> =>
  checkFrozenRecords(await readSources(root));

if (import.meta.main) {
  const args = parseScriptArgs(Bun.argv.slice(2));
  const { findings, counts } = await frozenRecordReport(repoRoot());
  report(
    {
      ok: findings.length === 0,
      script: SCRIPT,
      summary:
        findings.length === 0
          ? `${counts.explicit} closed-key freeze(s) spell their type argument, ${counts['annotated-open']} open-key left alone`
          : `${findings.length} Object.freeze site(s) that admit an extra key in silence`,
      lines: findings.map((one) => `  ${one.at}\n    cause: ${one.cause}\n    fix:   ${one.fix}`),
      data: { counts, findings },
    },
    args.json,
  );
}
