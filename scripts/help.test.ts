// `bun run scripts/help.ts --json` is how an agent discovers what this repo can do to itself, so a
// missing command here is a command that does not exist as far as the reader is concerned.

import { describe, expect, test } from 'bun:test';
import { VERIFY_STEP_NAMES } from '@ultimat3/cli';
import { SCRIPTS } from './help';

const does = (command: string): string | undefined =>
  SCRIPTS.find((entry) => entry.command === command)?.does;

describe('unit · the script catalogue', () => {
  // It said "all 16 steps" while `VERIFY_STEP_NAMES` and CLAUDE.md both said 17. 18 as of 4.0.0,
  // when `seo` was mounted — the literal below is the deliberate half: adding a step must be an
  // edit here too, so no step joins the gate without somebody counting.
  test('the step count is projected from the step list, never restated', () => {
    expect(does('bun run scripts/verify.ts')).toContain(`all ${VERIFY_STEP_NAMES.length} steps`);
    expect(VERIFY_STEP_NAMES.length).toBe(18);
  });

  // The app gate is a headline command in CLAUDE.md and was absent, so an agent reading this
  // catalogue never learned the two tracked apps are gated at all.
  test('every script a contributor is told to run is listed', () => {
    for (const command of [
      'bun run scripts/reference-app-gate.ts',
      'bun run scripts/roadmap.ts',
      'bun run scripts/trust-publishers.ts',
      'bun run scripts/boundaries.ts',
      'bun run scripts/manifest.ts',
    ]) {
      expect(does(command), `${command} is missing from SCRIPTS`).toBeDefined();
    }
  });

  test('every entry names a distinct command and says what it does', () => {
    expect(new Set(SCRIPTS.map((entry) => entry.command)).size).toBe(SCRIPTS.length);
    for (const entry of SCRIPTS) expect(entry.does.length).toBeGreaterThan(10);
  });
});
