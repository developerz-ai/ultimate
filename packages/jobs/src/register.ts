/**
 * Export names become job and task names. `registerJobs(await import('./jobs'))` is how a module
 * namespace becomes registered handles the queue, the scheduler and the manifest all address by
 * the identifier the source file uses — never a positional `anonymous-job-2`.
 */

import { type RegisteredPrimitive, registerPrimitiveRegistrar } from '@ultimat3/core';
import { ActionJobUnbridgedError } from './errors';
import { isJobHandle, registerJob } from './job';
import { isTaskHandle, registerTask } from './task';

/**
 * `@ultimat3/action`'s job PROJECTION, recognised structurally because that package is this tier
 * and may never be imported here. `kind: 'action-job'` is a literal chosen to be distinguishable
 * from `'job'` rather than a near-miss (`packages/action/src/job-handle.ts` says so), which is
 * precisely what makes this check possible without an import.
 */
const isActionProjection = (
  value: unknown,
): value is { readonly kind: 'action-job'; readonly name: string } =>
  typeof value === 'object' &&
  value !== null &&
  'kind' in value &&
  (value as { readonly kind: unknown }).kind === 'action-job';

/** `registerJobs(await import('./jobs'))` — export names become job names. */
export function registerJobs(
  module: Readonly<Record<string, unknown>>,
): readonly RegisteredPrimitive[] {
  const registered: RegisteredPrimitive[] = [];
  for (const name of Object.keys(module).sort()) {
    const value = module[name];
    if (isJobHandle(value)) {
      registered.push(registerJob(name, value));
      continue;
    }
    // Everything else is skipped in silence — a module namespace is full of constants, types and
    // helpers exported beside the jobs. Everything else EXCEPT this one, which is unambiguously
    // someone trying to queue an action and getting nothing at all.
    if (isActionProjection(value)) {
      throw new ActionJobUnbridgedError({ export: name, job: value.name });
    }
  }
  return registered;
}

/** `registerTasks(await import('./tasks'))` — export names become task names. */
export function registerTasks(
  module: Readonly<Record<string, unknown>>,
): readonly RegisteredPrimitive[] {
  const registered: RegisteredPrimitive[] = [];
  for (const name of Object.keys(module).sort()) {
    const value = module[name];
    if (isTaskHandle(value)) registered.push(registerTask(name, value));
  }
  return registered;
}

// `defineApi` lives in `@ultimat3/action`, which sits on this tier and so cannot import this
// file. Announcing the registrars in core's table is what lets one `defineApi({ jobs, tasks })`
// call name durable work without a sideways import — importing the module you pass is what
// loads this.
registerPrimitiveRegistrar('job', registerJobs);
registerPrimitiveRegistrar('task', registerTasks);
