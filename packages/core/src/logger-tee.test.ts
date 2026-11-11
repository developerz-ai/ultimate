// Single responsibility: pins `teeLogLines` — a copy of every process-logger line beside the
// streams, never instead of them: tees stack, each release removes only its own, and a throwing
// tee costs nothing but its own copy.
import { expect, test } from 'bun:test';
import { installLogSink, type LogLevel, logger, structuredLogger, teeLogLines } from './logger';

/** Collect what the streams would have received, for the span of `run`. */
function streams(run: () => void): string[] {
  const got: string[] = [];
  const release = installLogSink((line) => got.push(line));
  try {
    run();
  } finally {
    release();
  }
  return got;
}

test('a tee gets every process-logger line, with its level, and the streams still get it', () => {
  const teed: [LogLevel, string][] = [];
  const release = teeLogLines((line, level) => teed.push([level, line]));
  const written = streams(() => {
    try {
      logger.info('tee.probe');
      logger.error('tee.probe.error');
    } finally {
      release();
    }
  });
  expect(teed.map(([level]) => level)).toEqual(['info', 'error']);
  expect(teed.map(([, line]) => line)).toEqual(written);
  expect(written[0]).toContain('"msg":"tee.probe"');
});

test('two tees both get the line, and each release removes only its own', () => {
  const first: string[] = [];
  const second: string[] = [];
  const releaseFirst = teeLogLines((line) => first.push(line));
  const releaseSecond = teeLogLines((line) => second.push(line));
  streams(() => {
    logger.info('tee.both');
    releaseFirst();
    logger.info('tee.second-only');
    releaseSecond();
    logger.info('tee.none');
  });
  expect(first.length).toBe(1);
  expect(second.length).toBe(2);
  expect(second.join('\n')).not.toContain('tee.none');
});

test('a tee that throws loses its own copy, never the caller’s call or another tee’s', () => {
  const kept: string[] = [];
  const releaseThrowing = teeLogLines(() => {
    expect.unreachable('a tee that cannot write its copy (a full disk)');
  });
  const releaseKept = teeLogLines((line) => kept.push(line));
  try {
    const written = streams(() => logger.warn('tee.survives'));
    expect(written.length).toBe(1);
  } finally {
    releaseThrowing();
    releaseKept();
  }
  expect(kept.length).toBe(1);
});

test('a logger given its own writer never reaches a tee', () => {
  const teed: string[] = [];
  const release = teeLogLines((line) => teed.push(line));
  try {
    structuredLogger({ level: 'info', writer: () => undefined }).info('tee.own-writer');
  } finally {
    release();
  }
  expect(teed).toEqual([]);
});
