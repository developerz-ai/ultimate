// The shared scale: the typed snap API D1 imports, and the text the guards embed, held to each other.

import { describe, expect, test } from 'bun:test';
import {
  MOTION_DURATIONS,
  MOTION_EASINGS,
  MOTION_SCALE_SOURCE,
  snapDuration,
  snapEasing,
} from './motion-scale';

/** The embedded text, run: types stripped by Bun's own transpiler, then evaluated. */
async function embedded(): Promise<{
  readonly durationFor: (ms: number) => string;
  readonly easingFor: (curve: string) => string;
  readonly DURATIONS: unknown;
  readonly EASINGS: unknown;
}> {
  const js = new Bun.Transpiler({ loader: 'ts' }).transformSync(
    `${MOTION_SCALE_SOURCE}\nexport { durationFor, easingFor };`,
  );
  const url = `data:text/javascript;base64,${Buffer.from(js).toString('base64')}`;
  return (await import(url)) as Awaited<ReturnType<typeof embedded>>;
}

describe('unit · motion-scale', () => {
  test('a duration snaps to the nearest rung, exact where it is one, never to instant', () => {
    expect(snapDuration(120)).toBe('fast');
    expect(snapDuration(300)).toBe('base');
    expect(snapDuration(2400)).toBe('slower');
    expect(snapDuration(1)).toBe('fast');
    expect(snapDuration(0)).toBe('fast');
  });

  test('an easing snaps to the nearest curve, from a string or its points', () => {
    expect(snapEasing('0.65, 0, 0.35, 1')).toBe('in-out');
    expect(snapEasing([0.5, 0, 0.75, 0])).toBe('in');
    expect(snapEasing('0.34,1.5,0.6,1')).toBe('spring');
    expect(snapEasing('0.2, 0.9, 0.3, 1')).toBe('out');
  });

  test('the embedded text answers exactly what the typed functions do', async () => {
    const text = await embedded();
    for (let ms = 0; ms <= 1500; ms += 7) expect(text.durationFor(ms)).toBe(snapDuration(ms));
    for (const curve of ['0.2,0,0,1', '0.4, 0, 0.2, 1', '0.5,0,0.75,0', '1,1,1,1', '0,0,1,1']) {
      expect(text.easingFor(curve)).toBe(snapEasing(curve));
    }
    expect(text.DURATIONS).toEqual(MOTION_DURATIONS.map((row) => [...row]));
    expect(text.EASINGS).toEqual({ ...MOTION_EASINGS });
  });
});
