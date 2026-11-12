// `x dev`'s log on disk: every line the process logger writes lands in `.x/dev.log` as well as on
// the terminal (a tee: the lanes stay core's), and the file rotates once at its cap — `logs.tail`
// reads it, and an agent loop against a dev server left up for a week must not fill the disk.

import { afterAll, expect, test } from 'bun:test';
// why: Bun has no mkdtemp and no recursive remove.
import { mkdtempSync, rmSync } from 'node:fs';
// why: Bun exposes no path-join primitive.
import { join } from 'node:path';
import { installLogSink, logger } from '@ultimat3/core';
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

test('the process logger tees into dev.log until released, and the streams still get it', async () => {
  const dir = scratch();
  const streams: string[] = [];
  const releaseStreams = installLogSink((line) => streams.push(line));
  const release = teeDevLog(dir);
  try {
    logger.info('dev.log.probe', { n: 1 });
    logger.error('dev.log.probe-error');
  } finally {
    release();
    releaseStreams();
  }
  logger.info('dev.log.after-release');
  const file = await Bun.file(join(dir, 'dev.log')).text();
  // Byte for byte what the streams were handed: one line format, written by core alone.
  expect(file).toBe(`${streams.join('\n')}\n`);
  expect(file).toContain('"msg":"dev.log.probe"');
  expect(file).not.toContain('dev.log.after-release');
});

test('a second release is a no-op, not a second close of the file', () => {
  const release = teeDevLog(scratch());
  release();
  expect(() => release()).not.toThrow();
});

test('a state directory nothing created yet is created, not refused', async () => {
  const dir = join(scratch(), 'nested', '.x');
  const log = openDevLog(dir);
  log.write('first');
  log.close();
  expect(await Bun.file(join(dir, 'dev.log')).text()).toBe('first\n');
});
