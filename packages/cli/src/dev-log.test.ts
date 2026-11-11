// `x dev`'s log on disk: every line the process logger writes lands in `.x/dev.log` as well as on
// the terminal, and the file rotates once at its cap — `logs.tail` reads it, and an agent loop
// against a dev server left up for a week must not fill the disk.

import { afterAll, expect, test } from 'bun:test';
// why: Bun has no mkdtemp and no recursive remove.
import { mkdtempSync, rmSync } from 'node:fs';
// why: Bun exposes no path-join primitive.
import { join } from 'node:path';
import { logger } from '@ultimat3/core';
import { DEV_LOG_MAX_BYTES, devLogPath, openDevLog, teeDevLog } from './dev-log';

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const scratch = (): string => {
  const dir = mkdtempSync(join(import.meta.dir, '..', '.dev-log-fixture-'));
  dirs.push(dir);
  return dir;
};

test('the cap is 16 MiB, and the log lives in the state directory as dev.log', () => {
  expect(DEV_LOG_MAX_BYTES).toBe(16 * 1024 * 1024);
  expect(devLogPath('/s')).toBe(join('/s', 'dev.log'));
});

test('a line past the cap rotates: dev.log starts over, the old one is dev.log.1', async () => {
  const dir = scratch();
  const log = openDevLog(dir, 10);
  log.write('aaaa');
  log.write('bbbb');
  log.write('cccc');
  log.close();
  expect(await Bun.file(join(dir, 'dev.log.1')).text()).toBe('aaaa\nbbbb\n');
  expect(await Bun.file(join(dir, 'dev.log')).text()).toBe('cccc\n');
});

test('a restarted x dev appends, and counts what the file already held toward the cap', async () => {
  const dir = scratch();
  await Bun.write(join(dir, 'dev.log'), 'earlier\n');
  const log = openDevLog(dir, 12);
  log.write('next');
  log.close();
  expect(await Bun.file(join(dir, 'dev.log.1')).text()).toBe('earlier\n');
  expect(await Bun.file(join(dir, 'dev.log')).text()).toBe('next\n');
});

test('the process logger tees into dev.log until released', async () => {
  const dir = scratch();
  const terminal: string[] = [];
  const release = teeDevLog(dir, { json: false, write: (line) => terminal.push(line) });
  try {
    logger.info('dev.log.probe', { n: 1 });
  } finally {
    release();
  }
  logger.info('dev.log.after-release');
  const file = await Bun.file(join(dir, 'dev.log')).text();
  expect(file).toContain('"msg":"dev.log.probe"');
  expect(file).not.toContain('dev.log.after-release');
  // A tee, not a redirect: the terminal still gets the line.
  expect(terminal.some((entry) => entry.includes('dev.log.probe'))).toBe(true);
});

test('the terminal half keeps the logger’s lanes: errors and --json go to stderr', () => {
  const dir = scratch();
  const lanes: string[] = [];
  const release = teeDevLog(dir, {
    json: false,
    write: (_line, stream) => lanes.push(stream),
  });
  try {
    logger.info('lane.info');
    logger.error('lane.error');
  } finally {
    release();
  }
  expect(lanes).toEqual(['stdout', 'stderr']);
  const jsonLanes: string[] = [];
  const releaseJson = teeDevLog(dir, { json: true, write: (_l, stream) => jsonLanes.push(stream) });
  try {
    logger.info('lane.json');
  } finally {
    releaseJson();
  }
  expect(jsonLanes).toEqual(['stderr']);
});

test('a state directory nothing created yet is created, not refused', async () => {
  const dir = join(scratch(), 'nested', '.x');
  const log = openDevLog(dir);
  log.write('first');
  log.close();
  expect(await Bun.file(join(dir, 'dev.log')).text()).toBe('first\n');
});
