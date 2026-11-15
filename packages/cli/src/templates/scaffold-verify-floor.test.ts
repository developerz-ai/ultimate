// Every scaffold's `x.verify.json` accounts for all of the gate: each step is either required in
// `steps` or excused in `skip` with a written why — never neither. A new gate step fails here until
// the scaffold runs it or says why it cannot, so a fresh app is never silently missing one.

import { describe, expect, test } from 'bun:test';
import { planNewApp } from '../cmd-new';
import { NEW_SHAPES } from '../new-shapes';
import { belongsToType } from '../test-select';
import { parseVerifyFloor, VERIFY_FLOOR_FILE } from '../verify-floor';
import { VERIFY_STEP_NAMES } from '../verify-step';
import { readStrict } from '../verify-strict';

const variants = [
  { name: 'x new', files: planNewApp({ name: 'demo-app', example: true }) },
  { name: 'x new --no-example', files: planNewApp({ name: 'demo-app', example: false }) },
  ...NEW_SHAPES.map((shape) => ({
    name: `x new --shape ${shape}`,
    files: planNewApp({ name: 'demo-app', example: true, shape }),
  })),
];

const floorOf = (files: readonly { path: string; contents: unknown }[]) => {
  const text = String(files.find((file) => file.path === VERIFY_FLOOR_FILE)?.contents);
  const payload: unknown = JSON.parse(text);
  const record = typeof payload === 'object' && payload !== null ? payload : {};
  return {
    floor: parseVerifyFloor(text),
    strict: readStrict(record as Record<string, unknown>, VERIFY_STEP_NAMES),
  };
};

describe('unit · x new · the floor names every gate step', () => {
  for (const variant of variants) {
    test(`${variant.name}: each step is required or excused with a why, never both`, () => {
      const { floor, strict } = floorOf(variant.files);
      expect([...floor.problems, ...strict.problems]).toEqual([]);
      const excused = Object.keys(strict.skip ?? {});
      expect([...floor.steps, ...excused].toSorted()).toEqual([...VERIFY_STEP_NAMES].toSorted());
      expect(floor.steps.filter((step) => excused.includes(step))).toEqual([]);
    });

    test(`${variant.name}: a required typed suite ships a file, an excused one ships none`, () => {
      const { floor } = floorOf(variant.files);
      for (const type of ['contract', 'live', 'job', 'e2e'] as const) {
        const shipped = variant.files.some((file) => belongsToType(file.path, type));
        expect([type, shipped]).toEqual([type, floor.steps.includes(type)]);
      }
    });
  }

  test('live and e2e are required in both the example and the bare scaffold', () => {
    for (const variant of variants.slice(0, 2)) {
      const { floor } = floorOf(variant.files);
      expect([variant.name, floor.steps.includes('live'), floor.steps.includes('e2e')]).toEqual([
        variant.name,
        true,
        true,
      ]);
    }
  });

  test('every scaffold is strict: a step that runs nothing is red unless its skip says why', () => {
    for (const variant of variants) {
      expect([variant.name, floorOf(variant.files).strict.strict]).toEqual([variant.name, true]);
    }
  });

  test('roadmap is excused everywhere: only the framework repository ships its file', () => {
    for (const variant of variants) {
      expect(floorOf(variant.files).strict.skip?.['roadmap']).toContain('docs/idea/14-roadmap.md');
    }
  });
});
