import { describe, expect, test } from 'bun:test';
import { asElement, FakeHost, FakeRoot } from './fake-host-fixture';
import { cssRgb, parseChannels, resolvePalette } from './palette';

describe('unit · palette', () => {
  test("a role token's channel form reads as 0..1 channels", () => {
    expect(parseChannels(' 255 0 51 ')).toEqual([1, 0, 0.2]);
    expect(parseChannels('255, 0, 51')).toEqual([1, 0, 0.2]);
  });

  test('anything but three channels in 0..255 is no colour', () => {
    for (const text of ['', '1 2', '1 2 3 4', '300 0 0', 'red', '1 x 3']) {
      expect(parseChannels(text)).toBeUndefined();
    }
  });

  test('a palette resolves every role, or none when one is unset', () => {
    const host = new FakeHost();
    host.vars = (name) => (name === '--color-accent' ? '0 0 255' : '');
    const root = asElement(new FakeRoot());
    expect(resolvePalette(host, root, ['accent'])).toEqual([[0, 0, 1]]);
    expect(resolvePalette(host, root, ['accent', 'info'])).toBeUndefined();
  });

  test('a canvas fill is built from resolved channels', () => {
    expect(cssRgb([1, 0.5, 0], 0.25)).toBe('rgb(255 128 0 / 0.25)');
  });
});
