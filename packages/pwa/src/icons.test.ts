import { describe, expect, test } from 'bun:test';
import { NotImplementedError, PwaIconMissingError } from './errors';
import { BunImagePipeline, ICON_MATRIX, maskableSafeZone, planIcons } from './icons';

function fixOf(error: unknown): string {
  return typeof error === 'object' && error !== null && 'fix' in error ? String(error.fix) : '';
}

describe('icon matrix', () => {
  test('covers maskable and apple touch icons, and maskables carry padding', () => {
    expect(ICON_MATRIX.some((spec) => spec.purpose === 'maskable' && spec.size === 512)).toBe(true);
    expect(ICON_MATRIX.some((spec) => spec.purpose === 'apple-touch' && spec.size === 180)).toBe(
      true,
    );
    expect(
      ICON_MATRIX.every((spec) => (spec.purpose === 'maskable' ? spec.padding > 0 : true)),
    ).toBe(true);
  });

  test('the maskable safe zone reserves 10% per edge', () => {
    expect(maskableSafeZone(512)).toEqual({ padding: 51, inner: 410 });
    expect(maskableSafeZone(192)).toEqual({ padding: 19, inner: 154 });
  });
});

describe('planIcons', () => {
  test('a missing source icon reports a fix, not a stack trace', () => {
    let fix = '';
    try {
      planIcons({});
    } catch (error) {
      fix = fixOf(error);
    }
    expect(fix).toContain('assets/icon.png');
    expect(() => planIcons({})).toThrow(PwaIconMissingError);
  });

  test('derives every output from one source icon', () => {
    const plan = planIcons({ sourceIcon: 'assets/icon.png', outDir: '/icons' });
    expect(plan.source).toBe('assets/icon.png');
    expect(plan.entries.length).toBe(ICON_MATRIX.length);
    // apple touch icons are <link> tags, never manifest members
    expect(plan.manifestIcons.length).toBe(
      ICON_MATRIX.filter((spec) => spec.purpose !== 'apple-touch').length,
    );
    expect(plan.manifestIcons.some((icon) => icon.purpose === 'maskable')).toBe(true);
    expect(plan.entries[0]?.outputPath).toBe('/icons/icon-48.png');
  });

  test('the transform driver is labelled, not silently missing', () => {
    expect(() =>
      new BunImagePipeline().resize(new Uint8Array(), { size: 512, padding: 0 }),
    ).toThrow(NotImplementedError);
  });
});
