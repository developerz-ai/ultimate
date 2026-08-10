/**
 * Export names become job and task names. `registerJobs(await import('./jobs'))` is how a module
 * namespace becomes registered handles the queue, the scheduler and the manifest all address by
 * the identifier the source file uses — never a positional `anonymous-job-2`.
 */

import { type RegisteredPrimitive, registerPrimitiveRegistrar } from '@ultimat3/core';
import { isJobHandle, registerJob } from './job';
import { isTaskHandle, registerTask } from './scheduler';

/** `registerJobs(await import('./jobs'))` — export names become job names. */
export function registerJobs(
  module: Readonly<Record<string, unknown>>,
): readonly RegisteredPrimitive[] {
  const registered: RegisteredPrimitive[] = [];
  for (const name of Object.keys(module).sort()) {
    const value = module[name];
    if (isJobHandle(value)) registered.push(registerJob(name, value));
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
