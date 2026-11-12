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
import { teeLogLines } from '@ultimat3/core';

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

/**
 * Tee the process logger into `dev.log` until the returned release runs. A TEE, never a redirect:
 * the terminal keeps every line on core's own lanes (`--json` and `error`/`fatal` on stderr), and
 * which lane a level takes stays core's rule alone — this file only adds the copy on disk.
 */
export function teeDevLog(stateDir: string): () => void {
  const log = openDevLog(stateDir);
  const release = teeLogLines((line) => log.write(line));
  let released = false;
  return () => {
    if (released) return;
    released = true;
    release();
    log.close();
  };
}
