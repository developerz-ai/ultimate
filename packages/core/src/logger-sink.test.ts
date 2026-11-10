// Where a line with no writer of its own goes: the installed sink (test seam) or the process's
// streams. Split from `logger.test.ts`, which tests what a line says; this file tests where it lands.

import { describe, expect, test } from 'bun:test';
// why: `node:process`, and unavoidable: `defaultWriter` writes to this process's own stdout/stderr, so
// proving which of the two a line lands on means intercepting those exact writers.
import process from 'node:process';
import { frozenClock } from './clock';
import { installLogSink, setLogStream, structuredLogger } from './logger';

/**
 * Which stream a line with no explicit writer lands on. It is a fact about the PROCESS, not about
 * the line: a server's stdout is its log stream (12-factor), and a CLI's stdout is the answer it
 * was asked for — `x db migrate --json` wrote `ultimate migrate applied` and then the command's
 * own JSON to fd 1, so `json.load` on the output of a command whose whole contract is `--json`
 * raised on the second object.
 */
describe('logger · the sink', () => {
  test('a default-writer line goes to the sink instead of the streams, with its level', () => {
    const got: [string, string][] = [];
    const release = installLogSink((line, level) => got.push([level, line]));
    try {
      const log = structuredLogger({
        level: 'info',
        clock: frozenClock('2026-07-26T10:00:00.000Z'),
      });
      log.debug('below the level: never written, sink or not');
      log.info('to the sink');
      log.error('errors too');
    } finally {
      release();
    }
    expect(got.map(([level]) => level)).toEqual(['info', 'error']);
    expect(JSON.parse(got[0]?.[1] ?? '{}')).toMatchObject({ level: 'info', msg: 'to the sink' });
  });

  test('a logger given its own writer never reaches the sink', () => {
    const sunk: string[] = [];
    const own: string[] = [];
    const release = installLogSink((line) => sunk.push(line));
    try {
      structuredLogger({ level: 'info', writer: (line) => own.push(line) }).info('mine');
    } finally {
      release();
    }
    expect(own).toHaveLength(1);
    expect(sunk).toEqual([]);
  });

  test('a release removes its own sink only, in any order, and the outer one serves again', () => {
    const outer: string[] = [];
    const inner: string[] = [];
    const log = structuredLogger({ level: 'info' });
    const releaseOuter = installLogSink((line) => outer.push(line));
    const releaseInner = installLogSink((line) => inner.push(line));
    try {
      log.info('one');
      // Out of order: the OUTER stops first, and the inner one still receives.
      releaseOuter();
      log.info('two');
      releaseInner();
      releaseInner();
      log.info('three');
    } finally {
      releaseInner();
      releaseOuter();
    }
    expect(inner.map((line) => JSON.parse(line).msg)).toEqual(['one', 'two']);
    expect(outer).toEqual([]);
  });

  test('installing undefined sends lines to the streams until it is released', () => {
    const sunk: string[] = [];
    const releaseSink = installLogSink((line) => sunk.push(line));
    const stdout = process.stdout.write.bind(process.stdout);
    const out: string[] = [];
    process.stdout.write = (chunk: unknown): boolean => {
      out.push(String(chunk));
      return true;
    };
    try {
      const releaseStreams = installLogSink(undefined);
      structuredLogger({ level: 'info' }).info('to the stream');
      releaseStreams();
      structuredLogger({ level: 'info' }).info('to the sink again');
    } finally {
      process.stdout.write = stdout;
      releaseSink();
    }
    expect(out.join('')).toContain('to the stream');
    expect(sunk.map((line) => JSON.parse(line).msg)).toEqual(['to the sink again']);
  });
});

describe('logger · the default writer', () => {
  const drive = (): { readonly out: string[]; readonly err: string[] } => {
    const out: string[] = [];
    const err: string[] = [];
    const stdout = process.stdout.write.bind(process.stdout);
    const stderr = process.stderr.write.bind(process.stderr);
    // Assigned rather than spied so nothing reaches the terminal during the run.
    process.stdout.write = (chunk: unknown): boolean => {
      out.push(String(chunk));
      return true;
    };
    process.stderr.write = (chunk: unknown): boolean => {
      err.push(String(chunk));
      return true;
    };
    // The streams themselves are the subject here, so the test preload's sink is lifted.
    const release = installLogSink(undefined);
    try {
      const log = structuredLogger({
        level: 'info',
        clock: frozenClock('2026-07-26T10:00:00.000Z'),
      });
      log.info('ultimate migrate applied');
      log.error('ultimate migrate failed');
    } finally {
      release();
      process.stdout.write = stdout;
      process.stderr.write = stderr;
    }
    return { out, err };
  };

  test('info is stdout by default, and stderr once the process redirects it', () => {
    const before = drive();
    expect(before.out.join('')).toContain('ultimate migrate applied');
    expect(before.err.join('')).toContain('ultimate migrate failed');
    try {
      setLogStream('stderr');
      const after = drive();
      // Nothing at all on fd 1: the whole point is that a caller can `JSON.parse` what is there.
      expect(after.out).toEqual([]);
      expect(after.err.join('')).toContain('ultimate migrate applied');
      expect(after.err.join('')).toContain('ultimate migrate failed');
    } finally {
      setLogStream('stdout');
    }
    // An error was always on stderr, and moving the stream back does not change that.
    expect(drive().out.join('')).not.toContain('ultimate migrate failed');
  });
});
