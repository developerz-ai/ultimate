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
  values.length === 0 ? '-' : values.join(',');

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
  const header = `  ${declaration.kind} ${declaration.name} — policy ${declaration.label}`;
  const rows = declaration.rows.map((row) => [
    row.actor,
    row.allowed ? 'allow' : 'deny',
    row.deciding ?? '-',
    row.reason ?? '-',
  ]);
  const table = renderTable(['actor', 'verdict', 'deciding', 'reason'], rows).map(
    (line) => `  ${line}`,
  );
  return [header, ...table];
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
  const rows = explanation.declarations.flatMap((declaration) => declaration.rows);
  const allowed = rows.filter((row) => row.allowed).length;
  return {
    ok: findings.length === 0,
    command: 'policy',
    summary: msg('cli.policy.explained', {
      subject: explanation.subject,
      allowed,
      roles: rows.length,
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
  },
  async run(ctx: CommandContext): Promise<CommandResult> {
    const root = requireAppRoot('policy', ctx.cwd).dir;
    const { findings } = await loadApp(root);
    const sub = ctx.args.subcommand ?? 'list';
    return sub === 'explain' ? runExplain(ctx, findings) : runList(findings);
  },
};
