// Single responsibility: which error reports are the same fault. A pure function over a report,
// never a field on it: `ErrorReport` is public, and a member every hand-built report must now
// carry, or every reader must now tolerate missing, is a break for a key a monitor can derive.

import { fingerprint } from './canonical-json';
import { stringField } from './error-render';
import type { ErrorReport } from './error-reporter';

/** `errorReport()`'s code for a throw nobody classified: the one code too wide to group on. */
const UNCLASSIFIED = 'X_INTERNAL';

/** `    at fn (path:1:2)`, `    at async fn (path:1:2)`, `    at path:1:2`. */
const FRAME = /^\s*at\s+(?:async\s+)?(?:(.*?)\s+\((.*)\)|(.*))$/;

/** A line and a column, or a line alone: an edit above the throw moves both. */
const POSITION = /(?::\d+){1,2}$/;

/** Library frames: the first frame that is the APP's names the fault, not the library under it. */
const LIBRARY = /(?:^|\/)(?:node_modules|@ultimat3)\//;

/** Reads that cannot throw: this runs on the path that reports a failure, and adds none. */
function read<T>(get: () => T): T | undefined {
  try {
    return get();
  } catch {
    return undefined;
  }
}

function workingDirectory(): string | undefined {
  const cwd = read(() => process.cwd());
  return cwd === undefined ? undefined : `${cwd.replaceAll('\\', '/').replace(/\/$/, '')}/`;
}

/** `file://`, the working directory and the position dropped; `/` separators on every OS. */
function relativePath(location: string, root: string | undefined): string {
  let path = location.trim().replace(POSITION, '').replaceAll('\\', '/');
  if (path.startsWith('file://')) path = path.slice('file://'.length);
  if (root !== undefined && path.startsWith(root)) path = path.slice(root.length);
  return path.replace(/^\.\//, '');
}

/**
 * The stack's FRAMES: the trailing run of `at …` lines. Read from the end, because the header
 * above them is the error's message, and a message may itself hold `\n    at x (y:1:1)` — which
 * read top-down would set the group to whatever the message's author typed.
 */
function framesOf(stack: string): readonly RegExpExecArray[] {
  const frames: RegExpExecArray[] = [];
  const lines = stack.trimEnd().split('\n');
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const match = FRAME.exec(lines[index] ?? '');
    if (match === null) break;
    frames.unshift(match);
  }
  return frames;
}

/**
 * The top application frame as `fn path`, or `undefined`. A frame with no file location (`native`,
 * `<anonymous>`, `processTicksAndRejections (native:7:39)`) is skipped as well: it is the
 * runtime's, and two faults share it. A file location has a `/`; a runtime's never does.
 */
function applicationFrame(stack: string | undefined): string | undefined {
  if (stack === undefined) return undefined;
  const root = workingDirectory();
  for (const match of framesOf(stack)) {
    const location = match[2] ?? match[3] ?? '';
    if (!POSITION.test(location.trim())) continue;
    if (!location.replaceAll('\\', '/').includes('/')) continue;
    const path = relativePath(location, root);
    if (path === '' || LIBRARY.test(path)) continue;
    const name = (match[1] ?? '').replace(/^new\s+/, '').trim();
    return name === '' ? path : `${name} ${path}`;
  }
  return undefined;
}

/**
 * A stable, 16-hex grouping key for a report. A coded fault groups on `code`, `source` and
 * `scope.operation`; `X_INTERNAL` adds the top application frame (function and root-relative path,
 * no line or column), because on its code alone every unclassified throw in an app is one group.
 * Never `cause`, `meta`, an id or `release`: a row id splits one fault into a group per row, and a
 * deploy is not a new fault. Total: a report it cannot read degrades to the frameless key.
 */
export function errorFingerprint(report: ErrorReport): string {
  const code = stringField(report, 'code');
  const source = stringField(report, 'source');
  const operation = stringField(
    read(() => report.scope),
    'operation',
  );
  const frame = code === UNCLASSIFIED ? applicationFrame(stringField(report, 'stack')) : undefined;
  return fingerprint({ code, source, operation, frame });
}
