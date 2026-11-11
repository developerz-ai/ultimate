// `x drill [<name>] [--list] [--budget-ms n]` — the app's web and worker roles as real processes on
// real services, each fault in `@ultimat3/testing`'s drill table played through a proxy or a
// signal, red on any framework contract that does not hold. CLI wiring only: the table, the fleet
// and the verdict are testing's. Not a gate step: it needs Postgres, and `x verify` needs nothing.

import type { AppConfig } from '@ultimat3/core';
import { DRAIN_DEADLINE_DEFAULT_MS, MAX_TIMER_MS } from '@ultimat3/core';
import type {
  Drill,
  DrillConfig,
  DrillDeclarations,
  DrillFleet,
  DrillReport,
} from '@ultimat3/testing';
import {
  bunDrillSql,
  DRILL_NAMES,
  DRILLS,
  DrillFailedError,
  DrillServiceMissingError,
  drillBudgets,
  drillNamed,
  drillRoles,
  drillServices,
  runDrill,
  startDrillFleet,
} from '@ultimat3/testing';
import { loadAppConfig } from './app-config-load';
import { requireAppRoot } from './app-root';
import { drillSpec } from './cmd-drill-spec';
import type { CliCommand, CommandContext } from './command';
import { drillSyncLane } from './drill-sync-lane';
import { drillTargets } from './drill-targets';
import { UnknownCommandError } from './errors';
import { readIntFlag } from './flag-number';
import { msg } from './messages';
import type { CommandResult, Finding, JsonValue } from './output';
import { flagBool } from './parse';

/** Read through `readIntFlag`, which refuses `5s`, `NaN` and a fraction with the flag's name. */
const BUDGET_FLAG = 'budget-ms';

/** How long a role may take to boot: a cold Bun over a whole app, islands included. */
const READY_TIMEOUT_MS = 90_000;

/** `@ultimat3/http`'s own default — the app's `configureHttp` is runtime code, not config. */
const HTTP_DEFAULT_DEADLINE_MS = 30_000;

/**
 * What the app runs on. NATS is the environment's (v31: `realtime.transport` is gone, and
 * `NATS_URL` alone selects the bus), so an unset `NATS_URL` is an app with no bus to fault.
 */
const declarationsOf = (
  config: AppConfig | undefined,
  env: Readonly<Record<string, string | undefined>>,
): DrillDeclarations => ({
  redis: config?.cache.tiers.includes('redis') ?? false,
  nats: (env['NATS_URL']?.trim() ?? '') === '' ? undefined : { env: 'NATS_URL' },
});

/** The facts the thresholds derive from; `drillBudgets` screens every number it is handed. */
const drillConfigOf = (config: AppConfig | undefined): DrillConfig =>
  config === undefined
    ? {
        requestTimeoutMs: HTTP_DEFAULT_DEADLINE_MS,
        drainDeadlineMs: DRAIN_DEADLINE_DEFAULT_MS,
        readinessGraceMs: 0,
        readiness: 'dependencies',
      }
    : {
        requestTimeoutMs: HTTP_DEFAULT_DEADLINE_MS,
        drainDeadlineMs: config.drain.deadlineMs,
        readinessGraceMs: config.drain.readinessGraceMs,
        readiness: config.health.readiness,
      };

const listing = (drill: Drill): JsonValue => ({
  name: drill.name,
  fault:
    drill.fault.kind === 'service'
      ? { service: drill.fault.service }
      : { role: drill.fault.role, signal: drill.fault.signal },
  holds: [...drill.holds],
});

const reportJson = (report: DrillReport): JsonValue =>
  JSON.parse(
    JSON.stringify(report, (_key, value: unknown) =>
      value instanceof Map ? Object.fromEntries(value) : value,
    ),
  ) as JsonValue;

const findingsOf = (report: DrillReport): readonly Finding[] =>
  report.verdict.failures.map((failure) => {
    const error = new DrillFailedError({ drill: report.name, failure });
    return { code: error.code, cause: error.cause, fix: error.fix };
  });

/** The evidence connection: `bunDrillSql`'s shape, a seam so a test can make it throw. */
type DrillSqlConnection = ReturnType<typeof bunDrillSql>;

/**
 * One drill's body over a started fleet, which is ALWAYS stopped. The fleet is spawned role
 * processes: the connection was opened before the `try`, so a constructor that threw (a malformed
 * URL is a synchronous `Invalid URL`) left every role running, and a `close()` that threw skipped
 * `stop()` the same way.
 */
export async function withDrillFleet<T>(
  fleet: Pick<DrillFleet, 'databaseUrl' | 'stop'>,
  open: (url: string) => DrillSqlConnection,
  body: (sql: DrillSqlConnection) => Promise<T>,
): Promise<T> {
  let sql: DrillSqlConnection | undefined;
  try {
    sql = open(fleet.databaseUrl);
    return await body(sql);
  } finally {
    try {
      await sql?.close();
    } finally {
      await fleet.stop();
    }
  }
}

export const drillCommand: CliCommand = {
  spec: drillSpec,
  async run(ctx: CommandContext): Promise<CommandResult> {
    const root = requireAppRoot('drill', ctx.cwd).dir;
    if (flagBool(ctx.args, 'list')) {
      return {
        ok: true,
        command: 'drill',
        summary: msg('cli.drill.listed', { count: DRILLS.length }),
        lines: DRILLS.map((drill) => `  ${drill.name}  ${drill.holds.join(', ')}`),
        data: { drills: DRILLS.map(listing) },
      };
    }
    const override = readIntFlag(ctx.args, {
      name: BUDGET_FLAG,
      command: 'drill',
      min: 1,
      max: MAX_TIMER_MS,
      example: 'x drill pg-blackhole --budget-ms 5000 --json',
    });
    const name = ctx.args.positionals[0];
    const named = name === undefined ? undefined : drillNamed(name);
    if (name !== undefined && named === undefined) {
      throw new UnknownCommandError({
        path: `drill ${name}`,
        known: DRILL_NAMES,
        suggestion: 'drill --list --json',
      });
    }
    const config = await loadAppConfig(root);
    const declared = declarationsOf(config, ctx.env);
    // Every drill's services, decided before any process starts. A named drill's gap is thrown; in
    // a whole run an undeclared service is stated as not run — an unset URL still refuses it all.
    const planned: { drill: Drill; services: ReturnType<typeof drillServices> }[] = [];
    const notRun: string[] = [];
    for (const drill of named === undefined ? DRILLS : [named]) {
      try {
        planned.push({ drill, services: drillServices(drill, ctx.env, declared) });
      } catch (error) {
        const undeclared =
          named === undefined &&
          error instanceof DrillServiceMissingError &&
          error.meta?.['gap'] === 'undeclared';
        if (!undeclared) throw error;
        notRun.push(drill.name);
      }
    }
    const budgets = drillBudgets(drillConfigOf(config), override);
    const { targets, skipped } = await drillTargets(root);
    const reports: DrillReport[] = [];
    for (const { drill, services } of planned) {
      const fleet = await startDrillFleet({
        root,
        services,
        roles: drillRoles(drill),
        readyTimeoutMs: READY_TIMEOUT_MS,
      });
      reports.push(
        await withDrillFleet(fleet, bunDrillSql, (sql) =>
          runDrill({ drill, fleet, budgets, targets, sql, sync: drillSyncLane(fleet) }),
        ),
      );
    }
    const held = reports.filter((report) => report.verdict.ok).length;
    const findings = reports.flatMap(findingsOf);
    return {
      ok: findings.length === 0 && held === reports.length,
      command: 'drill',
      summary: msg('cli.drill.summary', { held, ran: reports.length, notRun: notRun.length }),
      lines: [
        ...reports.map((report) => `  ${report.verdict.ok ? 'held' : 'FAILED'}  ${report.name}`),
        ...notRun.map((drill) => `  not run  ${drill}`),
      ],
      findings,
      data: {
        budgets: { ...budgets, override: override ?? null },
        targets: targets.map((target) => `${target.method} ${target.path}`),
        // The actions the write lane left out, each with why: an empty lane is never a silent one.
        skippedWrites: skipped.map((entry) => ({ ...entry })),
        drills: reports.map(reportJson),
        notRun,
      },
    };
  },
};
