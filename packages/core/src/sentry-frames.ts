// Single responsibility: a V8 stack string read as frames, once — the monitor's
// `exception.stacktrace.frames` and the fingerprint's application frame both parse it here. Total:
// it runs inside the catch of every failure path, on a string nobody validated.

/** A frame line longer than this is no frame: real ones are a name and a path, well under it. */
const MAX_LINE = 4096;

/** What `.` refuses besides `\n`: a line holding one is no frame, as it was under the regex. */
const LINE_BREAK = /[\r\u2028\u2029]/;

const SPACE = /\s/;

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

const isSpace = (text: string, at: number): boolean => SPACE.test(text.charAt(at));

/** Past every space from `at`. */
function skipSpaces(text: string, at: number): number {
  let index = at;
  while (index < text.length && isSpace(text, index)) index += 1;
  return index;
}

interface FrameLine {
  readonly name: string;
  readonly location: string;
}

/**
 * `    at fn (path:1:2)`, `    at async fn (path:1:2)`, `    at path:1:2`, read in ONE pass — never
 * a backtracking regex: the message above the frames is the thrower's text, and a line shaped to
 * make `(.*?)\s+\(` backtrack is quadratic on the path that reports a failure.
 */
function parseFrameLine(line: string): FrameLine | undefined {
  if (line.length > MAX_LINE || LINE_BREAK.test(line)) return undefined;
  let index = skipSpaces(line, 0);
  if (!line.startsWith('at', index) || !isSpace(line, index + 2)) return undefined;
  index = skipSpaces(line, index + 2);
  if (line.startsWith('async', index) && isSpace(line, index + 5)) {
    index = skipSpaces(line, index + 5);
  }
  const rest = line.slice(index);
  // `fn (location)`: the FIRST run of spaces followed by `(`, the location up to the closing `)`.
  if (rest.endsWith(')')) {
    let runStart = -1;
    for (let at = 0; at < rest.length - 1; at += 1) {
      if (isSpace(rest, at)) {
        if (runStart === -1) runStart = at;
      } else if (rest.charAt(at) === '(' && runStart !== -1) {
        return { name: rest.slice(0, runStart), location: rest.slice(at + 1, -1) };
      } else {
        runStart = -1;
      }
    }
  }
  return { name: '', location: rest };
}

function frameOf(frame: FrameLine, root: string | undefined): StackFrame {
  const location = frame.location.trim();
  const position = POSITION.exec(location);
  let absPath = (position === null ? location : location.slice(0, position.index)).replaceAll(
    '\\',
    '/',
  );
  if (absPath.startsWith('file://')) absPath = absPath.slice('file://'.length);
  let path = absPath;
  if (root !== undefined && path.startsWith(root)) path = path.slice(root.length);
  path = path.replace(/^\.\//, '');
  const name = frame.name.replace(/^new\s+/, '').trim();
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
    const frame = parseFrameLine(lines[index] ?? '');
    if (frame === undefined) break;
    frames.push(frameOf(frame, root));
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
