// The half of the error contract that a text rule cannot decide: a `fix:` may cite `x <command>`
// and that command may not exist. Six shipped fix lines named `x db status`, `x logs tail`,
// `x trace`, `x metrics`, `x auth whoami` and `x ai prompts` — every one of them passed the
// `errors` step, because the step checks that a fix NAMES a command, never that the build ships it.
//
// It reads THREE words for the same reason it reads two: `x db branch ls --json` shipped as a fix
// while `x db branch` had no `ls`, because a rule stopping at the subcommand never saw the word
// that decided what ran.

import type { CommandSpec } from './parse';
import { GLOBAL_FLAGS } from './parse';

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
//
// The THIRD slot also matches a `<placeholder>`, and only the third. A slot with a closed set is a
// slot where the reader has nothing to substitute, so `x db branch <name>` — two shipped fix lines
// in `@ultimat3/mcp` — is `X_CLI_UNKNOWN_COMMAND` when run and resolved clean while a placeholder
// was invisible to the reader. Second and fourth slots are open positionals (`x new my-app`,
// `x db branch drop <name>`), where a placeholder is exactly right.
// A `:` is part of a word only when a letter follows it, which is what separates the shipped
// positional `admin:page` from prose that ends a citation with a colon (`x verify: the gate`).
// Read without it, `x g admin:page` cites `x g admin` — a positional the CLI does not ship —
// and the one documented invocation of the admin-page generator was a standing false finding.
const WORD = String.raw`[a-z][a-z\d-]*(?::[a-z][a-z\d-]*)?`;
const CITATION = new RegExp(
  String.raw`(?:^|[\s;|&("'\x60])x\s+(${WORD})(?:\s+(${WORD}))?(?:\s+(${WORD}|<[^>]*>))?`,
  'g',
);

/**
 * A long flag, `--` stripped. `--no-<name>` is the parser's negation of a boolean, so it resolves
 * against `<name>` — reporting `no-example` as an unknown flag would be a finding about a working
 * invocation. A `-j` short form is deliberately not read: one letter is too weak a signal in prose.
 */
const FLAG = /(?:^|\s)--(?:no-)?([a-z][a-z\d-]*)/g;

/**
 * Where a citation's argument list ends. `;`, `|` and `&` start a second shell word, `#` starts a
 * comment, and a backtick or a quote closes the span the citation was written in — past any of
 * them a `--flag` belongs to something else.
 */
const ARGUMENT_END = /[;|&#`'"]/;

/** One `x …` citation, as written. `sub` is the next bare word, which may not be a subcommand. */
export interface FixCitation {
  readonly command: string;
  readonly sub: string | undefined;
  /** The bare word after `sub`. Judged only against a declared `subcommandPositionals` set. */
  readonly positional: string | undefined;
  /** Long flags written after it, in order, `--` and any `no-` stripped. */
  readonly flags: readonly string[];
}

/**
 * Every `x <command> [<word>] [--flag …]` a fix line cites.
 *
 * Read off the STATIC form of the fix — the caller blanks `${…}` first — because a command name
 * assembled at run time is not a name this can resolve, and guessing at one would report findings
 * nobody can act on. `x` alone, or `x --json`, cites nothing: the regex needs a bare lowercase
 * word after the space.
 *
 * The flag list stops at the NEXT citation as well as at `ARGUMENT_END`: one fix line routinely
 * names two commands (`x db migrate, then confirm with x db query "…" --json`), and charging the
 * second command's flags to the first would report a finding on the wrong half of the sentence.
 */
export function fixCitations(fix: string): readonly FixCitation[] {
  const matches = [...fix.matchAll(CITATION)].filter((match) => match[1] !== undefined);
  return matches.map((match, index) => {
    const start = match.index + match[0].length;
    const next = matches[index + 1]?.index ?? fix.length;
    const tail = fix.slice(start, next);
    const stop = ARGUMENT_END.exec(tail)?.index;
    const args = stop === undefined ? tail : tail.slice(0, stop);
    return {
      command: match[1] as string,
      sub: match[2],
      positional: match[3],
      flags: [...args.matchAll(FLAG)].map((flag) => flag[1] as string),
    };
  });
}

/** Long flags a spec accepts: its own, plus the four every command takes. */
const declaredFlags = (spec: CommandSpec): ReadonlySet<string> =>
  new Set([...GLOBAL_FLAGS, ...(spec.flags ?? [])].map((flag) => flag.name));

export interface CommandCatalog {
  /** Every spec the registry holds, planned ones included — `x help` lists those too. */
  readonly specs: readonly CommandSpec[];
  /** Names that parse but exit `X_NOT_IMPLEMENTED`. Citing one is the bug this check closes. */
  readonly planned: ReadonlySet<string>;
  /** `"<command> <subcommand>"` pairs that parse and exit `X_NOT_IMPLEMENTED`. */
  readonly plannedSubcommands: ReadonlySet<string>;
}

/**
 * What a caller accepts from a citation. A `fix:` hands its reader a command to RUN, so a planned
 * one is a defect; a doc page may legitimately *say* a command is planned, and a rule that refused
 * that would delete `wiki/CLI-Reference.md`'s planned table one true row at a time.
 *
 * `allowPlanned` covers `PLANNED_SUBCOMMANDS` as well as `PLANNED_COMMANDS` — `x db studio` is the
 * single entry in the first table, and four pages name it as planned.
 */
export interface CitationRules {
  readonly allowPlanned?: boolean;
}

/**
 * One citation that did not resolve, split so a caller can key on WHAT failed.
 *
 * `subject` is the invocation spelled the way it would be typed — `x db query`, `x env check --fix`
 * — and it is deliberately stable under a doc edit that only moves the sentence around it. That is
 * what lets `scripts/doc-commands-allow.ts` allow one page to name one non-command (the pages that
 * say "there is no `x serve` command" are saying something TRUE) without waiving the rule for the
 * rest of that page.
 */
export interface CitationFault {
  readonly subject: string;
  readonly reason: string;
}

/**
 * A second word is judged as a subcommand ONLY when the spec declares subcommands at all, or
 * against a declared closed set of positionals. `x new my-app` and `x g route posts` take open
 * positionals, and reporting `my-app` as an unknown subcommand would be a finding about a working
 * example.
 */
function wordFault(
  spec: CommandSpec,
  word: string,
  catalog: CommandCatalog,
  rules: CitationRules,
): CitationFault | undefined {
  const subject = `x ${spec.name} ${word}`;
  if (spec.subcommands !== undefined) {
    if (!spec.subcommands.includes(word)) {
      return {
        subject,
        reason: `and ${spec.name} has no such subcommand (${spec.subcommands.join(', ')})`,
      };
    }
    if (catalog.plannedSubcommands.has(`${spec.name} ${word}`) && rules.allowPlanned !== true) {
      return { subject, reason: 'which is planned and exits X_NOT_IMPLEMENTED' };
    }
    return undefined;
  }
  const choices = spec.positionalChoices;
  if (choices === undefined || choices.includes(word)) return undefined;
  return {
    subject,
    reason: `and ${word} is not one of ${spec.name}'s positionals (${choices.join(', ')})`,
  };
}

/**
 * The third word, judged ONLY where the subcommand declares a closed set. `x jobs show <id>` and
 * `x db gen "add publish_at"` take open positionals, so a universal third-word rule would report
 * findings about working invocations — the same conditionality `wordFault` applies to the second.
 */
function positionalFault(spec: CommandSpec, sub: string, word: string): CitationFault | undefined {
  const choices = spec.subcommandPositionals?.[sub];
  if (choices === undefined || choices.includes(word)) return undefined;
  // A placeholder is judged the same as a wrong word, and deliberately: there is nothing the
  // reader could substitute that would make `x db branch <name>` run, because the slot is a verb.
  return {
    subject: `x ${spec.name} ${sub} ${word}`,
    reason: `and ${spec.name} ${sub} takes one of ${choices.join(', ')}`,
  };
}

/**
 * Why a citation does not resolve, or `undefined` when it does. FIVE levels, because the drift is
 * mostly BELOW the command name: `x db query` names a real command and an unreal subcommand,
 * `x env check --fix` names both and an unreal flag, `x test summarize` names a first positional
 * that is not a `TestType`, and `x db branch ls` named a real subcommand and a third word that
 * `x db branch` read as a branch NAME. A rule stopping at the command name accepted all four.
 *
 * The planned check is the one the whole thing exists for: a PLANNED command is in the registry and
 * parses, so a resolution that only asked "is this a known name" would accept `x logs tail` — the
 * exact citation that throws `X_NOT_IMPLEMENTED` at the reader.
 *
 * Flags are NOT judged on a planned command. `cmd-planned.ts` builds its spec from a name, a
 * summary and a usage line and declares no flags at all, so every flag its own usage line documents
 * would read as unknown — while the real refusal is `X_NOT_IMPLEMENTED` one level up.
 */
export function citationFault(
  citation: FixCitation,
  catalog: CommandCatalog,
  rules: CitationRules = {},
): CitationFault | undefined {
  const spec = catalog.specs.find(
    (candidate) =>
      candidate.name === citation.command || candidate.aliases?.includes(citation.command) === true,
  );
  if (spec === undefined) {
    return { subject: `x ${citation.command}`, reason: 'which is not a command' };
  }
  const planned = catalog.planned.has(spec.name);
  if (planned && rules.allowPlanned !== true) {
    return {
      subject: `x ${citation.command}`,
      reason: 'which is planned and exits X_NOT_IMPLEMENTED',
    };
  }
  if (citation.sub !== undefined) {
    const fault = wordFault(spec, citation.sub, catalog, rules);
    if (fault !== undefined) return fault;
    if (citation.positional !== undefined) {
      const deeper = positionalFault(spec, citation.sub, citation.positional);
      if (deeper !== undefined) return deeper;
    }
  }
  if (planned) return undefined;
  const declared = declaredFlags(spec);
  const unknown = citation.flags.find((flag) => !declared.has(flag));
  if (unknown === undefined) return undefined;
  return {
    subject: `x ${spec.name} --${unknown}`,
    reason: `and ${spec.name} declares no such flag — the parser refuses it with X_CLI_BAD_FLAG (known: ${[...declared].join(', ')})`,
  };
}

/** The same answer as one sentence, which is what a `cause:` line wants. */
export function citationProblem(
  citation: FixCitation,
  catalog: CommandCatalog,
  rules: CitationRules = {},
): string | undefined {
  const fault = citationFault(citation, catalog, rules);
  return fault === undefined ? undefined : `cites "${fault.subject}", ${fault.reason}`;
}

/** The first citation that does not resolve. One finding per fix line, not one per word. */
export function citedCommandProblem(
  fix: string,
  catalog: CommandCatalog,
  rules: CitationRules = {},
): string | undefined {
  for (const citation of fixCitations(fix)) {
    const problem = citationProblem(citation, catalog, rules);
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
