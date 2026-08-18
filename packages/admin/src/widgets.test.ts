// A calendar date has no zone, so the admin must render the day the column stores in every zone
// the operator's machine happens to be in. `bun test` pins the process to UTC, where the bug and
// the fix are indistinguishable — so this asks a subprocess in `America/Los_Angeles`.

import { describe, expect, test } from 'bun:test';
// `node:path` — Bun has no path joiner; the subprocess needs the repo root as its cwd, and its
// imports have to be RELATIVE paths: a bare `@ultimat3/ui` from `bun -e` resolves against
// `[eval]`, which is not a file and walks no node_modules.
import { join } from 'node:path';
import { dateTimeView } from '@ultimat3/ui';
import { formatCalendarDate } from './widgets';

const REPO_ROOT = join(import.meta.dir, '..', '..', '..');

/** The one value under test: a `date()` column's row value is exactly this string. */
const STORED = '2026-08-18';

/**
 * Read in the subprocess, never here. Two numbers, and both matter: `control` proves the child
 * really is west of UTC (a plain `new Date('2026-08-18')` is the 17th there), and `text` is what
 * the admin renders. Without the control a green run could mean the TZ never took.
 */
const PROBE = `
const { dateTimeView } = await import('./packages/ui/src/components/date-time-view');
const { formatCalendarDate } = await import('./packages/admin/src/widgets');
const view = dateTimeView({
  value: '${STORED}',
  locale: 'en-US',
  timeZone: 'America/Los_Angeles',
  format: formatCalendarDate,
});
console.log(JSON.stringify({ control: new Date('${STORED}').getDate(), text: view.text }));
`;

async function renderIn(timeZone: string): Promise<{ control: number; text: string }> {
  const child = Bun.spawn(['bun', '-e', PROBE], {
    cwd: REPO_ROOT,
    env: { ...process.env, TZ: timeZone },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [out, err] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  await child.exited;
  const line = out.trim().split('\n').at(-1) ?? '';
  if (line === '') throw new Error(`the probe printed nothing; stderr: ${err}`);
  return JSON.parse(line) as { control: number; text: string };
}

describe('unit · a calendar date renders the day it stores', () => {
  test('a viewer in America/Los_Angeles reads the 18th, not the 17th', async () => {
    const { control, text } = await renderIn('America/Los_Angeles');
    // The control: the host zone really is west of UTC in the child, so a value formatted in
    // it WOULD move. This is the assertion that makes the next one able to fail.
    expect(control).toBe(17);
    expect(text).toBe('Aug 18, 2026');
  }, 30_000);

  // The other half of the same rule: nothing about the fix depends on the runner being UTC.
  test('and in-process, where bun test pins the clock zone to UTC, it is the same day', () => {
    const view = dateTimeView({
      value: STORED,
      locale: 'en-US',
      timeZone: 'America/Los_Angeles',
      format: formatCalendarDate,
    });
    expect(view.text).toBe('Aug 18, 2026');
    // The machine-readable half is untouched: `<time datetime>` stays the UTC instant.
    expect(view.dateTime).toBe('2026-08-18T00:00:00.000Z');
  });
});
