// A config pin that names APP code as the reader is a claim about two other trees — the tracked
// apps — and is held to them. `defaultTimeZone` / `defaultCurrency` were pinned "read by APP code"
// while neither app read either key; nothing checked the sentence.

import { describe, expect, test } from 'bun:test';
import { checkConfigReaders, configReaderInput, readPattern } from '../config-readers';
import { appClaimGaps, claimsAppReader, configAppSources } from './config-app-readers';
import { REPO_SCAN_TIMEOUT_MS, repoRoot } from './run';

const PIN = { defaultTimeZone: 'read by APP code — a view formats with it' };
const base = { leaves: ['defaultTimeZone'], files: [{ path: 'packages/x/src/a.ts', text: '' }] };

describe('unit · a pin naming app code is checked against the tracked apps', () => {
  test('no app reading the key is X_CONFIG_READER_APP_UNREAD, naming both apps', () => {
    const gaps = checkConfigReaders({ ...base, pins: PIN, appFiles: [] });
    expect(gaps.map((gap) => [gap.kind, gap.leaf])).toEqual([['app-unread', 'defaultTimeZone']]);
  });

  test('an app property read settles the claim; the app.config.ts literal never does', () => {
    const read = [{ path: 'examples/dummy/apps/web/app/price.ts', text: 'cfg.defaultTimeZone' }];
    expect(checkConfigReaders({ ...base, pins: PIN, appFiles: read })).toEqual([]);
    const written = [{ path: 'examples/dummy/x.ts', text: "  defaultTimeZone: 'UTC',\n" }];
    expect(appClaimGaps(PIN, written, readPattern).map((gap) => gap.kind)).toEqual(['app-unread']);
  });

  test('only a pin whose sentence names app code makes the claim', () => {
    expect(claimsAppReader('read by APP code and by the validator')).toBe(true);
    expect(claimsAppReader('application code formats it')).toBe(true);
    expect(claimsAppReader('read by the CLI scaffold')).toBe(false);
    const other = { defaultTimeZone: 'read by nothing yet — slice 15 decides' };
    expect(appClaimGaps(other, [], readPattern)).toEqual([]);
  });
});

describe('the real tree', () => {
  test(
    'both tracked apps are read, minus app.config.ts, tests and installed trees',
    async () => {
      const files = await configAppSources(repoRoot());
      const paths = files.map((file) => file.path);
      expect(paths.some((path) => path.startsWith('examples/dummy/'))).toBe(true);
      expect(paths.some((path) => path.startsWith('dummy/social-media-clone/'))).toBe(true);
      expect(paths.some((path) => path.endsWith('app.config.ts'))).toBe(false);
      expect(paths.some((path) => /\.test\.tsx?$/.test(path))).toBe(false);
      expect(paths.some((path) => /(?:^|\/)node_modules\//.test(path))).toBe(false);
      const input = await configReaderInput(repoRoot());
      expect(input.appFiles?.length).toBe(files.length);
      expect(checkConfigReaders(input).filter((gap) => gap.kind === 'app-unread')).toEqual([]);
    },
    REPO_SCAN_TIMEOUT_MS,
  );
});
