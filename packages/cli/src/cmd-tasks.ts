// `x tasks [list|show <name>]` — introspect scheduled cron tasks: cadence, timezone, the jobs
// each enqueues, the occurrence the scheduler LAST dispatched (off the queue's own record) and
// real next-occurrence instants from `@ultimat3/time`'s cron math instead of an agent reading
// `0 3 * * *` and guessing. CLI wiring only; the pure computation lives in `tasks-facts.ts` — the
// same split `cmd-jobs.ts` makes against `jobs-report.ts`.

import { nearestName, systemClock } from '@ultimat3/core';
import type { JobDriver, TaskFire, TaskHandle } from '@ultimat3/jobs';
import type { CronPhrases } from '@ultimat3/time';
import { fromEpochMs, isoInZone } from '@ultimat3/time';
import { loadApp } from './app-load';
import { requireAppRoot } from './app-root';
import { tasksSpec } from './cmd-tasks-spec';
import type { CliCommand, CommandContext } from './command';
import { BadFlagError, DeclarationUnknownError } from './errors';
import { withJobDriver } from './jobs-driver';
import { msg } from './messages';
import type { CommandResult, Finding, JsonValue } from './output';
import { flagString } from './parse';
import { renderTable } from './table';
import {
  findTaskHandle,
  knownTaskNames,
  listTaskFacts,
  parseCountFlag,
  type TaskFact,
  taskShowFacts,
} from './tasks-facts';

const HEADER = ['name', 'cron', 'tz', 'catchUp', 'jobs', 'last', 'next'] as const;

/**
 * When a task last fired, flat beside `nextMs` / `next`. All three are `null` for a task the
 * scheduler has never dispatched — a key that is sometimes absent is a question asked two ways.
 */
interface LastFire {
  /** Epoch ms of the occurrence it was scheduled FOR — the instant `last` renders. */
  readonly lastMs: number | null;
  readonly last: string | null;
  /** Epoch ms the scheduler dispatched it, on the queue's clock. Later than `lastMs` by its lag. */
  readonly lastFiredAtMs: number | null;
}

const NEVER_FIRED: LastFire = { lastMs: null, last: null, lastFiredAtMs: null };

/**
 * The last occurrence each task DISPATCHED, by task name — `JobIntrospection.taskFires()`, never
 * the scheduler's watermark, which arming and skipping move too. A driver with no introspection
 * answers none, and every task then reads as never fired.
 */
async function lastFires(driver: JobDriver): Promise<ReadonlyMap<string, TaskFire>> {
  const fires = (await driver.introspect?.taskFires()) ?? [];
  return new Map(fires.map((fire) => [fire.task, fire]));
}

const lastFireOf = (fires: ReadonlyMap<string, TaskFire>, name: string, tz: string): LastFire => {
  const fire = fires.get(name);
  if (fire === undefined) return NEVER_FIRED;
  return {
    lastMs: fire.occurrenceMs,
    last: isoInZone(fromEpochMs(fire.occurrenceMs), tz),
    lastFiredAtMs: fire.firedAt,
  };
};

/**
 * The vocabulary `describeCron` interpolates. The cron *math* stays in `tasks-facts.ts` — it is
 * locale-neutral — but these are words `x tasks show` prints, so they come from the catalog like
 * every other rendered string. `msg()` leaves an un-supplied `{n}`/`{time}`/`{days}`/`{months}`
 * intact, which is what makes each value arrive as the template `describeCron` fills in.
 */
const cronPhrases = (): CronPhrases => ({
  everyMinute: msg('cli.cron.everyMinute'),
  everyNMinutes: msg('cli.cron.everyNMinutes'),
  everyHour: msg('cli.cron.everyHour'),
  everyNHours: msg('cli.cron.everyNHours'),
  at: msg('cli.cron.at'),
  andMore: msg('cli.cron.andMore'),
  onDaysOfMonth: msg('cli.cron.onDaysOfMonth'),
  onWeekdays: msg('cli.cron.onWeekdays'),
  inMonths: msg('cli.cron.inMonths'),
  everyDay: msg('cli.cron.everyDay'),
});

/** A descriptor/fact is plain JSON by construction — same idiom as `cmd-registries.ts`'s `asJson`. */
const asJson = (value: object): Record<string, JsonValue> => value as Record<string, JsonValue>;

const formatValue = (value: JsonValue): string =>
  typeof value === 'string' ? value : JSON.stringify(value);

/** One `key: value` line per top-level field — same idiom as `cmd-registries.ts`'s `detailLines`. */
const detailLines = (payload: Readonly<Record<string, JsonValue>>): readonly string[] =>
  Object.entries(payload).map(([key, value]) => `  ${key}: ${formatValue(value)}`);

const jobsCell = (jobs: readonly string[]): string => (jobs.length === 0 ? '-' : jobs.join(','));

const row = (fact: TaskFact & LastFire): readonly string[] => [
  fact.name,
  fact.cron,
  fact.tz,
  fact.catchUp,
  jobsCell(fact.jobs),
  fact.last ?? '-',
  fact.next,
];

function runList(
  nowMs: number,
  fires: ReadonlyMap<string, TaskFire>,
  findings: readonly Finding[],
): CommandResult {
  const facts = listTaskFacts(nowMs).map((fact) => ({
    ...fact,
    ...lastFireOf(fires, fact.name, fact.tz),
  }));
  return {
    ok: findings.length === 0,
    command: 'tasks',
    summary: msg('cli.tasks.count', { count: facts.length }),
    lines: facts.length === 0 ? [] : renderTable(HEADER, facts.map(row)).map((line) => `  ${line}`),
    findings,
    data: facts.map((fact) => asJson(fact)),
  };
}

/** Resolves the `show <name>` positional to a handle, or throws — the two failure paths named
 * in the brief: no positional at all, and a positional that names no registered task. */
function requireHandle(ctx: CommandContext): TaskHandle {
  const name = ctx.args.positionals[0];
  if (name === undefined) {
    throw new BadFlagError({
      flag: 'name',
      command: 'tasks',
      reason: 'x tasks show <name> needs a task name',
      fix: 'x tasks list --json',
    });
  }
  const handle = findTaskHandle(name);
  if (handle !== undefined) return handle;
  const known = knownTaskNames();
  const suggestion = nearestName(name, known);
  throw new DeclarationUnknownError(
    suggestion === undefined
      ? { kind: 'tasks', singular: 'task', name, known, verb: 'show' }
      : { kind: 'tasks', singular: 'task', name, known, suggestion, verb: 'show' },
  );
}

function runShow(
  shown: { readonly handle: TaskHandle; readonly count: number },
  nowMs: number,
  fires: ReadonlyMap<string, TaskFire>,
  findings: readonly Finding[],
): CommandResult {
  const { descriptor, describe, upcoming } = taskShowFacts(
    shown.handle,
    nowMs,
    shown.count,
    cronPhrases(),
  );
  const first = upcoming[0];
  const fired = lastFireOf(fires, descriptor.name, descriptor.tz);
  const lines = [
    ...detailLines(asJson(descriptor)),
    `  last: ${fired.last ?? '-'}`,
    `  ${describe}`,
    ...upcoming.map((occurrence) => `    ${occurrence.at}`),
  ];
  return {
    ok: findings.length === 0,
    command: 'tasks',
    summary: msg('cli.tasks.shown', {
      name: descriptor.name,
      cron: descriptor.cron,
      tz: descriptor.tz,
      next: first === undefined ? '' : first.at,
    }),
    lines,
    findings,
    data: {
      ...asJson(descriptor),
      ...fired,
      describe,
      upcoming: upcoming.map((occurrence) => asJson(occurrence)),
    },
  };
}

export const tasksCommand: CliCommand = {
  spec: tasksSpec,
  async run(ctx: CommandContext): Promise<CommandResult> {
    const root = requireAppRoot('tasks', ctx.cwd).dir;
    const { findings } = await loadApp(root);
    const nowMs = systemClock.now().getTime();
    // Everything argv can get wrong is refused BEFORE the queue is opened: a typo in a task name
    // must not cost a database boot to be told about.
    const shown =
      ctx.args.subcommand === 'show'
        ? { handle: requireHandle(ctx), count: parseCountFlag(flagString(ctx.args, 'count')) }
        : undefined;
    // Nothing to join a fire to: an app that declares no task never pays for a queue.
    if (shown === undefined && knownTaskNames().length === 0) {
      return runList(nowMs, new Map(), findings);
    }
    return withJobDriver(root, ctx, async (driver) => {
      const fires = await lastFires(driver);
      return shown === undefined
        ? runList(nowMs, fires, findings)
        : runShow(shown, nowMs, fires, findings);
    });
  },
};
