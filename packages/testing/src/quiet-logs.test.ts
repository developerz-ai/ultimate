// The preload's log routing, witnessed from a CHILD `bun test`: the level is read when core is
// first imported, so the only run that can show what `LOG_LEVEL` does is one started under it.

import { describe, expect, test } from 'bun:test';
// why: Bun ships no temp-directory primitive and no recursive delete.
import { mkdtemp, rm } from 'node:fs/promises';
// why: Bun exposes no tmpdir(); only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun ships no path-join primitive.
import { join } from 'node:path';
import { logRouting } from './quiet-logs';
import { testName } from './test-types';

const PRELOAD = join(import.meta.dir, 'quiet-logs.ts');
const CORE = join(import.meta.dir, '..', '..', 'core', 'src', 'index.ts');

/**
 * What a test asserting on log lines does — install a sink, log, restore — then two lines left
 * for the preload's own routing. `debug` is filtered out of the comparison: naming a level BELOW
 * `info` is asking for more lines, and a collecting sink is handed them too.
 */
const FIXTURE = `
import { expect, test } from 'bun:test';
import { logger, setLogSink } from ${JSON.stringify(CORE)};
test('a collecting sink sees info and above whatever LOG_LEVEL names', () => {
  const seen = [];
  const previous = setLogSink((_line, level) => seen.push(level));
  try {
    logger.debug('d'); logger.info('i'); logger.warn('w'); logger.error('e');
  } finally {
    setLogSink(previous);
  }
  expect(seen.filter((level) => level !== 'debug')).toEqual(['info', 'warn', 'error']);
  // The variable a spawned child inherits is the one the author named, not the pin.
  expect(process.env.LOG_LEVEL ?? '(unset)').toBe(process.env.EXPECT_LOG_LEVEL);
  logger.info('terminal-info');
  logger.error('terminal-error');
});
`;

const run = async (level: string | undefined): Promise<{ code: number; output: string }> => {
  const dir = await mkdtemp(join(tmpdir(), 'ultimate-quiet-logs-'));
  try {
    await Bun.write(join(dir, 'bunfig.toml'), `[test]\npreload = [${JSON.stringify(PRELOAD)}]\n`);
    await Bun.write(join(dir, 'lines.test.ts'), FIXTURE);
    const { LOG_LEVEL: _ambient, ...env } = process.env;
    const child = Bun.spawn(['bun', 'test', './lines.test.ts'], {
      cwd: dir,
      env: {
        ...env,
        ...(level === undefined ? {} : { LOG_LEVEL: level }),
        EXPECT_LOG_LEVEL: level ?? '(unset)',
      },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const output = `${await new Response(child.stdout).text()}${await new Response(child.stderr).text()}`;
    return { code: await child.exited, output };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};

describe(testName('unit', 'the preload routes the process logger'), () => {
  test('with no LOG_LEVEL, a green run prints no log line and a collecting sink still collects', async () => {
    const { code, output } = await run(undefined);
    expect(code).toBe(0);
    expect(output).not.toContain('terminal-');
  }, 20_000);

  test('LOG_LEVEL=error shows only errors — and a collecting sink still sees info and warn', async () => {
    const { code, output } = await run('error');
    // Exit 0 IS the assertion on the sink: under the old read the logger's own threshold was
    // `error`, so the collector saw one line and five MCP audit tests failed for an env var.
    expect(code).toBe(0);
    expect(output).toContain('terminal-error');
    expect(output).not.toContain('terminal-info');
  }, 20_000);

  test('LOG_LEVEL=info is the escape hatch: the lines reach the terminal', async () => {
    const { code, output } = await run('info');
    expect(code).toBe(0);
    expect(output).toContain('terminal-info');
    expect(output).toContain('terminal-error');
  }, 20_000);

  test('LOG_LEVEL=debug is honoured as named: more lines, on the terminal and in a sink', async () => {
    const { code, output } = await run('debug');
    expect(code).toBe(0);
    expect(output).toContain('terminal-info');
  }, 20_000);
});

describe(testName('unit', 'logRouting'), () => {
  test('unset or empty drops every line and leaves the level alone', () => {
    expect(logRouting(undefined)).toEqual({ lines: 'dropped' });
    expect(logRouting('')).toEqual({ lines: 'dropped' });
  });

  test('info and below are core’s own to print, exactly as named', () => {
    for (const level of ['trace', 'debug', 'info']) {
      expect(logRouting(level)).toEqual({ lines: 'printed' });
    }
  });

  test('a level above info is a filter on the terminal, never the logger’s threshold', () => {
    for (const level of ['warn', 'error', 'fatal', 'silent'] as const) {
      expect(logRouting(level)).toEqual({ lines: 'filtered', from: level });
    }
  });

  test('a value that is no level is what core reads it as: info, printed', () => {
    expect(logRouting('loud')).toEqual({ lines: 'printed' });
  });
});
