// Single responsibility: WHEN a test double is put back. A stub or a swapped adapter made inside a
// test is undone after that test; one made outside any test (a `beforeAll`, module scope) after its
// FILE. The preload's own hooks do it, so no test file writes an `afterEach` that a skipped block
// could leave unreached (`X_SKIP_CLEANUP_UNREACHED`'s defect, made impossible rather than refused).

import { afterEach, beforeEach } from 'bun:test';
import { onFileBoundary } from './file-boundary';
import { TestScopeUninstalledError } from './stub-errors';

/** Puts one double back. Synchronous: a file boundary cannot await, and no installer needs to. */
export type Undo = () => void;

let installed = false;
let inTest = false;
const testUndos: Undo[] = [];
const fileUndos: Undo[] = [];

/**
 * Last made, first undone — two swaps of one port inside one test unwind to the value the test
 * found. Every undo runs even when one throws; the first throw is what the caller sees.
 */
function unwind(undos: Undo[]): void {
  let first: { readonly error: unknown } | undefined;
  for (let undo = undos.pop(); undo !== undefined; undo = undos.pop()) {
    try {
      undo();
    } catch (error) {
      first ??= { error };
    }
  }
  if (first !== undefined) throw first.error;
}

/**
 * Hand `undo` to the scope that is open now: the running test's, else the file's. Refused — never
 * silently kept — in a process the testing preload did not set up: nothing would ever run it, and
 * the double would answer for every later file on the worker.
 */
export function deferRestore(what: string, undo: Undo): void {
  if (!installed) throw new TestScopeUninstalledError(what);
  (inTest ? testUndos : fileUndos).push(undo);
}

/**
 * `deferRestore` for an install that has to AWAIT (a module loaded on first use). The undo is
 * registered first, so a missing preload refuses before anything changes; and when the scope ends
 * while the install is still in flight — a test that timed out on a cold import — the install that
 * lands afterwards is undone the moment it lands, never left to answer for every later test.
 */
export async function scopedInstall<T>(
  what: string,
  install: () => Promise<{ readonly value: T; readonly undo: Undo }>,
): Promise<T> {
  let closed = false;
  let undo: Undo | undefined;
  deferRestore(what, () => {
    closed = true;
    undo?.();
  });
  const installed = await install();
  if (closed) installed.undo();
  else undo = installed.undo;
  return installed.value;
}

/** Whether a double made now is the running test's (`true`) or its file's (`false`). */
export function inTestScope(): boolean {
  return inTest;
}

/** The test's half, run by the preload's `afterEach`. Exported for this package's own tests. */
export function endTestScope(): void {
  inTest = false;
  unwind(testUndos);
}

/** The file's half, run at the boundary before the next file — after its tests' halves. */
export function endFileScope(): void {
  endTestScope();
  unwind(fileUndos);
}

/**
 * Called once per process by both preloads, through `installPerTestReset`. A preload's
 * `beforeEach` runs before a file's own and its `afterEach` after, so a file's `afterEach` still
 * sees its stubs and nothing it made outlives the test.
 */
export function installTestScope(): void {
  if (installed) return;
  installed = true;
  beforeEach(() => {
    inTest = true;
  });
  afterEach(endTestScope);
  onFileBoundary(endFileScope);
}
