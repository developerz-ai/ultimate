// `logs.tail`'s reader, split from `mcp-host.ts` at its size ceiling: which file a tail reads, the
// end-first bounded read, and a role's tail out of the one dev log `x dev` writes for every role.
// `x logs tail` (`cmd-logs.ts`) reads through the same path rule and reader.

// why: Bun exposes no path API; the dev log and a per-role log are joined under the state dir.
import { join } from 'node:path';
import { isRole, ROLES, stringField, UltimateError } from '@ultimat3/core';
import { DEV_LOG_FILENAME } from './dev-log';
import { BadFlagError } from './errors';

/**
 * The log `logs.tail` reads. `role` is joined into a path, so it must BE a role: `'../x'` named a
 * file outside the state directory. The tool's schema lists the roles, but a schema is advice to a
 * client and this is the line that opens the file.
 */
export function logTailPath(dir: string, role: string | undefined): string {
  if (role === undefined) return join(dir, DEV_LOG_FILENAME);
  if (!isRole(role)) {
    throw new BadFlagError({
      flag: 'role',
      command: 'mcp serve',
      reason: `logs.tail's role "${role}" is not a runtime role`,
      fix: `logs.tail({ role: 'web' })   # role is one of ${ROLES.join(', ')}; none reads dev.log`,
    });
  }
  return join(dir, 'logs', `${role}.log`);
}

/** The first window read from a log's end; each further one is four times wider. */
const TAIL_WINDOW_BYTES = 64 * 1024;
/** The most a tail ever reads: past this, lines that long are cut rather than the log loaded. */
const TAIL_MAX_BYTES = 1024 * 1024;

/** What `tailLines` reads of a file: its size and a byte range — `Bun.file`'s own shape. */
export interface TailSource {
  readonly size: number;
  slice(start: number, end: number): { text(): Promise<string> };
}

/**
 * The last `lines` lines that `keep` accepts, read from the END in widening windows. `file.text()`
 * loaded the whole `dev.log` per call, and an agent calls this in a loop against a log `x dev`
 * never rotates. A window that does not start at byte 0 drops its first line: it may be partial,
 * and may begin mid-character. A filtered tail answers what the last 1 MiB holds.
 */
export async function tailLines(
  file: TailSource,
  lines: number,
  keep: (line: string) => boolean = () => true,
): Promise<readonly string[]> {
  let window = TAIL_WINDOW_BYTES;
  for (;;) {
    const start = Math.max(0, file.size - Math.min(window, TAIL_MAX_BYTES));
    const all = (await file.slice(start, file.size).text()).trimEnd().split('\n');
    const whole = (start === 0 ? all : all.slice(1)).filter(keep);
    if (whole.length >= lines || start === 0) return whole.slice(-lines);
    // At the cap with no newline inside it, the one line there is longer than the cap: answered
    // cut, never as `[]` — an empty tail reads as an empty log.
    if (window >= TAIL_MAX_BYTES) {
      return (whole.length === 0 ? all.filter(keep) : whole).slice(-lines);
    }
    window *= 4;
  }
}

/**
 * The runtime role a dev-log line names, when it names one. Core puts the context's `role` on
 * every line written inside a request or a job (`context.ts`'s logger fields); a line written
 * outside any context — the boot, a loop's own warning — names none and belongs to no role's tail.
 */
export function lineRole(line: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return undefined;
  }
  // `stringField`, the total read: a parsed line is a stranger's object, never `in`-guarded then read.
  const role = stringField(parsed, 'role');
  return role !== undefined && isRole(role) ? role : undefined;
}

/** A log on disk: its size and byte ranges, or nothing. `Bun.file` unless a test hands one in. */
export type LogOpener = (path: string) => Promise<TailSource | undefined>;

export const openLog: LogOpener = async (path) => {
  const file = Bun.file(path);
  return (await file.exists()) ? file : undefined;
};

/** What a tail read: the file it came from, and its last lines. */
export interface LogTail {
  readonly path: string;
  readonly lines: readonly string[];
}

/**
 * `logs.tail` and `x logs tail`, one answer: a role's own `logs/<role>.log` when one was written
 * there (a role run with its output sent to it), else that role's lines of `dev.log` — `x dev` runs
 * every role in one process and one log. With neither, `x dev` is the process that writes one.
 */
export async function readLogTail(
  dir: string,
  lines: number,
  role: string | undefined,
  open: LogOpener = openLog,
): Promise<LogTail> {
  const ownPath = logTailPath(dir, role);
  const own = await open(ownPath);
  if (own !== undefined) return { path: ownPath, lines: await tailLines(own, lines) };
  const devPath = join(dir, DEV_LOG_FILENAME);
  const dev = role === undefined ? undefined : await open(devPath);
  if (dev === undefined) {
    throw new UltimateError({
      code: 'X_DEV_LOG_ABSENT',
      cause: `${devPath} does not exist yet: x dev writes it, every role's lines included${role === undefined ? '' : `, and no ${ownPath} was written either`}`,
      fix: 'x dev',
    });
  }
  return { path: devPath, lines: await tailLines(dev, lines, (line) => lineRole(line) === role) };
}
