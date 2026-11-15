// The hop between its pin write and its gate, recorded in `.x/upgrade.json`. Once the pins land a
// rerun reads them as "at target", so without this record a stopped hop answered done with no
// install, no gate and no coverage rebaseline. Written before the first pin, removed when the gate returns.

// why: Bun has no mkdir and no remove; the record is a file in a directory that may not exist yet.
import { mkdirSync, rmSync } from 'node:fs';
// why: Bun exposes no path-join primitive.
import { join } from 'node:path';

/** App-root relative: `.x/` is the state every scaffold already ignores. */
export const UNFINISHED_FILE = join('.x', 'upgrade.json');

export interface UnfinishedHop {
  readonly from: string;
  readonly to: string;
  /** `engines.bun` before and after the pin write: a resumed hop rebaselines coverage from them. */
  readonly bunFrom: string | null;
  readonly bunTo: string | null;
  /** ISO 8601, only ever printed. */
  readonly startedAt: string;
}

const textOrNull = (value: unknown): string | null | undefined =>
  value === null ? null : typeof value === 'string' ? value : undefined;

/** Total: a torn write or a hand edit is no record, never a crash on the path that recovers one. */
export function parseUnfinished(raw: string): UnfinishedHop | undefined {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof value !== 'object' || value === null) return undefined;
  const { from, to, bunFrom, bunTo, startedAt } = value as Record<string, unknown>;
  const bf = textOrNull(bunFrom);
  const bt = textOrNull(bunTo);
  if (typeof from !== 'string' || typeof to !== 'string') return undefined;
  if (bf === undefined || bt === undefined) return undefined;
  return {
    from,
    to,
    bunFrom: bf,
    bunTo: bt,
    startedAt: typeof startedAt === 'string' ? startedAt : '',
  };
}

export async function readUnfinished(root: string): Promise<UnfinishedHop | undefined> {
  const file = Bun.file(join(root, UNFINISHED_FILE));
  return (await file.exists()) ? parseUnfinished(await file.text()) : undefined;
}

export async function writeUnfinished(root: string, hop: UnfinishedHop): Promise<void> {
  mkdirSync(join(root, '.x'), { recursive: true });
  await Bun.write(join(root, UNFINISHED_FILE), `${JSON.stringify(hop, null, 2)}\n`);
}

export async function clearUnfinished(root: string): Promise<void> {
  rmSync(join(root, UNFINISHED_FILE), { force: true });
}
