// A V8 stack read as the monitor's frames: oldest first, the app's own marked in-app, and never a
// throw — this runs inside the catch of every failure path, on a string nobody validated.

import { describe, expect, test } from 'bun:test';
import { UltimateError } from './errors';
import { sentryFrames, stackFrames } from './sentry-frames';

const ROOT = process.cwd();

const stack = [
  'Error: row missing',
  `    at loadRow (${ROOT}/src/rows.ts:10:9)`,
  `    at async handle (file://${ROOT}/src/handler.ts:22:3)`,
  `    at decode (${ROOT}/node_modules/some-lib/index.js:1:2)`,
  `    at run (${ROOT}/node_modules/@ultimat3/http/src/serve.ts:4:4)`,
  '    at processTicksAndRejections (native:7:39)',
].join('\n');

describe('sentryFrames', () => {
  test('oldest first: the throw site is the LAST frame, as the protocol orders them', () => {
    const frames = sentryFrames(stack);
    expect(frames.map((frame) => frame.function)).toEqual([
      'processTicksAndRejections',
      'run',
      'decode',
      'handle',
      'loadRow',
    ]);
  });

  test('filename is root-relative with no position; line and column are numbers', () => {
    const top = sentryFrames(stack).at(-1);
    expect(top).toEqual({
      function: 'loadRow',
      filename: 'src/rows.ts',
      abs_path: `${ROOT}/src/rows.ts`,
      lineno: 10,
      colno: 9,
      in_app: true,
    });
    expect(sentryFrames(stack).at(-2)).toMatchObject({
      function: 'handle',
      filename: 'src/handler.ts',
      abs_path: `${ROOT}/src/handler.ts`,
    });
  });

  test('in_app is false for node_modules, @ultimat3 and the runtime', () => {
    expect(sentryFrames(stack).map((frame) => frame.in_app)).toEqual([
      false,
      false,
      false,
      true,
      true,
    ]);
    const workspace = `Error\n    at serve (${ROOT}/packages/x/@ultimat3/core/src/a.ts:1:1)`;
    expect(sentryFrames(workspace)[0]?.in_app).toBe(false);
  });

  test('a file at the app root is in-app; a runtime frame is not', () => {
    const frames = sentryFrames(
      `Error\n    at boot (${ROOT}/server.ts:3:7)\n    at processTicksAndRejections (native:7:39)`,
    );
    expect(frames.map((frame) => [frame.filename, frame.in_app])).toEqual([
      ['native', false],
      ['server.ts', true],
    ]);
  });

  test('an anonymous frame has a filename and no function', () => {
    const [frame] = sentryFrames(`Error\n    at ${ROOT}/src/rows.ts:10:9`);
    expect(frame).toEqual({
      filename: 'src/rows.ts',
      abs_path: `${ROOT}/src/rows.ts`,
      lineno: 10,
      colno: 9,
      in_app: true,
    });
  });

  test('a Windows path keeps its drive and splits off the position', () => {
    const [frame] = sentryFrames('Error\n    at load (C:\\app\\src\\rows.ts:10:9)');
    expect(frame).toMatchObject({ filename: 'C:/app/src/rows.ts', lineno: 10, colno: 9 });
  });

  test('a message holding an `at` line is not a frame: only the trailing run is read', () => {
    const forged = `Error: boom\n    at forged (${ROOT}/src/forged.ts:1:1)\nmore text\n    at real (${ROOT}/src/real.ts:2:2)`;
    expect(sentryFrames(forged).map((frame) => frame.function)).toEqual(['real']);
  });

  test('a real throw parses to frames whose last one is this file', () => {
    const thrown = new UltimateError({ code: 'X_FRAME_FIXTURE', cause: 'probe', fix: 'x doctor' });
    const frames = sentryFrames(thrown.stack);
    expect(frames.length).toBeGreaterThan(0);
    expect(frames.at(-1)?.filename).toBe('packages/core/src/sentry-frames.test.ts');
  });

  test('a stack with more frames than the cap keeps the newest, the throw site', () => {
    const deep = [
      'Error',
      ...Array.from({ length: 300 }, (_, i) => `    at f${i} (${ROOT}/src/a.ts:${i + 1}:1)`),
    ].join('\n');
    const frames = sentryFrames(deep);
    expect(frames.length).toBe(100);
    expect(frames.at(-1)?.function).toBe('f0');
  });

  test('never throws: undefined, a non-string, a header alone, a hostile toString', () => {
    expect(sentryFrames(undefined)).toEqual([]);
    expect(sentryFrames(42)).toEqual([]);
    expect(sentryFrames('Error: only a header')).toEqual([]);
    expect(sentryFrames('')).toEqual([]);
    const hostile = {
      toString(): never {
        throw new UltimateError({ code: 'X_FRAME_FIXTURE', cause: 'refused', fix: 'x doctor' });
      },
    };
    expect(sentryFrames(hostile)).toEqual([]);
  });
});

describe('stackFrames', () => {
  test('newest first, the order V8 prints, with `new` and `async` stripped from the name', () => {
    const frames = stackFrames(
      `Error\n    at new Repo (${ROOT}/src/repo.ts:1:2)\n    at async main (${ROOT}/src/main.ts:3:4)`,
    );
    expect(frames.map((frame) => frame.fn)).toEqual(['Repo', 'main']);
  });
});
