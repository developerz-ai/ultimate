// A flag a command declares and nothing reads: `x deploy --critical` parsed, printed itself in
// `x help deploy`, and changed nothing about the deploy. The parser accepts every declared flag,
// so a flag with no reader is not a parse error and not a type error — it is a promise in the help
// text with no code behind it, and only a rule over the two halves together can see that.

// `join`/`relative` are `node:`-only by necessity: Bun exposes no path-join primitive.
import { join, relative } from 'node:path';
import { docsFor } from './error-codes';
import type { Finding } from './output';
import type { CommandSpec, FlagSpec } from './parse';
import { GLOBAL_FLAGS } from './parse';
import { stripComments } from './ts-scan';

/** A flag as declared, with the command that declares it. */
export interface DeclaredFlag {
  readonly command: string;
  readonly flag: FlagSpec;
}

/**
 * Every flag a command declares. The global four are excluded: `--json`, `--help`, `--cwd` and
 * `--verbose` are the parser's and the dispatcher's, read once for every command rather than by
 * the command that lists them, and a per-command rule would report all 30 of them as unread.
 */
export function declaredFlags(specs: readonly CommandSpec[]): readonly DeclaredFlag[] {
  const global = new Set(GLOBAL_FLAGS.map((flag) => flag.name));
  return specs.flatMap((spec) =>
    (spec.flags ?? [])
      .filter((flag) => !global.has(flag.name))
      .map((flag) => ({ command: spec.name, flag })),
  );
}

/** A flag name is `[a-z][a-z-]*`, so nothing in it is a regex metacharacter to escape. */
const literalOf = (name: string): RegExp => new RegExp(`(['"\`])${name}\\1`, 'g');

/**
 * The declaration itself, which is never a read. `{ name: 'critical', … }` and its `short:` twin
 * are the two places the name appears as a spec field; every other occurrence of the bare literal
 * is a reader — `flagBool(ctx.args, 'critical')`, a table key, a constant the reader indexes with.
 */
const declarationOf = (name: string): RegExp =>
  new RegExp(`(?:name|short)\\s*:\\s*(['"\`])${name}\\1`, 'g');

const countIn = (text: string, pattern: RegExp): number => [...text.matchAll(pattern)].length;

/**
 * Whether this file reads the flag, as against merely declaring it. Deliberately generous: a flag
 * consumed only by being echoed into `--json`, or read through a shared constant rather than by
 * name at the call site, is still read — the rule exists to catch a flag NOTHING mentions, and a
 * gate that guessed at intent would report findings about working commands.
 */
export const readsFlag = (text: string, name: string): boolean =>
  countIn(text, literalOf(name)) > countIn(text, declarationOf(name));

const declaresFlag = (text: string, name: string): boolean =>
  countIn(text, declarationOf(name)) > 0;

const unreadFinding = (declared: DeclaredFlag, at: string): Finding => ({
  code: 'X_CLI_FLAG_UNREAD',
  cause: `x ${declared.command} declares --${declared.flag.name} ("${declared.flag.summary}") and no file in the CLI's source reads it, so the flag parses and changes nothing`,
  fix: `read it in ${at} with flag${declared.flag.type === 'boolean' ? 'Bool' : 'String'}(ctx.args, '${declared.flag.name}'), or delete it from the spec's flags`,
  docs: docsFor('X_CLI_FLAG_UNREAD'),
  at,
});

/**
 * Every declared flag held to one rule: something reads it.
 *
 * Scans source rather than the runtime, because "is this value ever consumed?" is not a question
 * a `run` can be asked without running it — and running every command is not a check, it is the
 * program. Comments are stripped first: a flag named only in the prose above the spec is not read,
 * and a scanner that counted it would pass exactly the flags most likely to be dead.
 */
export async function checkFlagReads(
  specs: readonly CommandSpec[],
  srcDir: string,
): Promise<readonly Finding[]> {
  const texts = new Map<string, string>();
  try {
    for await (const path of new Bun.Glob('**/*.ts').scan({ cwd: srcDir, absolute: false })) {
      if (/\.test\.tsx?$/.test(path)) continue;
      texts.set(path, stripComments(await Bun.file(join(srcDir, path)).text()));
    }
  } catch {
    // The directory is not there. `Bun.Glob.scan` raises rather than yielding nothing, so the
    // absent case has to be caught here — see the `texts.size` guard below for why it answers [].
    return [];
  }
  // No CLI source under this root: the rule holds two halves against each other and only one is
  // here, so there is nothing it can decide. Derived, not "is this the framework repo" — the same
  // condition `scripts/release-workflow.ts` uses for a tree with no publishable workspace. Scanning
  // on would report EVERY declared flag as unread, which is the false-positive direction and the
  // one that trains a reader to ignore the check.
  if (texts.size === 0) return [];
  const findings: Finding[] = [];
  for (const declared of declaredFlags(specs)) {
    const name = declared.flag.name;
    if ([...texts.values()].some((text) => readsFlag(text, name))) continue;
    const declaringFile = [...texts].find(([, text]) => declaresFlag(text, name))?.[0];
    findings.push(unreadFinding(declared, join(relative('', srcDir), declaringFile ?? '')));
  }
  return findings;
}
