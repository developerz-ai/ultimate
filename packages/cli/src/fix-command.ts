// The half of the error contract that a text rule cannot decide: a `fix:` may cite `x <command>`
// and that command may not exist. Six shipped fix lines named `x db status`, `x logs tail`,
// `x trace`, `x metrics`, `x auth whoami` and `x ai prompts` — every one of them passed the
// `errors` step, because the step checks that a fix NAMES a command, never that the build ships it.

import type { CommandSpec } from './parse';

/**
 * The rule is CONDITIONAL, and that is the whole design.
 *
 * *If* a fix cites `x <something>`, that something must resolve. It does NOT say every fix must
 * name a command — axiom 4 asks for an executable instruction, and
 * `set OTEL_EXPORTER_OTLP_ENDPOINT=http://otel-collector:4318` or
 * `counter('orders_total', { maxSeries: 4000 })` are executable and correctly cite nothing. A
 * universal rule would push an author towards citing a command that does not really fix it, which
 * is a worse error than one with no command in it.
 */
// Digits are part of a name, not a boundary: `x i18n check` read through `[a-z-]*` alone cites
// `x i`, which is not a command — a false finding on three of the framework's own fix lines.
const CITATION = /(?:^|[\s;|&("'`])x\s+([a-z][a-z\d-]*)(?:\s+([a-z][a-z\d-]*))?/g;

/** One `x …` citation, as written. `sub` is the next bare word, which may not be a subcommand. */
export interface FixCitation {
  readonly command: string;
  readonly sub: string | undefined;
}

/**
 * Every `x <command> [<word>]` a fix line cites.
 *
 * Read off the STATIC form of the fix — the caller blanks `${…}` first — because a command name
 * assembled at run time is not a name this can resolve, and guessing at one would report findings
 * nobody can act on. `x` alone, or `x --json`, cites nothing: the regex needs a bare lowercase
 * word after the space.
 */
export function fixCitations(fix: string): readonly FixCitation[] {
  const found: FixCitation[] = [];
  for (const match of fix.matchAll(CITATION)) {
    const command = match[1];
    if (command === undefined) continue;
    found.push({ command, sub: match[2] });
  }
  return found;
}

export interface CommandCatalog {
  /** Every spec the registry holds, planned ones included — `x help` lists those too. */
  readonly specs: readonly CommandSpec[];
  /** Names that parse but exit `X_NOT_IMPLEMENTED`. Citing one is the bug this check closes. */
  readonly planned: ReadonlySet<string>;
  /** `"<command> <subcommand>"` pairs that parse and exit `X_NOT_IMPLEMENTED`. */
  readonly plannedSubcommands: ReadonlySet<string>;
}

/**
 * Why a citation does not resolve, or `undefined` when it does.
 *
 * Three ways to fail, and the second is the one the whole check exists for: a PLANNED command is
 * in the registry and parses, so a resolution that only asked "is this a known name" would accept
 * `x logs tail` — the exact citation that throws `X_NOT_IMPLEMENTED` at the reader.
 *
 * A second word is judged as a subcommand ONLY when the spec declares subcommands at all.
 * `x new my-app` and `x g route posts` take positionals, and reporting `my-app` as an unknown
 * subcommand would be a finding about a working example.
 */
export function citationProblem(
  citation: FixCitation,
  catalog: CommandCatalog,
): string | undefined {
  const spec = catalog.specs.find(
    (candidate) =>
      candidate.name === citation.command || candidate.aliases?.includes(citation.command) === true,
  );
  if (spec === undefined) return `cites "x ${citation.command}", which is not a command`;
  if (catalog.planned.has(spec.name)) {
    return `cites "x ${citation.command}", which is planned and exits X_NOT_IMPLEMENTED`;
  }
  const sub = citation.sub;
  if (sub === undefined || spec.subcommands === undefined) return undefined;
  if (!spec.subcommands.includes(sub)) {
    return `cites "x ${spec.name} ${sub}", and ${spec.name} has no such subcommand (${spec.subcommands.join(', ')})`;
  }
  if (catalog.plannedSubcommands.has(`${spec.name} ${sub}`)) {
    return `cites "x ${spec.name} ${sub}", which is planned and exits X_NOT_IMPLEMENTED`;
  }
  return undefined;
}

/** The first citation that does not resolve. One finding per fix line, not one per word. */
export function citedCommandProblem(fix: string, catalog: CommandCatalog): string | undefined {
  for (const citation of fixCitations(fix)) {
    const problem = citationProblem(citation, catalog);
    if (problem !== undefined) return problem;
  }
  return undefined;
}

/**
 * The registry, as this check reads it.
 *
 * Imported dynamically because `registry.ts` → `cmd-verify.ts` → `error-contract.ts` closes a
 * cycle back to the caller. The precedent is `cmd-build.ts`'s `await import('./cmd-verify')`:
 * one break, inside a function that is already async, rather than a second copy of the command
 * list here — which would be a catalog that can disagree with the one `x help` prints.
 */
export async function loadCommandCatalog(): Promise<CommandCatalog> {
  const { SPECS } = await import('./registry');
  const { PLANNED_COMMANDS, PLANNED_SUBCOMMANDS } = await import('./cmd-planned');
  return {
    specs: SPECS,
    planned: new Set(PLANNED_COMMANDS.map((planned) => planned.name)),
    plannedSubcommands: new Set(
      PLANNED_SUBCOMMANDS.map((planned) => `${planned.command} ${planned.subcommand}`),
    ),
  };
}
