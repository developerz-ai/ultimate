// Single responsibility: a V8 stack string read as frames, once — the monitor's
// `exception.stacktrace.frames` and the fingerprint's application frame both parse it here. Total:
// it runs inside the catch of every failure path, on a string nobody validated.

/** `    at fn (path:1:2)`, `    at async fn (path:1:2)`, `    at path:1:2`. */
const FRAME = /^\s*at\s+(?:async\s+)?(?:(.*?)\s+\((.*)\)|(.*))$/;

/** A line and a column, or a line alone: split off the location's end. */
const POSITION = /:(\d+)(?::(\d+))?$/;

/** Library frames: the app's first frame names the fault, not the library under it. */
const LIBRARY = /(?:^|\/)(?:node_modules|@ultimat3)\//;

/** The protocol trims past this anyway; the frames KEPT are the newest, where the throw is. */
const MAX_FRAMES = 100;

export interface StackFrame {
  /** `undefined` for an anonymous frame. `new ` and `async ` are not part of the name. */
  readonly fn: string | undefined;
  /** The location without `file://` or the position, `/` separators on every OS. */
  readonly absPath: string;
  /** `absPath` relative to the working directory, so two pods agree. */
  readonly path: string;
  readonly line: number | undefined;
  readonly column: number | undefined;
  /** The app's own: a file location (a runtime's has no `/`), outside `node_modules`/`@ultimat3`. */
  readonly inApp: boolean;
}

/** One `exception.stacktrace.frames` entry, the protocol's spelling. */
export interface SentryFrame {
  readonly function?: string;
  readonly filename: string;
  readonly abs_path: string;
  readonly lineno?: number;
  readonly colno?: number;
  readonly in_app: boolean;
}

function workingDirectory(): string | undefined {
  try {
    return `${process.cwd().replaceAll('\\', '/').replace(/\/$/, '')}/`;
  } catch {
    return undefined;
  }
}

function frameOf(match: RegExpExecArray, root: string | undefined): StackFrame {
  const location = (match[2] ?? match[3] ?? '').trim();
  const position = POSITION.exec(location);
  let absPath = (position === null ? location : location.slice(0, position.index)).replaceAll(
    '\\',
    '/',
  );
  if (absPath.startsWith('file://')) absPath = absPath.slice('file://'.length);
  let path = absPath;
  if (root !== undefined && path.startsWith(root)) path = path.slice(root.length);
  path = path.replace(/^\.\//, '');
  const name = (match[1] ?? '').replace(/^new\s+/, '').trim();
  return {
    fn: name === '' ? undefined : name,
    absPath,
    path,
    line: position === null ? undefined : Number(position[1]),
    column: position?.[2] === undefined ? undefined : Number(position[2]),
    // The ABSOLUTE location has the `/`: a runtime's (`native`) never does, and a file at the app
    // root (`server.ts`) has none left once the working directory is cut off.
    inApp: position !== null && absPath.includes('/') && path !== '' && !LIBRARY.test(path),
  };
}

/**
 * The stack's frames, NEWEST first (the order V8 prints): the trailing run of `at …` lines. Read
 * from the end, because the header above them is the error's message, and a message may itself
 * hold `\n    at x (y:1:1)` — read top-down, its author would choose the frames.
 */
export function stackFrames(stack: string): readonly StackFrame[] {
  const root = workingDirectory();
  const frames: StackFrame[] = [];
  const lines = stack.trimEnd().split('\n');
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const match = FRAME.exec(lines[index] ?? '');
    if (match === null) break;
    frames.push(frameOf(match, root));
  }
  // Collected oldest first; the newest MAX_FRAMES are the ones that name the throw.
  return frames.slice(-MAX_FRAMES).reverse();
}

/** `stack` as the monitor's frames, OLDEST first as the protocol orders them; `[]`, never a throw. */
export function sentryFrames(stack: unknown): readonly SentryFrame[] {
  if (typeof stack !== 'string') return [];
  try {
    return stackFrames(stack)
      .map((frame) => ({
        ...(frame.fn === undefined ? {} : { function: frame.fn }),
        filename: frame.path,
        abs_path: frame.absPath,
        ...(frame.line === undefined ? {} : { lineno: frame.line }),
        ...(frame.column === undefined ? {} : { colno: frame.column }),
        in_app: frame.inApp,
      }))
      .reverse();
  } catch {
    return [];
  }
}
