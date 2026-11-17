// The header-only test both template rules share: a rewrapped leading comment is no change, a body
// edit is, and a side git cannot show (added, removed, unreachable) always counts as a change.

import { describe, expect, test } from 'bun:test';
import type { GitRunner } from './git-fetch';
import { headerOnly } from './template-header-only';

const PATH = 'packages/cli/src/templates/route.ts';

/** A git that shows `files[ref]` for `ref:PATH`; anything else fails. */
const shower =
  (files: Record<string, string>): GitRunner =>
  async (command) => {
    const shown = files[(command[2] ?? '').split(':')[0] ?? ''];
    return {
      command,
      ok: shown !== undefined,
      code: shown === undefined ? 1 : 0,
      // As `run` answers: trailing whitespace trimmed.
      output: (shown ?? '').trimEnd(),
      durationMs: 0,
      timedOut: false,
    };
  };

const at = (header: string, body: string) => `${header}\n\nimport { x } from './x';\n${body}\n`;

describe('unit · template rules · headerOnly', () => {
  test('a rewrapped header is no change; a body edit is', async () => {
    const files = {
      a: at('// one\n// two', 'const a = 1;'),
      b: at('// one two\n//\n// three', 'const a = 1;'),
      c: at('// one two', 'const a = 2;'),
    };
    expect(await headerOnly('/r', ['a', 'b'], PATH, shower(files))).toBe(true);
    expect(await headerOnly('/r', ['a', 'c'], PATH, shower(files))).toBe(false);
  });

  test('a side git cannot show — an added or removed file — is a change', async () => {
    const files = { a: at('// one', 'const a = 1;') };
    expect(await headerOnly('/r', ['a', 'gone'], PATH, shower(files))).toBe(false);
    expect(await headerOnly('/r', ['gone', 'a'], PATH, shower(files))).toBe(false);
  });
});
