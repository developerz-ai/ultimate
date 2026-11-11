// `x dev`'s log on disk: every line the process logger writes, teed into `<stateDir>/dev.log`
// beside the terminal, so the dev MCP server's `logs.tail` has a file to read. Rotated once at
// 16 MiB (`dev.log.1`): a dev server left up for a week must not fill the disk.

// why: Bun has no synchronous append, rename or mkdir. A log line is written synchronously so the
// last line before a crash is on disk, and rotation is one rename.
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  renameSync,
  statSync,
  writeSync,
} from 'node:fs';
// why: Bun exposes no path-join primitive.
import { join } from 'node:path';
import type { LogLevel } from '@ultimat3/core';
import { installLogSink } from '@ultimat3/core';
import { writeErrorLine, writeLine } from './write-line';

export const DEV_LOG_FILENAME = 'dev.log';
/** The size at which `dev.log` becomes `dev.log.1` and starts over. */
export const DEV_LOG_MAX_BYTES = 16 * 1024 * 1024;

export const devLogPath = (stateDir: string): string => join(stateDir, DEV_LOG_FILENAME);

export interface DevLog {
  /** One line; the newline is added here. */
  write(line: string): void;
  close(): void;
}

const sizeOf = (path: string): number => (existsSync(path) ? statSync(path).size : 0);

/**
 * The file, appended to: a restarted `x dev` child (`dev-supervisor.ts`) continues the log the
 * last one wrote, and what it already held counts toward the cap.
 */
export function openDevLog(stateDir: string, maxBytes: number = DEV_LOG_MAX_BYTES): DevLog {
  const path = devLogPath(stateDir);
  // External database and storage leave the state directory uncreated (`runtime-bindings.ts`).
  mkdirSync(stateDir, { recursive: true });
  let size = sizeOf(path);
  let fd = openSync(path, 'a');
  const encoder = new TextEncoder();
  return {
    write(line: string): void {
      const bytes = encoder.encode(`${line}\n`);
      if (size > 0 && size + bytes.length > maxBytes) {
        closeSync(fd);
        renameSync(path, `${path}.1`);
        fd = openSync(path, 'a');
        size = 0;
      }
      writeSync(fd, bytes);
      size += bytes.length;
    },
    close(): void {
      closeSync(fd);
    },
  };
}

/** Where a terminal line goes: the CLI's own synchronous fd writers, by default. */
export type TerminalWrite = (line: string, stream: 'stdout' | 'stderr') => void;

const toTerminal: TerminalWrite = (line, stream) =>
  stream === 'stderr' ? writeErrorLine(line) : writeLine(line);

const ERROR_LEVELS: ReadonlySet<LogLevel> = new Set(['error', 'fatal']);

/**
 * Tee the process logger into `dev.log` until the returned release runs. The terminal keeps the
 * lanes core's own writer uses: `--json` (`dispatch.ts`'s `setLogStream('stderr')`) and every
 * `error`/`fatal` line on stderr, the rest on stdout — stdout under `--json` is the document.
 */
export function teeDevLog(
  stateDir: string,
  options: { readonly json: boolean; readonly write?: TerminalWrite },
): () => void {
  const log = openDevLog(stateDir);
  const terminal = options.write ?? toTerminal;
  const release = installLogSink((line, level) => {
    log.write(line);
    terminal(line, options.json || ERROR_LEVELS.has(level) ? 'stderr' : 'stdout');
  });
  let released = false;
  return () => {
    if (released) return;
    released = true;
    release();
    log.close();
  };
}
