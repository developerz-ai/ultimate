#!/usr/bin/env bun
// One rule: `Object.freeze` over an object literal whose type is a CLOSED-KEY `Record` must pass
// that type as an explicit type argument — `Object.freeze<Record<K, V>>({…})`, never
// `const X: Readonly<Record<K, V>> = Object.freeze({…})`, which infers `T` from the literal.
//   bun run scripts/frozen-records.ts [--json]

import { maskLiterals, stripComments } from '@ultimat3/cli';
import { parseScriptArgs } from './lib/args';
import { report } from './lib/log';
import { repoRoot } from './lib/run';
import { isCode, isTestPath, lineOf } from './lib/source-scan';

const SCRIPT = 'frozen-records';

/**
 * Key types that are legitimately OPEN: every key is already known, so no excess-property check
 * is possible or wanted. `Record<string, …>` over SQLSTATE codes or error-code titles is a real
 * dictionary, and demanding a closed key there would be a worse change than the bug.
 */
export const OPEN_KEY_TYPES: readonly string[] = ['string', 'number', 'symbol', 'PropertyKey'];

/**
 * Why the second form is not a style rule. `Object.freeze<T>(o: T)` INFERS `T` from the literal, so
 * the literal is no longer fresh by the time the annotation is checked and excess-property checking
 * never runs: a missing key is an error, an extra key compiles in silence. `spa: 'cache-first'` sat
 * in `@ultimat3/pwa`'s render-mode table after `spa` was deleted from the vocabulary — a mode that
 * did not exist mapped onto the one strategy that gives an `app/` route a SHARED cache entry, one
 * member's authed HTML served to the next — and `tsc` had nothing to say about it. Measured on 21
 * sites: every one silent before, every one a `TS2353` after.
 */
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

/**
 * `const NAME: <annotation> = Object.freeze(` and `const NAME = Object.freeze<`, at ANY
 * indentation — `^[\t ]*` and not `^`, because a declaration nested in a namespace or a block is
 * indented and a guard a newline evades is not a guard.
 */
const DECLARED_FREEZE =
  /^[\t ]*(?:export )?const ([A-Za-z_$][\w$]*)(?::([\s\S]{0,400}?))?\s*=\s*Object\.freeze(<)?\s*\(?/gm;

/** `type NAME = <body>;`, the shape an annotation can launder a closed `Record` through. */
const TYPE_ALIAS = /^[\t ]*(?:export )?(?:declare )?type ([A-Za-z_$][\w$]*)\s*=([^;]*);/gm;

const IDENTIFIER = /[A-Za-z_$][\w$]*/g;

/** Deeper than any alias chain in this tree, and finite where a self-referential alias is not. */
const ALIAS_HOPS = 4;

/**
 * `packages/pwa/src/a.ts` → `packages/pwa`, the unit an alias table is built over. A name declared
 * in two packages is two unrelated types, and TypeScript would never resolve one through the other.
 */
export const packageOf = (at: string): string => at.split('/').slice(0, 2).join('/');

/**
 * An alias body worth following: a `Record<…>`, or a chain of wrappers and names that may reach
 * one. `{`-bearing bodies are excluded on purpose — `type Ctx = { rows: Record<string, R> }` is not
 * a Record annotation, and expanding it would reclassify every `const c: Ctx = Object.freeze({…})`
 * as a table.
 */
const followable = (body: string): boolean =>
  !body.includes('{') && (body.includes('Record<') || /^[\w$<>,\s.]+$/.test(body));

/**
 * Every `type X = …` in the given files that an annotation could name a closed `Record` through.
 * The defect is identical whether the type is spelled inline or borrowed: `const X: FrozenModes =
 * Object.freeze({…})` loses the literal's freshness exactly as `Readonly<Record<K, V>>` does, and
 * was read as `unconstrained` until this table existed.
 *
 * A name declared TWICE with two bodies is dropped, not resolved. The earlier rule kept the body
 * mentioning `Record<` and called that the conservative half; it is the opposite one. Keeping the
 * `Record<` body maximises FINDINGS, and a finding produced by a name collision is a false one —
 * `type Config = { host: string }` in `mail`, annotated onto a freeze there, resolved through
 * `pwa`'s `type Config = Readonly<Record<RenderMode, …>>` and reported `mail` for a key type `mail`
 * never wrote. 19 alias names are declared in more than one package `As of 2026-08-21` — `Row`,
 * `JsonObject`, `RouteParams` among them — and three already carry a `Record<` body, so this is one
 * closed-key alias away rather than hypothetical. Refusing an ambiguous name is silence; resolving
 * it wrongly is a red gate no edit at the cited site can honestly clear.
 */
export function aliasTable(files: readonly SourceFile[]): ReadonlyMap<string, string> {
  const aliases = new Map<string, string>();
  const ambiguous = new Set<string>();
  for (const file of files) {
    const text = stripComments(file.text);
    const masked = maskLiterals(file.text);
    for (const match of text.matchAll(TYPE_ALIAS)) {
      if (!isCode(masked, match.index, match[0] as string)) continue;
      const body = (match[2] as string).trim();
      const name = match[1] as string;
      if (!followable(body)) continue;
      const held = aliases.get(name);
      if (held === undefined) aliases.set(name, body);
      else if (held !== body) ambiguous.add(name);
    }
  }
  for (const name of ambiguous) aliases.delete(name);
  return aliases;
}

/**
 * An annotation with every alias name it mentions replaced by that alias's body, repeatedly, so an
 * indirection two hops deep still resolves. Bounded rather than run to a fixed point: an alias that
 * mentions itself never settles.
 */
export function expandAliases(annotation: string, aliases: ReadonlyMap<string, string>): string {
  let out = annotation;
  for (let hop = 0; hop < ALIAS_HOPS; hop += 1) {
    const next = out.replace(IDENTIFIER, (name) => aliases.get(name) ?? name);
    if (next === out) break;
    out = next;
  }
  return out;
}

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
 * second build of the whole graph. Comments come out first, so an annotation carrying one is still
 * readable; `maskLiterals` decides what is code, so a freeze quoted in a scaffold template is not.
 *
 * What it CANNOT see, and therefore what still needs review rather than a green check:
 *   - a `freeze` that is not the initialiser of a `const` — a `return Object.freeze({…})` inside a
 *     factory, a nested `Object.freeze` in a property value, a `let`;
 *   - `Object.freeze({…}) as Record<K, V>` — a cast, which loses freshness the same way;
 *   - an alias declared outside the scanned tree, in ANOTHER package (the table is built per
 *     package, so an alias reached by a cross-package import does not resolve), or declared twice
 *     inside one package with two bodies (`aliasTable` refuses an ambiguous name);
 *   - an alias whose body is an object type rather than a `Record` (`followable` refuses it) —
 *     including a mapped type spelled by hand;
 *   - an interface annotation (`const c: Clock = Object.freeze({…})`), which also admits an extra
 *     property. Deliberately out of scope: an extra property on a config object is dead weight,
 *     where an extra ROW in a closed-key table is a lookup nothing can reach.
 * Each of those is silence, not a pass. The vacuity guard below is what keeps the silence from
 * becoming the whole answer.
 */
export function scanFreezeSites(
  source: string,
  at: string,
  aliases: ReadonlyMap<string, string> = new Map(),
): readonly FreezeSite[] {
  const text = stripComments(source);
  const masked = maskLiterals(source);
  const sites: FreezeSite[] = [];
  for (const match of text.matchAll(DECLARED_FREEZE)) {
    if (!isCode(masked, match.index, match[0] as string)) continue;
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
    const keyType =
      annotation === undefined ? undefined : recordKeyType(expandAliases(annotation, aliases));
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
  const owned = new Map<string, SourceFile[]>();
  for (const file of files) {
    const list = owned.get(packageOf(file.at));
    if (list === undefined) owned.set(packageOf(file.at), [file]);
    else list.push(file);
  }
  const tables = new Map<string, ReadonlyMap<string, string>>();
  for (const [pkg, list] of owned) tables.set(pkg, aliasTable(list));
  const findings: Finding[] = [];
  for (const file of files) {
    const aliases = tables.get(packageOf(file.at)) ?? new Map<string, string>();
    for (const site of scanFreezeSites(file.text, file.at, aliases)) {
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

export async function readSources(root: string): Promise<readonly SourceFile[]> {
  const files: SourceFile[] = [];
  for await (const path of new Bun.Glob(SOURCE_GLOB).scan({ cwd: root })) {
    if (isTestPath(path) || path.includes('/dist/')) continue;
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
