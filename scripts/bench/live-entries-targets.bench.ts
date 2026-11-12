// One node's live-entry table holding N windows on `posts`, a few of them stale, asked which
// windows a change on `comments` is work for. The claim (plan 101 2026-11-11 R3): per-change cost
// is independent of N — the owing set is kept where `stale` moves, never found by a walk.
//
//   bun run scripts/bench/live-entries-targets.bench.ts [--json] [--entries <n>] [--changes <n>]

import { RingChangeBuffer } from '../../packages/realtime/src/change-buffer';
import type { LiveQueryDefinition } from '../../packages/realtime/src/live-contract';
import { LiveEntries } from '../../packages/realtime/src/live-entries';
import { parseScriptArgs } from '../lib/args';

export interface TargetsBenchResult {
  readonly entries: number;
  readonly stale: number;
  readonly changes: number;
  /** What each `targets()` answered: the stale windows, since none reads `comments`. */
  readonly windowsPerChange: number;
  readonly msPerChange: number;
  readonly targetsPerSecond: number;
}

const feed: LiveQueryDefinition = {
  name: 'feed',
  entities: ['posts'],
  snapshot: async () => ({ rows: [], lsn: '' }),
  visible: () => true,
  matcher: () => ({ entities: ['posts'], match: () => ({ patches: [], refill: false }) }),
};

/** `entries` windows on `posts`; the first `stale` of them marked as having missed a change. */
export function targetsRig(entries: number, stale: number): { entries: LiveEntries } {
  const table = new LiveEntries({ source: new RingChangeBuffer(), maxEntries: entries + 1 });
  for (let i = 0; i < entries; i += 1) {
    const entry = table.seat(`feed:${String(i)}`, feed, { page: i }, null, undefined);
    if (i < stale) entry.stale = true;
  }
  return { entries: table };
}

/** The rig, then `changes` `targets()` calls timed. */
export function benchTargets(entries: number, changes: number, stale: number): TargetsBenchResult {
  const rig = targetsRig(entries, stale);
  let picked = 0;
  const started = performance.now();
  for (let i = 0; i < changes; i += 1) picked += rig.entries.targets('comments').length;
  const ms = performance.now() - started;
  return {
    entries,
    stale,
    changes,
    windowsPerChange: picked / changes,
    msPerChange: Number((ms / changes).toFixed(5)),
    targetsPerSecond: Math.round(changes / (ms / 1000)),
  };
}

if (import.meta.main) {
  const args = parseScriptArgs(Bun.argv.slice(2));
  const entries = Number(args.flags.get('entries') ?? 50_000);
  const changes = Number(args.flags.get('changes') ?? 2_000);
  const result = benchTargets(entries, changes, 8);
  if (args.json) console.log(JSON.stringify(result, null, 2));
  else
    console.log(
      `${result.entries} entries (${result.stale} stale), ${result.changes} changes: ` +
        `${result.msPerChange} ms/change, ${result.targetsPerSecond} changes/s`,
    );
}
