import { describe, expect, test } from 'bun:test';
import { UI_INSPECT_LIMITS } from '@ultimat3/mcp';
import { inspectExpression, parseInspectProbe } from './ui-inspect-probe';

const SPEC = { selectors: ['h1', '.card'], styles: ['color', 'font-size'], activeElement: true };

describe('unit · inspectExpression is deterministic, so a recording can key on it', () => {
  test('the same spec yields the same string, and a different spec a different one', () => {
    expect(inspectExpression(SPEC)).toBe(inspectExpression({ ...SPEC }));
    expect(inspectExpression(SPEC)).not.toBe(inspectExpression({ ...SPEC, activeElement: false }));
    expect(inspectExpression(SPEC)).not.toBe(inspectExpression({ ...SPEC, styles: [] }));
  });

  test('selectors and style names ride in as JSON, so a quote in a selector cannot escape', () => {
    const expression = inspectExpression({
      selectors: ['a[href="x"]', "'"],
      styles: [],
      activeElement: false,
    });
    expect(expression).toContain(JSON.stringify(['a[href="x"]', "'"]));
    expect(expression).toContain('var A=false;');
  });

  test('every in-page cap is the shared one, spelled from UI_INSPECT_LIMITS', () => {
    const expression = inspectExpression(SPEC);
    expect(expression).toContain(`j<${UI_INSPECT_LIMITS.matches}`);
    expect(expression).toContain(`slice(0,${UI_INSPECT_LIMITS.textChars})`);
    expect(expression).toContain(`i<${UI_INSPECT_LIMITS.attrs}`);
    // An unparsable selector is caught in the page, not thrown at the driver.
    expect(expression).toContain('try{els=document.querySelectorAll(sel);}catch');
  });
});

const MATCH = {
  tag: 'h1',
  text: 'Hello',
  box: { x: 0, y: 0, width: 100, height: 20 },
  visible: true,
  attrs: { class: 'title' },
  styles: { color: 'rgb(0, 0, 0)' },
};

const PROBE = {
  title: 'Dash',
  theme: null,
  activeElement: { tag: 'body', id: '', role: '', name: '' },
  selectors: [{ selector: 'h1', valid: true, count: 1, truncated: false, matches: [MATCH] }],
};

describe('unit · parseInspectProbe refuses what does not fit', () => {
  test('a well-formed answer parses, empty strings and a null theme included', () => {
    const parsed = parseInspectProbe(PROBE);
    expect(parsed?.title).toBe('Dash');
    expect(parsed?.theme).toBeNull();
    expect(parsed?.selectors[0]?.matches[0]?.styles).toEqual({ color: 'rgb(0, 0, 0)' });
    expect(parseInspectProbe({ ...PROBE, theme: '', activeElement: null })?.theme).toBe('');
  });

  test('a malformed answer is null, never a throw and never a cast', () => {
    expect(parseInspectProbe(null)).toBeNull();
    expect(parseInspectProbe('{"title":"x"}')).toBeNull();
    expect(parseInspectProbe({ ...PROBE, selectors: 'h1' })).toBeNull();
    expect(
      parseInspectProbe({
        ...PROBE,
        selectors: [{ selector: 'h1', valid: 'yes', count: 1, truncated: false, matches: [] }],
      }),
    ).toBeNull();
    expect(
      parseInspectProbe({
        ...PROBE,
        selectors: [
          { selector: 'h1', valid: true, count: 1, truncated: false, matches: [{ tag: 'h1' }] },
        ],
      }),
    ).toBeNull();
  });
});
