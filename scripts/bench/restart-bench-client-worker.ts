// One shard of the 50k-socket forced-restart benchmark's client swarm, run as its own OS process.
//
// Simulating tens of thousands of real WebSocket clients in a single process was tried first and
// does not work: every reconnect after the forced kill fires near-simultaneously, and a single JS
// event loop juggling that many live sockets, timers and retry promises falls behind badly enough
// that even unrelated work on the same process (reading the freshly-spawned server's own stdout)
// was observed delayed by *minutes*. Splitting the swarm across worker processes — one per CPU
// core, each holding a few thousand sockets instead of all fifty thousand — keeps every process's
// event loop light enough to behave like the many independent browser tabs it is standing in for.
//
// Protocol with the orchestrator (restart-bench.ts), deliberately minimal:
//   - argv: --url <ws-url> --count <n> --offset <n> (this shard's clients are indices
//     [offset, offset + count))
//   - stdin: the orchestrator writes one line, "stop\n", when the measurement window is over
//   - stdout: exactly one line, "FINAL " followed by the JSON-encoded stats array, written after
//     stop is received (or after a 10-minute dead-man's switch, in case the orchestrator dies) —
//     never before, so the orchestrator can read stdout line-by-line and know the shard is done
//     the moment that one line arrives
//
// Never imported, and not part of `x verify` — see restart-bench.ts.

import { newClientStats, runClient } from './restart-bench-client';

interface WorkerArgs {
  readonly url: string;
  readonly count: number;
  readonly offset: number;
}

function parseArgs(argv: readonly string[]): WorkerArgs {
  const flag = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const url = flag('url');
  if (!url) throw new Error('restart-bench-client-worker: --url <ws-url> is required');
  return {
    url,
    count: Number(flag('count') ?? '0'),
    offset: Number(flag('offset') ?? '0'),
  };
}

/** Resolves on the first line of stdin (case-insensitively "stop"), or never if stdin closes first. */
async function waitForStop(): Promise<void> {
  for await (const chunk of Bun.stdin.stream()) {
    const text = new TextDecoder().decode(chunk);
    if (text.toLowerCase().includes('stop')) return;
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const stats = Array.from({ length: args.count }, (_, i) => newClientStats(args.offset + i));
  const controller = new AbortController();
  const runs = stats.map((s) => runClient(args.url, s, controller.signal));

  // Dead-man's switch: if the orchestrator is killed or its pipe breaks, this shard still exits
  // and reports rather than hanging the whole benchmark indefinitely. `unref`'d and cleared on the
  // ordinary path so it never keeps this process alive after `stop` already won the race — a timer
  // left running is a live handle, and a live handle is exactly what stops `bun run` from exiting
  // even after every promise it was blocking on has settled.
  let deadMansTimer: ReturnType<typeof setTimeout> | undefined;
  const deadMansSwitch = new Promise<void>((resolve) => {
    deadMansTimer = setTimeout(resolve, 10 * 60_000);
    deadMansTimer.unref?.();
  });
  await Promise.race([waitForStop(), deadMansSwitch]);
  clearTimeout(deadMansTimer);

  controller.abort();
  await Promise.allSettled(runs);
  console.log(`FINAL ${JSON.stringify(stats)}`);
}

if (import.meta.main) {
  await main();
}
