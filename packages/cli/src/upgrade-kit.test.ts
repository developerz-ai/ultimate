import { describe, expect, test } from 'bun:test';
import type { ExecResult } from './exec';
import { NO_KIT, readKit } from './upgrade-kit';

const answer = (stdout: string): ExecResult => ({
  command: [],
  code: 0,
  ok: true,
  stdout,
  stderr: '',
  durationMs: 1,
});

describe('unit · upgrade-kit reads the installed x kit', () => {
  test('a refresh document is reported with its writes and findings', () => {
    const kit = readKit(
      answer(
        JSON.stringify({
          ok: false,
          findings: [{ code: 'X_KIT_SHADOWED', cause: 'c', fix: 'f', at: 'a' }],
          data: { written: [{ path: 'p', action: 'created' }], unchanged: 3, off: ['audit'] },
        }),
      ),
    );
    expect(kit).toEqual({
      reported: true,
      written: [{ path: 'p', action: 'created' }],
      unchanged: 3,
      off: ['audit'],
      findings: [{ code: 'X_KIT_SHADOWED', cause: 'c', fix: 'f', at: 'a' }],
    });
  });

  test('a boot line ahead of the document is skipped', () => {
    const kit = readKit(answer(`booting\n${JSON.stringify({ data: { written: [] } })}`));
    expect(kit.reported).toBe(true);
  });

  test('no document, or an error document with no data.written, is unreported', () => {
    expect(readKit(answer('error: unknown command kit'))).toEqual(NO_KIT);
    expect(
      readKit(
        answer(
          JSON.stringify({
            ok: false,
            findings: [{ code: 'X_UNKNOWN_COMMAND', cause: 'c', fix: 'f' }],
          }),
        ),
      ),
    ).toEqual(NO_KIT);
  });
});
