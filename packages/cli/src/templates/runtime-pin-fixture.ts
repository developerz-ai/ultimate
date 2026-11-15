// TEST-ONLY. The `runtime-pin` guard over a throwaway app root, every other shipped guard turned off
// in `guards/shipped.json`. Built in once it is a shipped guard; written to `guards/` until then, so
// the guard's suite and the codemod's run the same rule either way.

// why: Bun ships no temp-directory API; `node:fs/promises` is the only one.
import { mkdtemp, rm } from 'node:fs/promises';
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun exposes no path-join primitive; Bun.write takes one already joined.
import { join } from 'node:path';
import { type GuardReport, guardReport } from '../guards';
import { SHIPPED_GUARD_CONFIG } from '../guards-built-in';
import { runtimePinGuardFiles } from './guard-runtime-pin';
import { SHIPPED_GUARD_NAMES } from './scaffold-guards';

const NAME = 'runtime-pin';

export async function runtimePinReport(
  files: Readonly<Record<string, string>>,
): Promise<GuardReport> {
  const root = await mkdtemp(join(tmpdir(), `x-guard-${NAME}-`));
  try {
    const others = SHIPPED_GUARD_NAMES.filter((other) => other !== NAME);
    const severity = Object.fromEntries(others.map((other) => [other, 'off']));
    await Bun.write(join(root, SHIPPED_GUARD_CONFIG), JSON.stringify({ severity }));
    if (!SHIPPED_GUARD_NAMES.includes(NAME)) {
      for (const file of runtimePinGuardFiles()) {
        if (!file.path.endsWith('.test.ts')) await Bun.write(join(root, file.path), file.contents);
      }
    }
    for (const [path, contents] of Object.entries(files)) {
      await Bun.write(join(root, path), contents);
    }
    return await guardReport(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
