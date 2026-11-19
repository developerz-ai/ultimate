// `x policy list|explain` — which clause decided a permission, and why. This file is CLI wiring
// only: the fact-gathering (registries, matrix rows) lives in `policy-facts.ts`, so the matrix
// logic is testable without an app — same split as `cmd-jobs.ts` / `jobs-report.ts`.

import { nearestName } from '@ultimat3/core';
import { loadApp } from './app-load';
import { requireAppRoot } from './app-root';
import { policySpec } from './cmd-policy-spec';
import type { CliCommand, CommandContext } from './command';
import { BadFlagError, DeclarationUnknownError, MissingPositionalError } from './errors';
import { msg } from './messages';
import type { CommandResult, Finding, JsonValue } from './output';
import type { DeclarationExplanation, ExplainOptions, ExplainVerdict } from './policy-facts';
import { explainPolicy, knownPolicySubjects, listPolicy } from './policy-facts';
import { quoteArg } from './shell-quote';
import { renderTable } from './table';

/** A descriptor is plain JSON by construction — same idiom as `cmd-registries.ts`'s `asJson`. */
const asJson = (value: object): Record<string, JsonValue> => value as Record<string, JsonValue>;

const joinOrDash = (values: readonly string[]): string =>
  values.length === 0 ? msg('cli.policy.none') : values.join(',');

function runList(findings: readonly Finding[]): CommandResult {
  const facts = listPolicy();
  const header = ['permission', 'roles', 'actions', 'queries'];
  const rows = facts.rows.map((row) => [
    row.permission,
    joinOrDash(row.roles),
    joinOrDash(row.actions),
    joinOrDash(row.queries),
  ]);
  const lines: string[] =
    facts.rows.length === 0 ? [] : renderTable(header, rows).map((line) => `  ${line}`);
  if (facts.unenforced.length > 0) {
    lines.push(`  ${msg('cli.policy.unenforced', { count: facts.unenforced.length })}`);
    for (const permission of facts.unenforced) lines.push(`    ${permission}`);
  }
  return {
    ok: findings.length === 0,
    command: 'policy',
    summary: msg('cli.policy.count', {
      permissions: facts.rows.length,
      roles: facts.roleCount,
      enforced: facts.enforcedCount,
    }),
    lines,
    findings,
    data: facts.rows.map((row) => asJson(row)),
  };
}

const VERDICT_KEYS = {
  allow: 'cli.policy.allow',
  deny: 'cli.policy.deny',
  'needs-input': 'cli.policy.needsInput',
} as const satisfies Record<ExplainVerdict, string>;

/** A header naming the declaration and its policy label, then the actor/verdict/deciding table. */
function declarationLines(
  declaration: DeclarationExplanation,
  withInput: boolean,
): readonly string[] {
  const header = `  ${msg('cli.policy.declaration', {
    kind: declaration.kind,
    name: declaration.name,
    label: declaration.label,
  })}`;
  // Undecidable only on an input it was handed and threw on: the caveat instead of a table, never
  // a synthetic deny dressed as one. With no input a predicate that reads one is a `needs input`
  // row — "not decided", which a deny would misreport about an actor the request lets through.
  if (!declaration.decidable) return [header, `    ${msg('cli.policy.undecidableInput')}`];
  const rows = declaration.rows.map((row) => [
    row.actor,
    msg(VERDICT_KEYS[row.verdict]),
    row.deciding ?? msg('cli.policy.none'),
    row.reason ?? msg('cli.policy.none'),
  ]);
  const table = renderTable(['actor', 'verdict', 'deciding', 'reason'], rows).map(
    (line) => `  ${line}`,
  );
  return [
    header,
    ...table,
    `    ${msg(withInput ? 'cli.policy.withInput' : 'cli.policy.noInput')}`,
  ];
}

/**
 * `--input '<json>'`: the request's input, for a predicate that reads one. Any JSON value — the
 * action's own schema is not applied, because the question is what the POLICY decides on it.
 */
function readInput(ctx: CommandContext): ExplainOptions {
  const raw = ctx.args.flags.get('input');
  if (raw === undefined) return {};
  if (typeof raw !== 'string') {
    throw new BadFlagError({
      flag: 'input',
      command: 'policy explain',
      reason: 'it takes the request input as one JSON argument',
      fix: `x policy explain ${quoteArg(ctx.args.positionals)} --input '{}' --json`,
    });
  }
  try {
    return { input: { value: JSON.parse(raw) as unknown } };
  } catch {
    throw new BadFlagError({
      flag: 'input',
      command: 'policy explain',
      // The length, never the text: a request body pasted here may carry a credential.
      reason: `its value (${raw.length} characters) is not JSON`,
      fix: `x policy explain ${quoteArg(ctx.args.positionals)} --input '{"id":"<the request field>"}' --json`,
    });
  }
}

function requireSubject(ctx: CommandContext): string {
  const name = ctx.args.positionals[0];
  if (name === undefined) {
    // Never `BadFlagError`: its cause read `--subject on "x policy"`, and the next thing an agent
    // typed was `x policy explain --subject posts:read`, which is a second X_CLI_BAD_FLAG for a
    // flag this command does not declare. The positional is what is missing, so it is what is named.
    throw new MissingPositionalError({
      command: 'policy explain',
      positional: 'subject',
      example: 'x policy list --json',
    });
  }
  return name;
}

function runExplain(ctx: CommandContext, findings: readonly Finding[]): CommandResult {
  const name = requireSubject(ctx);
  const options = readInput(ctx);
  const explanation = explainPolicy(name, options);
  if (explanation === undefined) {
    const known = knownPolicySubjects();
    const suggestion = nearestName(name, known);
    throw new DeclarationUnknownError(
      suggestion === undefined
        ? { kind: 'policy', singular: 'policy subject', name, known, verb: 'explain' }
        : { kind: 'policy', singular: 'policy subject', name, known, suggestion, verb: 'explain' },
    );
  }
  // One row per (declaration, actor) pair — a permission two declarations enforce evaluates every
  // actor twice, so this counts evaluations and never roles.
  const rows = explanation.declarations.flatMap((declaration) => declaration.rows);
  const allowed = rows.filter((row) => row.verdict === 'allow').length;
  const pending = rows.filter((row) => row.verdict === 'needs-input').length;
  const counts = { subject: explanation.subject, allowed, evaluations: rows.length };
  const withInput = options.input !== undefined;
  return {
    ok: findings.length === 0,
    command: 'policy',
    // The command to run next is in the summary: a count of "not decided" with no way to decide
    // it is the dead end the bare "allowed for 0 of 3" was.
    summary:
      pending === 0
        ? msg('cli.policy.explained', counts)
        : msg('cli.policy.explainedPending', {
            ...counts,
            pending,
            command: `x policy explain ${quoteArg([name])} --input '<the request input as JSON>'`,
          }),
    lines: explanation.declarations.flatMap((declaration) =>
      declarationLines(declaration, withInput),
    ),
    findings,
    data: asJson({
      subject: explanation.subject,
      kind: explanation.kind,
      grantingRoles: explanation.grantingRoles,
      pending,
      declarations: explanation.declarations.map((declaration) => asJson(declaration)),
    }),
  };
}

export const policyCommand: CliCommand = {
  spec: policySpec,
  async run(ctx: CommandContext): Promise<CommandResult> {
    const root = requireAppRoot('policy', ctx.cwd).dir;
    const { findings } = await loadApp(root);
    const sub = ctx.args.subcommand ?? 'list';
    return sub === 'explain' ? runExplain(ctx, findings) : runList(findings);
  },
};
