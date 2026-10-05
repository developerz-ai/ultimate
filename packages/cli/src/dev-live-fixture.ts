// The `x dev` live tests' process discipline, in one place: spawn the supervisor, read its two
// streams, and — on every path, a failing one included — reap every process it started and prove
// none is left. Two children of `cmd-dev-restart.live.test.ts` ran for six hours with ppid 1 and a
// deleted cwd because the test's `finally` SIGKILLed the supervisor, which cannot forward a signal
// it never gets, and nothing then looked for what it had started (2026-09-29).

import { readdirSync, readlinkSync } from 'node:fs'; // why: /proc is read synchronously; Bun has no readlink.

/** One pump per stream — reading a stream twice closes its reader under the first `for await`. */
export function pump(stream: ReadableStream<Uint8Array>): { seen: () => string } {
  const decoder = new TextDecoder();
  let seen = '';
  void (async () => {
    for await (const chunk of stream) seen += decoder.decode(chunk, { stream: true });
  })();
  return { seen: () => seen };
}

/** Poll the buffer until `marker` shows up. The caller's own timeout is the deadline. */
export async function waitFor(output: { seen: () => string }, marker: string): Promise<string> {
  for (;;) {
    const seen = output.seen();
    if (seen.includes(marker)) return seen;
    await Bun.sleep(25);
  }
}

/** Whether `pid` is still a process — signal 0 delivers nothing and only asks. */
export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Every descendant of `pid` in a `[pid, ppid]` listing, depth first; a racing cycle stops. */
export function descendantsIn(
  listing: readonly (readonly [number, number])[],
  pid: number,
): readonly number[] {
  const out: number[] = [];
  const seen = new Set<number>([pid]);
  const walk = (parent: number): void => {
    for (const [child, ppid] of listing) {
      if (ppid !== parent || seen.has(child)) continue;
      seen.add(child);
      out.push(child);
      walk(child);
    }
  };
  walk(pid);
  return out;
}

/**
 * The `[pid, ppid]` listing command per platform. Windows has no `ps`: CIM's `Win32_Process` is
 * the one table that carries the parent, printed in the same `pid ppid` lines `ps` gives.
 */
export function pidListingCommand(platform: string = process.platform): readonly string[] {
  return platform === 'win32'
    ? [
        'powershell',
        '-NoProfile',
        '-Command',
        'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId)" }',
      ]
    : ['ps', '-A', '-o', 'pid=,ppid='];
}

/** `pid ppid` lines, whitespace-padded or CRLF-terminated, as `[pid, ppid]` pairs. */
export function parsePidPairs(text: string): readonly (readonly [number, number])[] {
  return text.split(/\r?\n/).flatMap((line): (readonly [number, number])[] => {
    const [child, parent] = line.trim().split(/\s+/).map(Number);
    return Number.isInteger(child) && Number.isInteger(parent) ? [[child ?? 0, parent ?? 0]] : [];
  });
}

/**
 * Every descendant of `pid`, depth first — asked while `pid` lives, or (POSIX) its children are
 * init's. Windows never reparents, so there a dead supervisor's children still name it. ONE listing
 * walked in memory, never a `pgrep` per level: this runs synchronously inside a test's `finally`,
 * where the test timeout cannot interrupt it, so the whole walk shares one bound.
 */
export function descendantsOf(pid: number): readonly number[] {
  const out = Bun.spawnSync([...pidListingCommand()], { timeout: 10_000 }).stdout.toString();
  return descendantsIn(parsePidPairs(out), pid);
}

/**
 * Every process whose cwd is `dir` — a deleted one included, which Linux spells `<dir> (deleted)`.
 * The one question that finds an orphan after its parent is gone, when no process tree reaches it.
 * Empty where there is no `/proc` (macOS, Windows): the descendant walk is then the whole answer.
 */
export function processesIn(dir: string): readonly number[] {
  let pids: readonly string[];
  try {
    pids = readdirSync('/proc').filter((name) => /^\d+$/.test(name));
  } catch {
    return [];
  }
  const found: number[] = [];
  for (const pid of pids) {
    try {
      const cwd = readlinkSync(`/proc/${pid}/cwd`);
      if (cwd === dir || cwd === `${dir} (deleted)`) found.push(Number(pid));
    } catch {
      // Gone between the listing and the read, or not ours to read.
    }
  }
  return found;
}

/** Whether anything still answers on `port` at the loopback address `x dev` binds. */
export async function listening(port: number): Promise<boolean> {
  try {
    const socket = await Bun.connect({
      hostname: '127.0.0.1',
      port,
      socket: { data: () => undefined },
    });
    socket.end();
    return true;
  } catch {
    return false;
  }
}

/**
 * SIGKILL `pids`, then wait until each is gone. A test's last resort, run in `finally` — by then
 * every graceful stop the test meant to prove has had its chance. `performance.now()`, never
 * `Date.now()`: the test preload freezes the wall clock, and a deadline read off it never arrives.
 */
export async function reap(pids: readonly number[], timeoutMs = 10_000): Promise<void> {
  for (const pid of pids) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // Already gone.
    }
  }
  const until = performance.now() + timeoutMs;
  while (pids.some(alive) && performance.now() < until) await Bun.sleep(25);
}

/** What was left: the pids still in `dir` and whether `port` still answers. Both empty is clean. */
export async function leftovers(
  dir: string,
  port: number | undefined,
): Promise<{ readonly pids: readonly number[]; readonly port: boolean }> {
  return {
    pids: processesIn(dir),
    port: port === undefined ? false : await listening(port),
  };
}

/**
 * The net under a TIMED-OUT test: bun abandons its body without running `finally`, so an
 * `afterEach` reaps whatever still runs in the fixture directory — the only handle left on an
 * orphan whose parent is gone.
 */
export async function reapIn(dir: string): Promise<void> {
  await reap(processesIn(dir));
}
