// The argv `x pr review` sends when no `--pr` is given. `gh pr view --repo <slug>` with no number,
// url or branch is refused by gh itself ("argument required when using the --repo flag") before
// any network call — so "this branch's own pull request" could never resolve.

import { describe, expect, test } from 'bun:test';
import type { ExecResult, Runner } from './exec';
import { resolvePrNumber } from './gh-target';

const REPO = { owner: 'developerz-ai', name: 'ultimate', slug: 'developerz-ai/ultimate' };

/** Answers like gh 2.95 does: `--repo` with no selector is a usage error, exit 1. */
const ghLike = (ran: string[][]): Runner => {
  return async (command): Promise<ExecResult> => {
    ran.push([...command]);
    const refused =
      command.includes('--repo') && command[1] === 'pr' && command[3]?.startsWith('-') === true;
    return {
      command,
      code: refused ? 1 : 0,
      ok: !refused,
      stdout: refused ? '' : '{"number":241}',
      stderr: refused ? 'argument required when using the --repo flag' : '',
      durationMs: 1,
    };
  };
};

describe('unit · the no-number lookup asks gh a question gh will answer', () => {
  test('it is the checkout-scoped gh pr view, with no --repo and no selector', async () => {
    const ran: string[][] = [];
    expect(await resolvePrNumber({ runner: ghLike(ran), cwd: '/repo' }, REPO)).toBe(241);
    expect(ran).toEqual([['gh', 'pr', 'view', '--json', 'number']]);
  });
});
