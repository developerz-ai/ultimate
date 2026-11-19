// Where a port's holder runs. A pid alone cannot tell a reader whether the server is theirs; the
// directory can, and it is what lets `x doctor` separate this checkout from a neighbour.

// why: Bun ships no readlink primitive and no existence check for a directory.
import { existsSync, readlinkSync } from 'node:fs';
// why: Bun ships no path-join primitive.
import { join } from 'node:path';
import { type PortHolder, portHolder } from './dev-lock-port-holder';
import { exec, type Runner } from './exec';

export interface PortOwner extends PortHolder {
  /** The holder's working directory, when the OS will say. */
  readonly cwd?: string;
}

const PROC = '/proc';

/** `/proc` where it exists; `lsof`'s cwd record (`n<path>`) elsewhere. `undefined` when neither says. */
export async function holderDir(
  pid: number,
  runner: Runner = exec,
  procRoot: string = PROC,
): Promise<string | undefined> {
  if (existsSync(join(procRoot, 'self'))) {
    try {
      return readlinkSync(join(procRoot, String(pid), 'cwd'));
    } catch {
      return undefined; // Gone, or another user's.
    }
  }
  try {
    const { stdout } = await runner(['lsof', '-a', '-p', String(pid), '-d', 'cwd', '-Fn'], {
      cwd: process.cwd(),
    });
    return stdout
      .split('\n')
      .find((line) => line.startsWith('n'))
      ?.slice(1);
  } catch {
    return undefined; // No `lsof`: the refusal still stands, without a directory in it.
  }
}

/** Who holds `port`: the OS's answer, plus the directory of the process it names. */
export async function portOwner(
  port: number,
  runner: Runner = exec,
  find: (port: number, runner: Runner) => Promise<PortHolder> = portHolder,
  procRoot: string = PROC,
): Promise<PortOwner> {
  const holder = await find(port, runner);
  if (holder.pid === undefined) return holder;
  const cwd = await holderDir(holder.pid, runner, procRoot);
  return cwd === undefined ? holder : { ...holder, cwd };
}

/** `pid 41 (bun) in /work/app`, as far as it is known; `undefined` with no pid to name. */
export function ownerText(owner: PortOwner): string | undefined {
  if (owner.pid === undefined) return undefined;
  const command = owner.command === undefined ? '' : ` (${owner.command})`;
  // Printed into one finding line: a directory name may hold anything.
  const dir = owner.cwd === undefined ? '' : ` in ${owner.cwd.replace(/\p{Cc}/gu, ' ')}`;
  return `pid ${String(owner.pid)}${command}${dir}`;
}
