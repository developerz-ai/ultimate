// `x heavy`: the machine ledger as a command. `status` is a read that changes nothing; `run` puts any
// command inside one reservation, passes its exit code through and forwards stop signals, which is
// how a repository with no Ultimate in it shares the same queue.

// why: Bun exposes no load average, core count or total-memory primitive.
import { availableParallelism, loadavg, totalmem } from 'node:os';
import { heavySpec } from './cmd-heavy-spec';
import type { CliCommand, CommandContext } from './command';
import { MissingPositionalError } from './errors';
import { readIntFlag } from './flag-number';
import { describeEntry, heavyState, withHeavy } from './heavy';
import { coreCap, runnableTasks } from './heavy-cores';
import { HeavyCommandNotFoundError } from './heavy-errors';
import { readLedger } from './heavy-ledger';
import { availableMemoryBytes, usableMemoryBytes } from './heavy-memory';
import { DEFAULT_RUN_MB } from './heavy-weights';
import type { HandOffChild } from './local-cli-handoff';
import { handOff } from './local-cli-handoff';
import { msg } from './messages';
import type { CommandResult, JsonValue } from './output';
import { findingFrom } from './output';
import { flagString } from './parse';

const gb = (bytes: number): string => (bytes / 2 ** 30).toFixed(1);
const MAX_RUN_MB = 1024 * 1024;

async function status(ctx: CommandContext): Promise<CommandResult> {
  const state = await heavyState({ ...ctx.env, ULTIMATE_HEAVY_HOLD: undefined });
  const now = Date.now();
  const view = state.on ? readLedger(state.dir, state.tryLock) : { holds: [], queue: [] };
  const cores = coreCap(ctx.env);
  const coreText = cores === undefined ? String(availableParallelism()) : String(cores);
  const usedMb = view.holds.reduce((sum, entry) => sum + entry.mb, 0);
  const [one = 0, five = 0, fifteen = 0] = loadavg();
  const machine = {
    cores: availableParallelism(),
    runnable: runnableTasks(),
    load: { one, five, fifteen },
    totalBytes: usableMemoryBytes(totalmem()),
    availableBytes: availableMemoryBytes(),
  };
  const entryJson = (entry: (typeof view.holds)[number]): JsonValue => ({
    pid: entry.pid,
    mb: entry.mb,
    label: entry.label,
    cwd: entry.cwd,
    ageMs: Math.max(0, now - entry.at),
  });
  return {
    ok: true,
    command: 'heavy',
    summary: state.on
      ? msg('cli.heavy.status.summary', {
          used: usedMb,
          capacity: state.capacityMb,
          holds: view.holds.length,
          queued: view.queue.length,
          cores: coreText,
        })
      : msg('cli.heavy.status.off', { reason: state.detail ?? state.off, cores: coreText }),
    lines: [
      msg('cli.heavy.status.machine', {
        load: one.toFixed(1),
        cpus: machine.cores,
        runnable: machine.runnable,
        free: gb(machine.availableBytes),
        total: gb(machine.totalBytes),
      }),
      ...view.holds.map((entry) =>
        msg('cli.heavy.status.hold', { entry: describeEntry(entry, now) }),
      ),
      ...view.queue.map((entry, at) =>
        msg('cli.heavy.status.queued', { position: at + 1, entry: describeEntry(entry, now) }),
      ),
    ],
    data: {
      enabled: state.on,
      ...(state.on
        ? { dir: state.dir, capacityMb: state.capacityMb, usedMb }
        : { off: state.off, ...(state.detail === undefined ? {} : { detail: state.detail }) }),
      coreCap: cores ?? null,
      machine,
      holds: view.holds.map(entryJson),
      queue: view.queue.map(entryJson),
    },
  };
}

const seconds = (ms: number): string => `${(ms / 1000).toFixed(1)}s`;

async function run(ctx: CommandContext): Promise<CommandResult> {
  const command = ctx.args.passthrough;
  const first = command[0];
  if (first === undefined || ctx.args.positionals.length > 0) {
    throw new MissingPositionalError({
      command: 'heavy run',
      positional: '-- command',
      example: 'x heavy run --label tests -- bun test',
    });
  }
  // Under `--json` fd 1 is this command's one document, so the child's stdout moves to fd 2.
  const stream = ctx.args.json ? undefined : ('stderr' as const);
  const envelope = { command: 'heavy', ...(stream === undefined ? {} : { stream }) };
  const path = ctx.env['PATH'];
  if (Bun.which(first, { cwd: ctx.cwd, ...(path === undefined ? {} : { PATH: path }) }) === null) {
    const finding = findingFrom(new HeavyCommandNotFoundError(first));
    return { ...envelope, ok: false, summary: finding.cause, findings: [finding], exitCode: 127 };
  }
  const mb = readIntFlag(ctx.args, {
    name: 'mb',
    command: 'heavy',
    min: 1,
    max: MAX_RUN_MB,
    example: 'x heavy run --mb 4096 -- bun test',
  });
  const label = flagString(ctx.args, 'label') ?? command.slice(0, 3).join(' ');
  const queued = performance.now();
  let startedAt = queued;
  const code = await withHeavy(
    { label, cwd: ctx.cwd, env: ctx.env, unitMb: mb ?? DEFAULT_RUN_MB },
    (child) => {
      startedAt = performance.now();
      return handOff(
        command,
        { ...ctx.env, ...child.env },
        {
          spawn: (argv, env): HandOffChild =>
            // Untimed: the child is the command the caller asked to run, and its stop signals are
            // forwarded by `handOff`. Counted under `cli`'s spawn-timeout pin with that hand-off.
            Bun.spawn([...argv], {
              cwd: ctx.cwd,
              env,
              // The reservation's lock goes with it: killing this wrapper frees nothing the
              // command is still using.
              stdio: ['inherit', ctx.args.json ? 2 : 'inherit', 'inherit', ...child.fds],
            }),
        },
      );
    },
  );
  const ranMs = performance.now() - startedAt;
  const waitedMs = startedAt - queued;
  return {
    ...envelope,
    ok: code === 0,
    summary: msg('cli.heavy.run.done', {
      command: label,
      code,
      ran: seconds(ranMs),
      waited: seconds(waitedMs),
    }),
    exitCode: code,
    data: { exitCode: code, ranMs: Math.round(ranMs), waitedMs: Math.round(waitedMs) },
  };
}

export const heavyCommand: CliCommand = {
  spec: heavySpec,
  run: (ctx) => (ctx.args.subcommand === 'run' ? run(ctx) : status(ctx)),
};
