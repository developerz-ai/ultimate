// The build error behind "logical properties only" where CSS has no logical spelling. CENTRING: a
// logical inset beside a physical percentage translate lands a whole width off-centre under
// `dir="rtl"` — centre with `inset-inline` + `margin-inline: auto`. EDGE SHADOWS: an inset shadow's
// x offset is physical, so one drawn on an inline edge needs its `[dir='rtl']` mirror.

import { describe, expect, test } from 'bun:test';
import { compileScss, compileScssFile } from '../sass-probe-fixture';

const COMPONENTS = Bun.fileURLToPath(new URL('.', import.meta.url));

/** An inline inset that places the box: anything but `auto` on either inline edge. */
const INLINE_INSET = /\binset-inline(?:-start|-end)?\s*:\s*(?!auto\s*[;}])[^;}]+/;

/** An inline-axis percentage translate, in each spelling CSS has for it. */
const PERCENT_INLINE_TRANSLATE =
  /\btranslate\s*:\s*-?[\d.]+%|\btranslateX\(\s*-?[\d.]+%|\btranslate\(\s*-?[\d.]+%|\btranslate3d\(\s*-?[\d.]+%/;

/** Why `css` mirrors wrong under RTL, or `null` when it does not. */
function rtlCentringFault(css: string): string | null {
  const inset = INLINE_INSET.exec(css);
  const shift = PERCENT_INLINE_TRANSLATE.exec(css);
  if (inset === null || shift === null) return null;
  return `"${shift[0]}" beside "${inset[0].trim()}"`;
}

describe('no component sheet centres with a translate beside a logical inset', () => {
  const sheets = [...new Bun.Glob('*.module.scss').scanSync({ cwd: COMPONENTS })].sort();

  test('the scan reaches the component sheets', () => {
    expect(sheets).toContain('Tooltip.module.scss');
    expect(sheets.length).toBeGreaterThan(40);
  });

  test('every sheet, compiled', async () => {
    const faults: string[] = [];
    for (const sheet of sheets) {
      const fault = rtlCentringFault(await compileScssFile(`${COMPONENTS}${sheet}`));
      if (fault !== null) faults.push(`${sheet}: ${fault}`);
    }
    expect(faults).toEqual([]);
  });

  test('the rule catches each spelling, and passes the centring that mirrors', async () => {
    const at = `${COMPONENTS}probe.module.scss`;
    for (const shift of [
      'translate: -50% 0',
      'transform: translateX(-50%)',
      'transform: translate(-50%, 0)',
    ]) {
      const css = await compileScss(`.a { inset-inline-start: 50%; ${shift}; }`, at);
      expect(rtlCentringFault(css)).not.toBeNull();
    }
    // Two rules, one sheet: the hover state's translate is as wrong as the base rule's.
    const split = await compileScss(
      '.a { inset-inline-start: 50%; } .a:hover { translate: -50% 0; }',
      at,
    );
    expect(rtlCentringFault(split)).not.toBeNull();
    const mirrored = await compileScss(
      '.a { inset-inline: 0; margin-inline: auto; translate: 0 4px; }',
      at,
    );
    expect(rtlCentringFault(mirrored)).toBeNull();
  });
});

/**
 * An inset shadow offset on x ONLY — a stripe on a physical left or right edge. A shadow offset
 * on both axes is a shape (`ThemeToggle`'s crescent), not an edge, and does not mirror.
 */
const INLINE_EDGE_SHADOW =
  /box-shadow:\s*inset\s+(?!0\s)(?:calc\((?:[^()]|\([^)]*\))*\)|\S+)\s+0\s[^;]*/;

describe('an inset shadow on an inline edge is mirrored for RTL', () => {
  test('every sheet that draws one also draws its [dir=rtl] mirror', async () => {
    const faults: string[] = [];
    for (const sheet of [...new Bun.Glob('*.module.scss').scanSync({ cwd: COMPONENTS })].sort()) {
      const css = await compileScssFile(`${COMPONENTS}${sheet}`);
      const edge = INLINE_EDGE_SHADOW.exec(css);
      if (edge !== null && !/\[dir=rtl\][^{]*\{[^}]*box-shadow:\s*inset/.test(css)) {
        faults.push(`${sheet}: ${edge[0]}`);
      }
    }
    expect(faults).toEqual([]);
  });
});
