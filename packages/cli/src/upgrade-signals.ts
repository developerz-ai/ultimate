// A stopped `x upgrade` stops what it started. Every child carries the hop's tag in
// `STEP_TAG_ENV`, inherited by the gate's own children; SIGTERM or SIGINT kills that tree
// (`killTagged`, by pid on Windows), runs the cleanup, then re-raises like `signal-shred.ts`.

import type { Runner } from './exec';
import { killTagged, STEP_TAG_ENV, taskkillTree } from './verify-deadline';

/** This hop's word in `STEP_TAG_ENV`: unique per process, so a nested hop never kills its parent's. */
export const upgradeTag = (pid: number = process.pid): string => `x-upgrade-${String(pid)}`;

/**
 * `runner` with the tag added to every child's env — after any tag an outer gate already set, as
 * `guardStep` does — and each child's pid held in `pids` while it runs: Windows reads no
 * process's environment, so the pid recorded at spawn is the only handle there.
 */
export const tagRunner =
  (
    runner: Runner,
    tag: string,
    env: Readonly<Record<string, string | undefined>>,
    pids: Set<number>,
  ): Runner =>
  async (command, options) => {
    const inherited = options.env?.[STEP_TAG_ENV] ?? env[STEP_TAG_ENV];
    const value = inherited === undefined || inherited === '' ? tag : `${inherited} ${tag}`;
    let pid: number | undefined;
    try {
      return await runner(command, {
        ...options,
        env: { ...options.env, [STEP_TAG_ENV]: value },
        onSpawn: (spawned) => {
          pid = spawned;
          pids.add(spawned);
          options.onSpawn?.(spawned);
        },
      });
    } finally {
      if (pid !== undefined) pids.delete(pid);
    }
  };

/** Kill every process carrying `tag`; on Windows, tree-kill each recorded pid. */
export const killUpgradeTree = async (tag: string, pids: ReadonlySet<number>): Promise<void> => {
  if (process.platform === 'win32') {
    for (const pid of pids) await taskkillTree(pid);
    return;
  }
  await killTagged(tag);
};

const STOP_SIGNALS = ['SIGINT', 'SIGTERM'] as const;

export interface StopInput {
  readonly tag: string;
  readonly pids: ReadonlySet<number>;
  readonly kill?: (tag: string, pids: ReadonlySet<number>) => Promise<void>;
  /** Synchronous: the lock is released before the process dies. */
  readonly cleanup: () => void;
  readonly reraise?: (signal: NodeJS.Signals) => void;
}

/**
 * On SIGINT/SIGTERM: kill the tagged tree, clean up, then remove the listeners and re-raise the
 * same signal so it meets its default action. The listeners stay until that is done and a repeat
 * is ignored (`signal-shred.ts`' reason: a forwarded second Ctrl-C would otherwise kill mid-sweep).
 * Returns the undo for the normal path.
 */
export function stopChildrenOnSignal(input: StopInput): () => void {
  const kill = input.kill ?? killUpgradeTree;
  const reraise = input.reraise ?? ((signal) => process.kill(process.pid, signal));
  let stopping = false;
  const undo = (): void => {
    for (const signal of STOP_SIGNALS) process.off(signal, handler);
  };
  function handler(signal: NodeJS.Signals): void {
    if (stopping) return;
    stopping = true;
    void kill(input.tag, input.pids)
      .catch(() => undefined)
      .finally(() => {
        try {
          input.cleanup();
        } finally {
          undo();
          reraise(signal);
        }
      });
  }
  for (const signal of STOP_SIGNALS) process.on(signal, handler);
  return undo;
}
