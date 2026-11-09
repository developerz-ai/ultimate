// Single responsibility: put a stub where a job's BODY is — `handle.run`, the one member the worker
// calls (`execute.ts`). Claim, admission, retry, the step store and settlement stay real, so a stub
// is seen by `runJobs`, a real `jobWorker` and an action's `.job()` alike.

import type { AnyJobHandle, JobRunArgs } from '@ultimat3/jobs';
import type { StubWiring } from './stub-script';
import { stubStack } from './stub-stack';
import type { Undo } from './test-scope';

type Run = (args: JobRunArgs<unknown>) => Promise<unknown>;

const push = stubStack<Run>();
/** The declared `run`, kept from the first stub on a handle until the last one is gone. */
const DECLARED = new WeakMap<object, PropertyDescriptor | undefined>();

/** Push `wiring`'s answers over `handle`'s body; the undo pops this stub and no other. */
export function stubJobBody(handle: AnyJobHandle, wiring: StubWiring<unknown, unknown>): Undo {
  if (!DECLARED.has(handle)) DECLARED.set(handle, Object.getOwnPropertyDescriptor(handle, 'run'));
  const run: Run = (args) => wiring.answer(args.input, args.ctx.actor);
  return push(handle, run, (top) => {
    if (top !== undefined) {
      Object.defineProperty(handle, 'run', { configurable: true, writable: true, value: top });
      return;
    }
    const declared = DECLARED.get(handle);
    DECLARED.delete(handle);
    if (declared === undefined) delete (handle as { run?: unknown }).run;
    else Object.defineProperty(handle, 'run', declared);
  });
}
