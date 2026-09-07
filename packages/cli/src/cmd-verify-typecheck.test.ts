// The `typecheck` step's one configurable edge: which binary `bunx` invokes. Its own file
// because `cmd-verify.test.ts` is at the 500-line ceiling and this is a separate question from
// how the runner sequences steps.

import { describe, expect, test } from 'bun:test';
// why: Bun ships no `Bun.*` equivalent for either — `mkdtemp`/`rm` own a throwaway app root's
// lifetime, and `join` builds the host-separator path the floor file is written to.
import { mkdtemp, rm } from 'node:fs/promises';
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun exposes no path-join primitive.
import { join } from 'node:path';
import { VERIFY_STEPS } from './cmd-verify';
import type { Runner } from './exec';
import { VERIFY_FLOOR_FILE } from './verify-floor';
import type { VerifyContext } from './verify-step';

const ctx: VerifyContext = {
  root: '/nowhere',
  runner: async () => ({
    command: ['true'],
    code: 0,
    ok: true,
    stdout: '',
    stderr: '',
    durationMs: 0,
  }),
};

describe('unit · x verify · typecheckBin', () => {
  // `x.verify.json`'s `typecheckBin` swaps the binary `bunx` invokes and nothing else — same
  // `-b --pretty false`, same step, same finding either way. Absent means `tsc`, unchanged.
  test("the typecheck step runs the floor's typecheckBin, and tsc without one", async () => {
    const step = VERIFY_STEPS.find((candidate) => candidate.name === 'typecheck');
    const root = await mkdtemp(join(tmpdir(), 'x-typecheck-bin-'));
    try {
      const ran: string[][] = [];
      const runner: Runner = async (command) => {
        ran.push([...command]);
        return { command, code: 0, ok: true, stdout: '', stderr: '', durationMs: 0 };
      };
      await step?.run({ ...ctx, root, runner });
      expect(ran.at(-1)).toEqual(['bunx', 'tsc', '-b', '--pretty', 'false']);

      await Bun.write(join(root, VERIFY_FLOOR_FILE), '{"steps":[],"typecheckBin":"tsgo"}');
      await step?.run({ ...ctx, root, runner });
      expect(ran.at(-1)).toEqual(['bunx', 'tsgo', '-b', '--pretty', 'false']);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
