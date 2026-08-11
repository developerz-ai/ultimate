// `renderTable`, pinned by exact output. It is the one padding path behind `x jobs`, `x routes`,
// `x tasks`, `x policy` and `x i18n`, so a column that shifts here shifts five commands' rendered
// lines at once — and a consumer test asserting `toContain('nightlyPing')` would never notice.

import { describe, expect, test } from 'bun:test';
import { renderTable } from './table';

describe('unit · renderTable widths', () => {
  test('a header with no body rows renders one line, each column its own width', () => {
    expect(renderTable(['name', 'cron', 'tz'], [])).toEqual(['name  cron  tz']);
  });

  test('the HEADER sets the width when it is the widest cell in its column', () => {
    expect(
      renderTable(
        ['name', 'catchUp'],
        [
          ['a', 'skip'],
          ['bb', 'run'],
        ],
      ),
    ).toEqual(['name  catchUp', 'a     skip', 'bb    run']);
  });

  test('a BODY cell sets the width when it is the widest cell in its column', () => {
    expect(
      renderTable(
        ['name', 'tz'],
        [
          ['nightlyPing', 'America/New_York'],
          ['noop', 'UTC'],
        ],
      ),
    ).toEqual(['name         tz', 'nightlyPing  America/New_York', 'noop         UTC']);
  });
});

describe('unit · renderTable trailing space', () => {
  test('the last column is trimmed, so no line carries padding to end of line', () => {
    const lines = renderTable(
      ['id', 'description'],
      [
        ['1', 'x'],
        ['2', 'yy'],
      ],
    );
    expect(lines).toEqual(['id  description', '1   x', '2   yy']);
    for (const line of lines) expect(line).toBe(line.trimEnd());
    // Belt and braces: the assertion above passes vacuously if `renderTable` ever returns [].
    expect(lines).toHaveLength(3);
  });
});

describe('unit · renderTable ragged rows', () => {
  test('a row shorter than the header contributes no width and renders no "undefined"', () => {
    const lines = renderTable(['name', 'cron', 'tz'], [['nightlyPing'], ['noop', '@daily', 'UTC']]);
    // `cron` comes out 6 wide — `@daily`, not the 9 of a stringified `undefined`: that is the
    // `row[index] ?? ''` in the width pass. The short row renders its one cell and stops.
    expect(lines).toEqual(['name         cron    tz', 'nightlyPing', 'noop         @daily  UTC']);
    expect(lines.join('\n')).not.toContain('undefined');
  });

  test('a row LONGER than the header emits the extra cells unpadded — today’s behaviour', () => {
    const lines = renderTable(
      ['name', 'cron'],
      [
        ['a', 'b', 'x', 'end'],
        ['a', 'b', 'longer', 'end'],
      ],
    );
    // `widths` is built from the header, so `widths[index] ?? 0` pads the surplus cells to nothing
    // and they do not line up. Passing more cells than headers is a caller bug; this pins what it
    // does rather than leaving it to be discovered in rendered output.
    expect(lines).toEqual(['name  cron', 'a     b     x  end', 'a     b     longer  end']);
    expect(lines[1]?.indexOf('end')).not.toBe(lines[2]?.indexOf('end'));
  });
});
