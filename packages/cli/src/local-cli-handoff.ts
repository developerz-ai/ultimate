// Running the app's own CLI in place of this one (`local-cli.ts` decides WHETHER). The parent only
// waits, so every stop signal it receives is the child's to act on: a supervisor or a closing
// terminal signals the pid it started, and that pid is this one.

/**
 * The stop signals forwarded to the child. SIGINT is NOT one of them: Ctrl-C reaches the whole
 * foreground process group, so the child already has it, and a second one landed inside its
 * cleanup — `x secrets edit` died mid-shred with its decrypted buffer still on disk.
 */
export const HAND_OFF_SIGNALS = ['SIGTERM', 'SIGHUP'] as const;
export type HandOffSignal = (typeof HAND_OFF_SIGNALS)[number];

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

/**
 * Spawns `command`, forwards SIGTERM and SIGHUP to it for as long as it runs, and answers
 * its exit code — `128 + n` when a signal ended it, as `Bun.spawn`'s `exited` reports.
 *
 * Without the listeners the default action ran: the parent died on the signal and the child —
 * an `x dev` holding a port and an embedded Postgres, an `x db migrate` mid-transaction — ran on
 * as an orphan nothing would stop. A listener is also what keeps the parent alive to report the
 * child's own exit code, rather than 143 before the child had drained.
 */
export async function handOff(
  command: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
  spawn: typeof spawnInherited = spawnInherited,
): Promise<number> {
  const child = spawn(command, env);
  const forwards = HAND_OFF_SIGNALS.map((signal) => {
    const forward = (): void => child.kill(signal);
    process.on(signal, forward);
    return () => process.off(signal, forward);
  });
  // Held, not forwarded: without a listener the default action kills this parent at once, the
  // prompt returns over a child still draining, and the exit code is 130 instead of the child's.
  const holdInterrupt = (): void => undefined;
  process.on('SIGINT', holdInterrupt);
  try {
    return await child.exited;
  } finally {
    for (const release of forwards) release();
    process.off('SIGINT', holdInterrupt);
  }
}
