// The enforcement half of `scripts/log-levels.ts`: the gate's `unit` step runs every
// `scripts/**/*.test.ts`, so a new unannotated `info` on a per-unit path above its package pin
// fails `bun run verify` here. Fixtures prove each shape; the last block holds the real tree.

import { describe, expect, setDefaultTimeout, test } from 'bun:test';
// why: Bun exposes no path-join primitive.
import { join } from 'node:path';
import { LOG_LEVEL_PINS, LOG_LEVEL_PINS_FILE } from './lib/log-levels-pins';
import { REPO_SCAN_TIMEOUT_MS, repoRoot } from './lib/run';
import {
  checkLogLevels,
  logLevelFindingFor,
  logLevelGaps,
  PER_UNIT_FILES,
  scanInfoLines,
} from './log-levels';

setDefaultTimeout(REPO_SCAN_TIMEOUT_MS);

const PER_REQUEST = 'packages/http/src/pipeline.ts';

const sites = (path: string, source: string): readonly string[] =>
  scanInfoLines(path, source).map((site) => `${String(site.line)}:${site.event}`);

describe('an info line on a per-unit path', () => {
  test('logger.info and log.info are findings, with the event they write', () => {
    const source = [
      "logger.info('http.request.served', { route });",
      'ctx.log.info(`mcp.auth.missing`, line);',
      "logger\n  .info('jobs.fired', {});",
    ].join('\n');
    expect(sites(PER_REQUEST, source)).toEqual([
      '1:http.request.served',
      '2:mcp.auth.missing',
      '3:jobs.fired',
    ]);
  });

  test('a computed level on a logger is a finding: it may be info, and nothing reads which', () => {
    const source = [
      'ctx.logger[level](facts.code, {});',
      "logger['info']('http.request.served', {});",
      "ctx.log?.[level]('jobs.fired');",
      'ctx.logger\n  [level](`a`);',
    ].join('\n');
    expect(sites(PER_REQUEST, source)).toEqual([
      '1:?',
      '2:http.request.served',
      '3:jobs.fired',
      '4:a',
    ]);
  });

  test('a computed member that is literally another level is not, nor is another object', () => {
    const source = [
      "logger['debug']('a', {});",
      'ctx.log?.["warn"](`b`);',
      'blog[level](x);',
      'catalog.info(x);',
    ].join('\n');
    expect(sites(PER_REQUEST, source)).toEqual([]);
  });

  test('an alias is a finding: the value written to it is the same line', () => {
    expect(sites(PER_REQUEST, 'const write = logger[level];\nconst say = log.info;')).toEqual([
      '1:?',
      '2:?',
    ]);
  });

  test('an `// info: <why>` on the line or the one above answers it', () => {
    expect(sites(PER_REQUEST, "// info: a catch-up is news\nlogger.info('a', {});")).toEqual([]);
    expect(sites(PER_REQUEST, "logger.info('a', {}); // info: once per boot")).toEqual([]);
  });

  test('an empty `// info:` answers nothing, and neither does one two lines up', () => {
    expect(sites(PER_REQUEST, "// info:\nlogger.info('a', {});")).toEqual(['2:a']);
    expect(sites(PER_REQUEST, "// info: why\n\nlogger.info('a', {});")).toEqual(['3:a']);
  });

  test('debug and warn, a comment, a string and a file off the list are not', () => {
    expect(sites(PER_REQUEST, "logger.debug('a', {});\nlogger.warn('b', {});")).toEqual([]);
    expect(sites(PER_REQUEST, "// logger.info('a');\nconst s = \"logger.info('b')\";")).toEqual([]);
    expect(sites('packages/http/src/boot-banner.ts', "logger.info('a', {});")).toEqual([]);
  });
});

describe('the ratchet', () => {
  const site = { path: PER_REQUEST, line: 4, event: 'http.request.served' };

  test('a package over its pin is X_LOG_LEVEL_UNSTATED, naming the site and both repairs', () => {
    const [gap] = checkLogLevels([site], {}, true);
    const finding = logLevelFindingFor(gap ?? expect.unreachable());
    expect(finding.code).toBe('X_LOG_LEVEL_UNSTATED');
    expect(finding.cause).toContain(`${PER_REQUEST}:4 (http.request.served)`);
    expect(finding.fix).toContain('logger.debug');
    expect(finding.fix).toContain('// info:');
  });

  test('a pin above the count is stale, and names the unpin command', () => {
    const [gap] = checkLogLevels([], { http: { count: 1, reason: 'why: x' } }, true);
    const finding = logLevelFindingFor(gap ?? expect.unreachable());
    expect(finding.code).toBe('X_LOG_LEVEL_PIN_STALE');
    expect(finding.fix).toBe('bun run scripts/log-levels.ts --unpin http');
  });

  test('a blank reason is unexplained and waives nothing', () => {
    const gaps = checkLogLevels([site], { http: { count: 1, reason: ' ' } }, true);
    expect(gaps.map((gap) => logLevelFindingFor(gap).code).sort()).toEqual([
      'X_LOG_LEVEL_PIN_UNEXPLAINED',
      'X_LOG_LEVEL_UNSTATED',
    ]);
    expect(logLevelFindingFor(gaps[0] ?? expect.unreachable()).at).toBeDefined();
    expect(LOG_LEVEL_PINS_FILE).toBe('scripts/lib/log-levels-pins.ts');
  });
});

describe('the real tree', () => {
  test('every listed per-unit file exists: a rename must move the list with it', async () => {
    const missing: string[] = [];
    for (const path of PER_UNIT_FILES.keys()) {
      if (!(await Bun.file(join(repoRoot(), path)).exists())) missing.push(path);
    }
    expect(missing).toEqual([]);
  });

  test('no package writes an unstated info line on a per-unit path past its pin', async () => {
    const gaps = await logLevelGaps(repoRoot());
    // fix: demote the line to logger.debug, or state `// info: <why>` above it; a pin only falls.
    expect(gaps.map(logLevelFindingFor)).toEqual([]);
    expect(Object.keys(LOG_LEVEL_PINS).length).toBeGreaterThan(0);
  });
});
