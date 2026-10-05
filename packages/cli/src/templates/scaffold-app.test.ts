// The app files `x new` writes, held to what they do on every host. The emitted
// `apps/web/shared/global.test.ts` named its stylesheet by splitting a HOST path on `/`, so on
// Windows (`D:\…\apps\web\shared\global.scss`) the scaffold's own first `bun run check` was red.

import { describe, expect, test } from 'bun:test';
import { names } from './naming';
import { appFiles } from './scaffold-app';

const globalTest = (): string => {
  const file = appFiles(names('ledger-demo'), true).find(
    (one) => one.path === 'apps/web/shared/global.test.ts',
  );
  if (typeof file?.contents !== 'string') {
    return expect.unreachable('x new writes apps/web/shared/global.test.ts, as text');
  }
  return file.contents;
};

/** The emitted mapping from a registered sheet to the name it is compared by, as a function. */
const sheetName = (): ((sheet: { readonly file: string }) => string) => {
  const expression = /sheets\.map\(\((sheet)\) => (sheet\.file[^\n]*?)\)\)\.toEqual/.exec(
    globalTest(),
  );
  if (expression?.[2] === undefined) return expect.unreachable('global.test.ts maps sheet.file');
  // The test's own source, evaluated: the claim is what the emitted line DOES with a path.
  return new Function('sheet', `return ${expression[2]};`) as (sheet: {
    readonly file: string;
  }) => string;
};

describe('unit · the scaffold global stylesheet test', () => {
  test('a Windows sheet path is named like a Linux one', () => {
    const name = sheetName();
    expect(name({ file: 'D:\\a\\_temp\\winapp\\apps\\web\\shared\\global.scss' })).toBe(
      'web/shared/global.scss',
    );
    expect(name({ file: '/srv/winapp/apps/web/shared/global.scss' })).toBe(
      'web/shared/global.scss',
    );
  });
});
