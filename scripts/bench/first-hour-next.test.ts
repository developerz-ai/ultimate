// `data.next` off a generator's `--json` verdict, as argv: quoted words kept whole, `bunx` spelled
// `bun x`, and a verdict that cannot be read refused rather than read as "nothing to do".

import { describe, expect, test } from 'bun:test';
import { MEASURE_PAGE, nextSteps } from '../../packages/cli/src/cmd-generate';
import { argvOf, nextCommands, nextCommandsIn } from './first-hour-next';

describe('unit · first-hour next commands', () => {
  test('a quoted migration name is one word, and bunx is bun x', () => {
    expect(argvOf('bunx x db gen "create notes"')).toEqual([
      'bun',
      'x',
      'x',
      'db',
      'gen',
      'create notes',
    ]);
    expect(argvOf('bun install')).toEqual(['bun', 'install']);
    expect(argvOf('  bunx   x db migrate ')).toEqual(['bun', 'x', 'x', 'db', 'migrate']);
    expect(argvOf('x db gen ""')).toEqual(['x', 'db', 'gen', '']);
  });

  test('every command a resource generator names is runnable argv, in its order', () => {
    // The generator's own list, not a copy: the day it names another step, the bench runs it.
    const next = nextSteps(
      ['apps/web/app/note/entity.ts', 'apps/web/app/notes/page.tsx'],
      ['apps/web/package.json'],
      'notes',
    );
    const read = nextCommands(JSON.stringify({ ok: true, data: { next } }));
    expect(read).toEqual({
      ok: true,
      commands: [
        ['bun', 'install'],
        ['bun', 'x', 'x', 'db', 'gen', 'create notes'],
        ['bun', 'x', 'x', 'db', 'migrate'],
        argvOf(MEASURE_PAGE),
      ],
    });
  });

  test('no next is zero commands; output that is not the verdict is refused', () => {
    expect(nextCommands('{"ok":true,"data":{"files":[]}}')).toEqual({ ok: true, commands: [] });
    expect(nextCommands('✓ wrote 40 file(s)').ok).toBe(false);
    expect(nextCommands('{"ok":true,"data":{"next":"bunx x db migrate"}}').ok).toBe(false);
    expect(nextCommands('null')).toEqual({ ok: true, commands: [] });
  });

  test('the verdict line is found in output that carries logging after it', () => {
    const verdictLine = JSON.stringify({
      ok: true,
      command: 'g',
      data: { next: ['bunx x db migrate'] },
    });
    const output = ['{"level":"info","msg":"loaded"}', verdictLine, '{"step":"x"}', 'warn: slow'];
    expect(nextCommandsIn(output.join('\n'))).toEqual({
      ok: true,
      commands: [['bun', 'x', 'x', 'db', 'migrate']],
    });
    expect(nextCommandsIn('{"level":"info"}\nplain text').ok).toBe(false);
  });
});
