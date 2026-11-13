// `x explain <query> [--input '<json>']` — one declared query run once on the app's dev database,
// every statement it sent captured (`explain-capture.ts`) and planned by `sweepPlans`, the plan
// oracle the `exercise` gate step judges with: one verdict, two callers. The rows are discarded.

import {
  ctxOf,
  isUltimateError,
  nearestName,
  renderFixShellArg,
  runWithContext,
  serviceActor,
} from '@ultimat3/core';
import type { DbClient } from '@ultimat3/db';
import type { AnyQuery } from '@ultimat3/query';
import { getQuery, listQueries, queryName, sourceFor } from '@ultimat3/query';
import type { ExerciseRecord, PlanProof, SeedEntity, SentStatement } from '@ultimat3/testing';
import { planSweepFindings, sweepPlans } from '@ultimat3/testing';
import { loadApp } from './app-load';
import { requireAppRoot } from './app-root';
import { explainSpec } from './cmd-explain-spec';
import type { CliCommand, CommandContext } from './command';
import { registeredEntityCores } from './db-seed-generate';
import { BadFlagError, DeclarationUnknownError, MissingPositionalError } from './errors';
import { captureStatements } from './explain-capture';
import { msg } from './messages';
import type { CommandResult, Finding, JsonValue } from './output';
import { flagString } from './parse';
import { openAppQueue } from './runtime-boot-ports';

/** The dev database, open for one run and ALWAYS released (the PGlite lock). */
export interface OpenPlanDb {
  readonly db: DbClient;
  close(): Promise<void>;
}

export type OpenDb = (root: string, ctx: CommandContext) => Promise<OpenPlanDb>;

/** `openAppQueue` installs the ambient `db()` the query's repositories read through. */
const openDevDb: OpenDb = async (root, ctx) => {
  const queue = await openAppQueue(root, ctx.env);
  return { db: queue.db, close: () => queue.stop() };
};

/** `--input`, as JSON: the query's own schema judges the shape, this only the syntax. */
function readInput(ctx: CommandContext, name: string): unknown {
  const raw = flagString(ctx.args, 'input');
  if (raw === undefined) return {};
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new BadFlagError({
      flag: 'input',
      command: 'explain',
      reason: 'is not JSON',
      fix: `x explain ${renderFixShellArg(name, '<query>')} --input '{}' --json`,
    });
  }
}

function resolveQuery(name: string): AnyQuery {
  const found = getQuery(name);
  if (found !== undefined) return found;
  const known = listQueries().map(queryName);
  const suggestion = nearestName(name, known);
  throw new DeclarationUnknownError({
    kind: 'queries',
    singular: 'query',
    name,
    known,
    ...(suggestion === undefined ? {} : { suggestion }),
  });
}

/**
 * The query's statements, sent for real. Its policy is NOT asked — `explainQuery`'s rule: this is
 * an operator command on the dev database, and what it prints is SQL and plans, never a row.
 */
const runOnce = (target: AnyQuery, name: string, input: unknown, org: string | undefined) =>
  captureStatements(name, () =>
    runWithContext(
      // A service actor, in the tenant `--org` names: the statement a tenant-scoped read sends
      // carries its tenant predicate, and that predicate is part of what the plan is judged on.
      ctxOf({
        actor: serviceActor({ id: 'x-explain', ...(org === undefined ? {} : { orgId: org }) }),
      }),
      async () => {
        const source = await sourceFor(target, input, {
          unenforced: 'x explain plans the statements of one read and prints no row of it',
        });
        await source.execute();
      },
    ),
  ).catch((error: unknown) => {
    // The tenancy refusal's own fix names code; from this command, the flag is the answer.
    if (!isUltimateError(error) || error.code !== 'X_TENANCY_ACTOR_ORG_REQUIRED') throw error;
    throw new BadFlagError({
      flag: 'org',
      command: 'explain',
      reason: `${name} reads a tenant-scoped entity, and a plan without the tenant predicate is not the plan production runs`,
      fix: `x explain ${renderFixShellArg(name, '<query>')} --org <org-id> --json`,
    });
  });

/** The proof as the exercise report carries it, so its findings are the gate's own text. */
const asRecord = (name: string, plans: PlanProof): ExerciseRecord => ({
  kind: 'query',
  name,
  outcome: 'reached',
  statements: plans.planned,
  effects: [],
  ms: 0,
  plans,
});

const listed = (entries: PlanProof['exempt']): JsonValue =>
  entries.map((entry) => ({ statement: entry.statement, reason: entry.reason }));

function summaryOf(name: string, proof: PlanProof, sent: number, red: number): string {
  if (sent === 0) return msg('cli.explain.none', { query: name });
  if (proof.unplannable.length > 0) return msg('cli.explain.unplannable', { query: name });
  return red === 0
    ? msg('cli.explain.served', { query: name, planned: proof.planned })
    : msg('cli.explain.red', { query: name, count: red });
}

/** `open` is the seam a test hands a database through; the shipped command opens the dev one. */
export const explainCommandOver = (open: OpenDb): CliCommand => ({
  spec: explainSpec,
  async run(ctx: CommandContext): Promise<CommandResult> {
    const root = requireAppRoot('explain', ctx.cwd).dir;
    const name = ctx.args.positionals[0];
    if (name === undefined) {
      throw new MissingPositionalError({
        command: 'explain',
        positional: 'query',
        example: 'x queries list --json   # then x explain <query> --json',
      });
    }
    const input = readInput(ctx, name);
    const org = flagString(ctx.args, 'org');
    const loaded = await loadApp(root);
    const target = resolveQuery(name);
    const entities: readonly SeedEntity[] = Object.values(registeredEntityCores());
    const handle = await open(root, ctx);
    let sent: ReadonlyMap<string, SentStatement> = new Map();
    let proofs: ReadonlyMap<string, PlanProof> = new Map();
    try {
      sent = (await runOnce(target, name, input, org)).sent;
      proofs = await sweepPlans(handle.db, sent, entities);
    } finally {
      await handle.close();
    }
    const proof = proofs.get(name) ?? { planned: 0, findings: [], exempt: [], unplannable: [] };
    const verdicts: readonly Finding[] = planSweepFindings([asRecord(name, proof)]);
    const findings = [...loaded.findings, ...verdicts];
    const statements = [...sent.keys()];
    return {
      ok: findings.length === 0,
      command: 'explain',
      summary: summaryOf(name, proof, statements.length, verdicts.length),
      findings,
      lines: [
        ...statements.map((statement) => `  ${statement}`),
        ...proof.exempt.map((entry) => msg('cli.explain.exempt', { reason: entry.reason })),
        ...proof.unplannable.map((entry) => msg('cli.explain.refused', { reason: entry.reason })),
      ],
      data: {
        query: name,
        statements,
        planned: proof.planned,
        exempt: listed(proof.exempt),
        unplannable: listed(proof.unplannable),
      },
    };
  },
});

export const explainCommand: CliCommand = explainCommandOver(openDevDb);
