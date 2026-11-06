// The overrides load, and every primitive they turn off says why.
import { expect, unitTest } from '@ultimat3/testing';
import { exercise } from './exercise';

unitTest('apps/web/exercise.ts loads, and every off entry names its reason', () => {
  for (const [name, entry] of exercise.entries) {
    if ('off' in entry) {
      expect({ name, blank: entry.off.trim() === '' }).toEqual({ name, blank: false });
    }
  }
  expect(exercise.entries.size).toBeGreaterThan(0);
});
