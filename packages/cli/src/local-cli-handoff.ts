// Running the app's own CLI in place of this one (`local-cli.ts` decides WHETHER). The parent only
// waits, so every stop signal it receives is the child's to act on: a supervisor or a closing
// terminal signals the pid it started, and that pid is this one. `bin.ts` exits with the answer.

/**
 * The stop signals forwarded to the child at once. SIGINT is NOT one of them: Ctrl-C reaches the
 * whole foreground process group, so the child already has it, and a second one landed inside its
 * cleanup — `x secrets edit` died mid-shred with its decrypted buffer still on disk (audit M1).
 */
export const HAND_OFF_SIGNALS = ['SIGTERM', 'SIGHUP'] as const;
export type HandOffSignal = (typeof HAND_OFF_SIGNALS)[number] | 'SIGINT';

/**
 * How long a SIGINT is held before it is forwarded. A Ctrl-C the group delivered ends the child
 * well inside it — a shred is milliseconds — so it is never sent twice; a SIGINT aimed at this pid
 * alone (`kill -INT`, a runtime whose STOPSIGNAL is SIGINT) reaches the child a second later
 * instead of never. A child still draining past it gets one more SIGINT, which every drain here
 * already absorbs (`signal-shred.ts` ignores repeats; `x dev`'s stop is armed once).
 */
export const INTERRUPT_GRACE_MS = 1000;

/** Arms `fire` after `ms`, answering its cancel. Injected by the test, so no verdict waits on a clock. */
export type Schedule = (fire: () => void, ms: number) => () => void;

/** The spawned CLI as the hand-off sees it — `Bun.spawn`'s answer, narrowed so a test can fake it. */
export interface HandOffChild {
  readonly exited: Promise<number>;
  kill(signal: HandOffSignal): void;
}

// Untimed by design, and counted under `cli`'s pin in `scripts/lib/spawn-timeout-pins.ts`: the
// child IS the command the user typed (`x dev` serves until Ctrl-C), so its lifetime is theirs, and
// the forwarded stop signals below are what end it.
const spawnInherited = (
  command: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
): HandOffChild =>
  Bun.spawn([...command], { stdin: 'inherit', stdout: 'inherit', stderr: 'inherit', env });

const scheduleTimer: Schedule = (fire, ms) => {
  const timer = setTimeout(fire, ms);
  return () => clearTimeout(timer);
};

export interface HandOffOptions {
  readonly spawn?: typeof spawnInherited;
  readonly schedule?: Schedule;
}

/**
 * Spawns `command`, forwards SIGTERM and SIGHUP to it for as long as it runs — SIGINT only once the
 * grace passes with the child still running — and answers its exit code: `128 + n` when a signal
 * ended it, as `Bun.spawn`'s `exited` reports. `bin.ts` exits with that code.
 *
 * Without the listeners the default action ran: the parent died on the signal and the child —
 * an `x dev` holding a port and an embedded Postgres, an `x db migrate` mid-transaction — ran on
 * as an orphan nothing would stop. A listener is also what keeps the parent alive to report the
 * child's own exit code, rather than 143 before the child had drained.
 */
export async function handOff(
  command: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
  options: HandOffOptions = {},
): Promise<number> {
  const child = (options.spawn ?? spawnInherited)(command, env);
  const schedule = options.schedule ?? scheduleTimer;
  const forwards = HAND_OFF_SIGNALS.map((signal) => {
    const forward = (): void => child.kill(signal);
    process.on(signal, forward);
    return () => process.off(signal, forward);
  });
  // Whether the child already has this SIGINT is unknowable from here, so the grace decides: a
  // repeat inside one window arms nothing new — one Ctrl-C never becomes two forwarded signals.
  let cancelGrace: (() => void) | undefined;
  const holdInterrupt = (): void => {
    if (cancelGrace !== undefined) return;
    cancelGrace = schedule(() => {
      cancelGrace = undefined;
      child.kill('SIGINT');
    }, INTERRUPT_GRACE_MS);
  };
  process.on('SIGINT', holdInterrupt);
  try {
    return await child.exited;
  } finally {
    for (const release of forwards) release();
    process.off('SIGINT', holdInterrupt);
    cancelGrace?.();
  }
}
