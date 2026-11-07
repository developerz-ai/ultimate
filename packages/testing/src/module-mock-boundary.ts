// `mock.module` undone at the file boundary. Bun keeps a module mock for the life of the process,
// past `mock.restore()` and past the file, so on a shared (`--no-isolate`) worker the NEXT file read
// the fake — a verdict that depended on which file the worker ran first. The preload wraps the call:
// a file's first mock of a module snapshots the real namespace, and the boundary mocks it back.

import { beforeEach, jest, mock, vi } from 'bun:test';
// why: Bun ships no path-join primitive; a relative specifier is resolved against its caller.
import { dirname, join } from 'node:path';
import { inTestFile, onFileBoundary } from './file-boundary';
import type { UnrestorableMock } from './module-mock-error';
import { ModuleMockUnrestorableError } from './module-mock-error';

type MockModule = (id: string, factory: () => unknown) => unknown;

/** The calling file, from a stack captured above `wrapper`: `at fn (/path/a.test.ts:3:5)`. */
export function callerFile(stack: string | undefined): string | undefined {
  const frame = stack?.split('\n')[1];
  const match =
    frame === undefined ? null : /\(?((?:[A-Za-z]:)?[/\\][^()]*?):\d+:\d+\)?\s*$/.exec(frame);
  return match?.[1];
}

let installed = false;

/** Called by the preload once per process; idempotent. */
export function installModuleMockBoundary(): void {
  if (installed) return;
  installed = true;
  const original = mock.module.bind(mock) as MockModule;
  const real = new Map<string, Readonly<Record<string, unknown>>>();
  const unrestorable: UnrestorableMock[] = [];
  let inherited: UnrestorableMock[] = [];

  const wrapper: MockModule = (id, factory) => {
    const holder: { stack?: string } = {};
    Error.captureStackTrace(holder, wrapper);
    const file = callerFile(holder.stack) ?? process.cwd();
    const dir = dirname(file);
    let url = id.startsWith('./') || id.startsWith('../') ? join(dir, id) : id;
    let missing: unknown;
    try {
      url = Bun.resolveSync(id, dir);
    } catch (reason) {
      // A virtual module is legal to mock; with no real one there is nothing to put back.
      missing = reason;
    }
    // A preload's mock is every file's environment, never one file's to undo.
    const tracked = real.has(url) || unrestorable.some((each) => each.url === url);
    if (inTestFile() && !tracked) {
      if (missing !== undefined) unrestorable.push({ file, url, reason: missing });
      else {
        try {
          // why: `require` is the one synchronous load; the snapshot must exist before the fake does.
          real.set(url, { ...(require(url) as Record<string, unknown>) });
        } catch (reason) {
          unrestorable.push({ file, url, reason });
        }
      }
    }
    // The resolved path, so the mock and the boundary's restore name one module.
    return original(url, factory);
  };

  for (const host of [mock, vi, jest] as const) {
    Object.defineProperty(host, host === mock ? 'module' : 'mock', {
      value: wrapper,
      writable: true,
      configurable: true,
    });
  }

  onFileBoundary(() => {
    for (const [url, namespace] of real) original(url, () => namespace);
    real.clear();
    inherited = [...inherited, ...unrestorable.splice(0)];
  });

  // The boundary's hooks cannot fail a run, so the next file's first test carries the verdict.
  beforeEach(() => {
    if (inherited.length === 0) return;
    const mocks = inherited;
    inherited = [];
    throw new ModuleMockUnrestorableError(mocks);
  });
}
