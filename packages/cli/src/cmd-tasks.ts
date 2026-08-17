// `x tasks [list|show <name>]` — introspect scheduled cron tasks: cadence, timezone, the jobs
// each enqueues, and real next-occurrence instants from `@ultimat3/time`'s cron math instead of
// an agent reading `0 3 * * *` and guessing. CLI wiring only; the pure computation lives in
// `tasks-facts.ts` — the same split `cmd-jobs.ts` makes against `jobs-report.ts`.

import { systemClock } from '@ultimat3/core';
import type { TaskHandle } from '@ultimat3/jobs';
import type { CronPhrases } from '@ultimat3/time';
import { loadApp } from './app-load';
import { requireAppRoot } from './app-root';
import type { CliCommand, CommandContext } from './command';
import { BadFlagError, DeclarationUnknownError } from './errors';
import { msg } from './messages';
import type { CommandResult, Finding, JsonValue } from './output';
import { flagString, nearest } from './parse';
import { renderTable } from './table';
import {
  findTaskHandle,
  knownTaskNames,
  listTaskFacts,
  parseCountFlag,
  type TaskFact,
  taskShowFacts,
} from './tasks-facts';

const HEADER = ['name', 'cron', 'tz', 'catchUp', 'jobs', 'next'] as const;

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

const row = (fact: TaskFact): readonly string[] => [
  fact.name,
  fact.cron,
  fact.tz,
  fact.catchUp,
  jobsCell(fact.jobs),
  fact.next,
];

function runList(nowMs: number, findings: readonly Finding[]): CommandResult {
  const facts = listTaskFacts(nowMs);
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
  const suggestion = nearest(name, known);
  throw new DeclarationUnknownError(
    suggestion === undefined
      ? { kind: 'tasks', singular: 'task', name, known, verb: 'show' }
      : { kind: 'tasks', singular: 'task', name, known, suggestion, verb: 'show' },
  );
}

function runShow(ctx: CommandContext, nowMs: number, findings: readonly Finding[]): CommandResult {
  const handle = requireHandle(ctx);
  const count = parseCountFlag(flagString(ctx.args, 'count'));
  const { descriptor, describe, upcoming } = taskShowFacts(handle, nowMs, count, cronPhrases());
  const first = upcoming[0];
  const lines = [
    ...detailLines(asJson(descriptor)),
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
      describe,
      upcoming: upcoming.map((occurrence) => asJson(occurrence)),
    },
  };
}

export const tasksCommand: CliCommand = {
  spec: {
    name: 'tasks',
    summary: 'cron tasks, their timezone and their next run',
    usage: 'x tasks [list|show <name>] [--count n] [--json]',
    requiresApp: true,
    subcommands: ['list', 'show'],
    defaultSubcommand: 'list',
    flags: [
      { name: 'count', type: 'string', summary: 'show: how many upcoming occurrences to list' },
    ],
  },
  async run(ctx: CommandContext): Promise<CommandResult> {
    const root = requireAppRoot('tasks', ctx.cwd).dir;
    const { findings } = await loadApp(root);
    const nowMs = systemClock.now().getTime();
    return ctx.args.subcommand === 'show'
      ? runShow(ctx, nowMs, findings)
      : runList(nowMs, findings);
  },
};
