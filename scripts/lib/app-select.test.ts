// `--app` narrows the app gate to one tracked app and may never narrow it to none.

import { describe, expect, test } from 'bun:test';
import { selectApps } from './app-select';
import type { GatedApp } from './gated-apps';
import { GATED_APPS } from './gated-apps';

const apps: readonly GatedApp[] = [
  { dir: 'examples/dummy', reference: './examples/dummy', expectedRed: {} },
  { dir: 'dummy/social-media-clone', reference: './dummy/social-media-clone', expectedRed: {} },
];

const dirsOf = (selected: ReturnType<typeof selectApps>): readonly string[] =>
  'code' in selected ? [`refused: ${selected.code}`] : selected.map((app) => app.dir);

describe('selectApps', () => {
  test('no flag is every app, in table order', () => {
    expect(dirsOf(selectApps(undefined, apps))).toEqual([
      'examples/dummy',
      'dummy/social-media-clone',
    ]);
  });

  test('a gated app selects that app alone', () => {
    expect(dirsOf(selectApps('dummy/social-media-clone', apps))).toEqual([
      'dummy/social-media-clone',
    ]);
  });

  test('a leading ./ and a trailing slash name the same app', () => {
    expect(dirsOf(selectApps('./examples/dummy/', apps))).toEqual(['examples/dummy']);
  });

  test('an unknown app is refused, never an empty gate, and the fix names the nearest one', () => {
    const refused = selectApps('examples/dumy', apps);

    expect('code' in refused ? refused.code : 'selected').toBe('X_CLI_BAD_FLAG');
    expect('code' in refused ? refused.cause : '').toContain('examples/dumy');
    expect('code' in refused ? refused.fix : '').toBe(
      'bun run scripts/reference-app-gate.ts --app examples/dummy',
    );
  });

  test('a bare --app is refused with a line that runs', () => {
    const refused = selectApps(true, apps);

    expect('code' in refused ? refused.code : 'selected').toBe('X_CLI_BAD_FLAG');
    expect('code' in refused ? refused.fix : '').toBe(
      'bun run scripts/reference-app-gate.ts --app examples/dummy',
    );
  });

  test('every app in the real table selects itself', () => {
    for (const app of GATED_APPS) {
      expect(dirsOf(selectApps(app.dir, GATED_APPS))).toEqual([app.dir]);
    }
  });
});
