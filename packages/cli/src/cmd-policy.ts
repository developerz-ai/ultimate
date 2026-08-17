// `x policy list|explain` — which clause decided a permission, and why. This file is CLI wiring
// only: the fact-gathering (registries, matrix rows) lives in `policy-facts.ts`, so the matrix
// logic is testable without an app — same split as `cmd-jobs.ts` / `jobs-report.ts`.

import { loadApp } from './app-load';
import { requireAppRoot } from './app-root';
import type { CliCommand, CommandContext } from './command';
import { BadFlagError, DeclarationUnknownError } from './errors';
import { msg } from './messages';
import type { CommandResult, Finding, JsonValue } from './output';
import { nearest } from './parse';
import type { DeclarationExplanation } from './policy-facts';
import { explainPolicy, knownPolicySubjects, listPolicy } from './policy-facts';
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

/** A header naming the declaration and its policy label, then the actor/verdict/deciding table. */
function declarationLines(declaration: DeclarationExplanation): readonly string[] {
  const header = `  ${msg('cli.policy.declaration', {
    kind: declaration.kind,
    name: declaration.name,
    label: declaration.label,
  })}`;
  // Both notes say the same thing `dev-policy.ts` writes into the `/_x` trace: this ran outside a
  // request. A policy that merely reads input gets its table plus the caveat; one that cannot be
  // evaluated at all gets the caveat instead of a table, never a synthetic deny dressed as one.
  if (!declaration.decidable) return [header, `    ${msg('cli.policy.undecidable')}`];
  const rows = declaration.rows.map((row) => [
    row.actor,
    msg(row.allowed ? 'cli.policy.allow' : 'cli.policy.deny'),
    row.deciding ?? msg('cli.policy.none'),
    row.reason ?? msg('cli.policy.none'),
  ]);
  const table = renderTable(['actor', 'verdict', 'deciding', 'reason'], rows).map(
    (line) => `  ${line}`,
  );
  return [header, ...table, `    ${msg('cli.policy.noInput')}`];
}

function requireSubject(ctx: CommandContext): string {
  const name = ctx.args.positionals[0];
  if (name === undefined) {
    throw new BadFlagError({
      flag: 'subject',
      command: 'policy',
      reason: 'x policy explain <subject> needs a permission, action, query or route path',
      fix: 'x policy list --json',
    });
  }
  return name;
}

function runExplain(ctx: CommandContext, findings: readonly Finding[]): CommandResult {
  const name = requireSubject(ctx);
  const explanation = explainPolicy(name);
  if (explanation === undefined) {
    const known = knownPolicySubjects();
    const suggestion = nearest(name, known);
    throw new DeclarationUnknownError(
      suggestion === undefined
        ? { kind: 'policy', singular: 'policy subject', name, known, verb: 'explain' }
        : { kind: 'policy', singular: 'policy subject', name, known, suggestion, verb: 'explain' },
    );
  }
  // One row per (declaration, actor) pair — a permission two declarations enforce evaluates every
  // actor twice, so this counts evaluations and never roles.
  const rows = explanation.declarations.flatMap((declaration) => declaration.rows);
  const allowed = rows.filter((row) => row.allowed).length;
  return {
    ok: findings.length === 0,
    command: 'policy',
    summary: msg('cli.policy.explained', {
      subject: explanation.subject,
      allowed,
      evaluations: rows.length,
    }),
    lines: explanation.declarations.flatMap(declarationLines),
    findings,
    data: asJson({
      subject: explanation.subject,
      kind: explanation.kind,
      grantingRoles: explanation.grantingRoles,
      declarations: explanation.declarations.map((declaration) => asJson(declaration)),
    }),
  };
}

export const policyCommand: CliCommand = {
  spec: {
    name: 'policy',
    summary: 'which clause decided a permission, and why',
    usage: 'x policy [list|explain <subject>] [--json]',
    requiresApp: true,
    subcommands: ['list', 'explain'],
    defaultSubcommand: 'list',
  },
  async run(ctx: CommandContext): Promise<CommandResult> {
    const root = requireAppRoot('policy', ctx.cwd).dir;
    const { findings } = await loadApp(root);
    const sub = ctx.args.subcommand ?? 'list';
    return sub === 'explain' ? runExplain(ctx, findings) : runList(findings);
  },
};
