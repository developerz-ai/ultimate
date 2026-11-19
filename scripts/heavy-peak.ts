#!/usr/bin/env bun
// The recipe behind every figure in `packages/cli/src/heavy-weights.ts`: run one command and report
// the peak RSS of its whole process tree, sampled from `/proc`. `getrusage` answers for the largest
// single process only, which under-reads a test run or a browser lane by the rest of the tree.
//
//   bun run scripts/heavy-peak.ts [--json] -- <command…>

// why: Bun ships no synchronous directory listing or file read for `/proc`.
import { readdirSync, readFileSync } from 'node:fs';
import { report } from './lib/log';

const SAMPLE_MS = 200;
const PAGE_BYTES = 4096;
/** Past any heavy command this measures, on the slowest box it has run on. */
const MEASURE_TIMEOUT_MS = 2 * 60 * 60_000;

export interface ProcSample {
  readonly pid: number;
  readonly ppid: number;
  readonly rssBytes: number;
}

/** `pid (comm) state ppid …` plus `/proc/<pid>/statm`; `comm` may hold spaces and parentheses. */
export function parseProc(stat: string, statm: string): ProcSample | undefined {
  const close = stat.lastIndexOf(')');
  const pid = Number.parseInt(stat, 10);
  const ppid = Number(stat.slice(close + 2).split(' ')[1]);
  const pages = Number(statm.split(' ')[1]);
  if (close < 0 || !Number.isInteger(pid) || !Number.isInteger(ppid)) return undefined;
  return Number.isFinite(pages) ? { pid, ppid, rssBytes: pages * PAGE_BYTES } : undefined;
}

/** The summed RSS of `root` and every descendant in one snapshot of the process table. */
export function treeRssBytes(samples: readonly ProcSample[], root: number): number {
  const inTree = new Set([root]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const sample of samples) {
      if (inTree.has(sample.ppid) && !inTree.has(sample.pid)) {
        inTree.add(sample.pid);
        grew = true;
      }
    }
  }
  return samples.reduce((sum, one) => sum + (inTree.has(one.pid) ? one.rssBytes : 0), 0);
}

function readProcTable(): ProcSample[] {
  const samples: ProcSample[] = [];
  for (const name of readdirSync('/proc')) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const sample = parseProc(
        readFileSync(`/proc/${name}/stat`, 'utf8'),
        readFileSync(`/proc/${name}/statm`, 'utf8'),
      );
      if (sample !== undefined) samples.push(sample);
    } catch {
      // The process exited between the listing and the read: it is no longer in the tree.
    }
  }
  return samples;
}

if (import.meta.main) {
  // Read by position, never parsed: every word after these belongs to the measured command, and
  // `bun run` has already consumed the `--` when one was typed.
  const argv = Bun.argv.slice(2);
  const json = argv[0] === '--json';
  const rest = json ? argv.slice(1) : argv;
  const command = rest[0] === '--' ? rest.slice(1) : rest;
  if (command.length === 0) {
    report(
      {
        ok: false,
        script: 'heavy-peak',
        summary: 'no command to measure',
        findings: [
          {
            code: 'X_CLI_BAD_FLAG',
            cause: 'heavy-peak measures one command and was given none after its flags',
            fix: 'bun run scripts/heavy-peak.ts -- bunx tsc -b --pretty false',
          },
        ],
      },
      json,
    );
  }
  const started = performance.now();
  const child = Bun.spawn(command, {
    stdio: [null, 'ignore', 'inherit'],
    timeout: MEASURE_TIMEOUT_MS,
  });
  let peak = 0;
  let done = false;
  const exited = child.exited.then((code) => {
    done = true;
    return code;
  });
  while (!done) {
    peak = Math.max(peak, treeRssBytes(readProcTable(), child.pid));
    await Promise.race([exited, Bun.sleep(SAMPLE_MS)]);
  }
  const code = await exited;
  const peakMb = Math.ceil(peak / 2 ** 20);
  const seconds = Math.round((performance.now() - started) / 1000);
  report(
    {
      ok: code === 0,
      script: 'heavy-peak',
      summary: `peak tree RSS ${String(peakMb)} MB, ${String(seconds)} s, exit ${String(code)}`,
      findings: [],
      data: { peakMb, seconds, exitCode: code, command },
    },
    json,
  );
}
