// The one place a CLI command gets hold of the app's job queue. `x jobs` and `x db backfill`
// both need a `JobDriver` and neither owns one — a second copy of this boot would be two answers
// to "which queue is this command talking to", which is the drift axiom 1 refuses.

import type { JobDriver } from '@ultimat3/jobs';
import { jobDriver } from '@ultimat3/jobs';
import type { CommandContext } from './command';
import { startQueue } from './dev-queue';
import { resolveServices } from './dev-services';
import type { CommandResult } from './output';

/**
 * `x jobs` needs the app's real driver. Reuse an already-running one first — inside `x dev` or
 * `x mcp serve`, `jobDriver()` is already set and booting a second queue on top of it would talk
 * to the wrong database. Otherwise boot just the db + jobs half (`startQueue`, not the full
 * `startServices`: these commands touch no transport, storage or mail) and always release it, or
 * a CLI that exits holding the PGlite lock breaks the next command run against this app.
 */
export async function withJobDriver(
  root: string,
  ctx: CommandContext,
  fn: (driver: JobDriver) => Promise<CommandResult>,
): Promise<CommandResult> {
  const ambient = jobDriver();
  if (ambient !== undefined) return fn(ambient);
  const services = resolveServices(root, ctx.env);
  const queue = await startQueue(services);
  try {
    return await fn(queue.jobs);
  } finally {
    await queue.stop();
  }
}
