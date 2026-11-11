// One group for one fault: two throws from one line agree whatever row id their cause names, an
// edit above the throw keeps the group, and a report the function cannot read still yields a key.

import { describe, expect, test } from 'bun:test';
import { errorFingerprint, monitorFingerprint } from './error-fingerprint';
import { type ErrorReport, errorReport } from './error-reporter';
import { UltimateError } from './errors';

const ROOT = process.cwd();

function rowMissing(id: number): never {
  throw new UltimateError({ code: 'X_INTERNAL', cause: `row ${id} missing`, fix: 'x doctor' });
}

function otherFunction(): unknown {
  try {
    throw new UltimateError({ code: 'X_INTERNAL', cause: 'row 1 missing', fix: 'x doctor' });
  } catch (caught) {
    return caught;
  }
}

const caught = (fn: () => never): unknown => {
  try {
    fn();
  } catch (thrown) {
    return thrown;
  }
  return expect.unreachable('the probe did not throw');
};

/** A getter's throw: input to the code under test, never the test's verdict. */
const hostile = (field: string): UltimateError =>
  new UltimateError({ code: 'X_ROW_FIXTURE', cause: `${field} getter refused`, fix: 'x doctor' });

const reportOf = (error: unknown): ErrorReport => errorReport(error, { source: 'http' });

/** A hand-built report around a stack, so line numbers and paths are under the test's control. */
const withStack = (stack: string | undefined, code = 'X_INTERNAL'): ErrorReport => ({
  ...reportOf(new UltimateError({ code, cause: 'row 1 missing', fix: 'x doctor' })),
  code,
  stack,
});

const frame = (fn: string, path: string, line: number): string =>
  `Error: row missing\n    at ${fn} (${path}:${line}:9)\n    at main (${ROOT}/src/main.ts:3:1)`;

describe('errorFingerprint', () => {
  test("the probe's two throws, differing only in a row id, are one group", () => {
    const one = reportOf(caught(() => rowMissing(1)));
    const two = reportOf(caught(() => rowMissing(2)));
    expect(one.cause).not.toBe(two.cause);
    expect(errorFingerprint(one)).toBe(errorFingerprint(two));
    expect(errorFingerprint(one)).toMatch(/^[0-9a-f]{16}$/);
  });

  test('one extra line above the throw keeps the group', () => {
    const before = withStack(frame('loadRow', `${ROOT}/src/rows.ts`, 10));
    const after = withStack(frame('loadRow', `file://${ROOT}/src/rows.ts`, 11));
    expect(errorFingerprint(before)).toBe(errorFingerprint(after));
  });

  test('another function is another group', () => {
    expect(errorFingerprint(reportOf(caught(() => rowMissing(1))))).not.toBe(
      errorFingerprint(reportOf(otherFunction())),
    );
    expect(errorFingerprint(withStack(frame('loadRow', `${ROOT}/src/rows.ts`, 10)))).not.toBe(
      errorFingerprint(withStack(frame('saveRow', `${ROOT}/src/rows.ts`, 10))),
    );
  });

  test('another file is another group', () => {
    expect(errorFingerprint(withStack(frame('loadRow', `${ROOT}/src/rows.ts`, 10)))).not.toBe(
      errorFingerprint(withStack(frame('loadRow', `${ROOT}/src/cols.ts`, 10))),
    );
  });

  test('the working directory is not part of the group, so two pods agree', () => {
    const report = withStack(frame('loadRow', `${ROOT}/src/rows.ts`, 10));
    const relative = withStack(frame('loadRow', 'src/rows.ts', 10));
    expect(errorFingerprint(report)).toBe(errorFingerprint(relative));
  });

  test('another code is another group', () => {
    const stack = frame('loadRow', `${ROOT}/src/rows.ts`, 10);
    expect(errorFingerprint(withStack(stack, 'X_INTERNAL'))).not.toBe(
      errorFingerprint(withStack(stack, 'X_ROW_FIXTURE')),
    );
  });

  test('a coded error ignores its frame: the code already names the fault', () => {
    expect(
      errorFingerprint(withStack(frame('loadRow', `${ROOT}/src/rows.ts`, 10), 'X_ROW_FIXTURE')),
    ).toBe(errorFingerprint(withStack(frame('saveRow', `${ROOT}/src/b.ts`, 99), 'X_ROW_FIXTURE')));
  });

  test('source and operation are part of the group', () => {
    const base = withStack(undefined, 'X_ROW_FIXTURE');
    const job: ErrorReport = { ...base, source: 'job' };
    const route: ErrorReport = { ...base, scope: { ...base.scope, operation: 'GET /rows/:id' } };
    expect(errorFingerprint(base)).not.toBe(errorFingerprint(job));
    expect(errorFingerprint(base)).not.toBe(errorFingerprint(route));
  });

  test('cause, meta, ids and release are never inputs', () => {
    const base = withStack(undefined, 'X_ROW_FIXTURE');
    const noisy: ErrorReport = {
      ...base,
      cause: 'row 99 missing',
      meta: { id: 99 },
      release: 'build-next',
      scope: { ...base.scope, requestId: 'req-9', actorId: 'user-9', traceId: 'f'.repeat(32) },
    };
    expect(errorFingerprint(noisy)).toBe(errorFingerprint(base));
  });

  test('a node_modules or @ultimat3 top frame is skipped for the application frame', () => {
    const framework = [
      'Error: row missing',
      `    at decode (${ROOT}/node_modules/some-lib/index.js:1:1)`,
      `    at run (${ROOT}/node_modules/@ultimat3/entity/src/repo.ts:4:4)`,
      '    at map (native)',
      `    at loadRow (${ROOT}/src/rows.ts:10:9)`,
    ].join('\n');
    expect(errorFingerprint(withStack(framework))).toBe(
      errorFingerprint(withStack(frame('loadRow', `${ROOT}/src/rows.ts`, 10))),
    );
  });

  test('an async frame and an anonymous frame each have a stable spelling', () => {
    const asyncFrame = `Error\n    at async loadRow (${ROOT}/src/rows.ts:10:9)`;
    expect(errorFingerprint(withStack(asyncFrame))).toBe(
      errorFingerprint(withStack(frame('loadRow', `${ROOT}/src/rows.ts`, 12))),
    );
    const anonymous = `Error\n    at ${ROOT}/src/rows.ts:10:9`;
    expect(errorFingerprint(withStack(anonymous))).not.toBe(errorFingerprint(withStack(undefined)));
  });

  test('no stack, or one with no frame, gives the frameless key and does not throw', () => {
    const none = errorFingerprint(withStack(undefined));
    expect(none).toMatch(/^[0-9a-f]{16}$/);
    expect(errorFingerprint(withStack('Error: just a header'))).toBe(none);
    expect(errorFingerprint(withStack(''))).toBe(none);
  });

  test('a throwing getter anywhere on the report does not throw', () => {
    const base = withStack(undefined);
    const report = Object.defineProperties(
      { ...base },
      {
        stack: {
          get(): never {
            throw hostile('stack');
          },
        },
        scope: {
          get(): never {
            throw hostile('scope');
          },
        },
      },
    );
    expect(() => errorFingerprint(report)).not.toThrow();
    expect(errorFingerprint(report)).toBe(errorFingerprint(base));
  });
});

describe('errorFingerprint · frames, not the message', () => {
  const real = `    at load (${ROOT}/src/load.ts:4:2)`;

  test('a runtime frame with no file path (`native:7:39`) is skipped like `native`', () => {
    const runtime = withStack(
      `Error: boom\n    at processTicksAndRejections (native:7:39)\n${real}`,
    );
    expect(errorFingerprint(runtime)).toBe(errorFingerprint(withStack(`Error: boom\n${real}`)));
  });

  test('a message holding an `at` line never sets the group: frames are read after the header', () => {
    const forged = (fn: string): ErrorReport =>
      withStack(`Error: boom\n    at ${fn} (${ROOT}/src/${fn}.ts:1:1)\nand more text\n${real}`);
    expect(errorFingerprint(forged('one'))).toBe(errorFingerprint(forged('two')));
  });
});

describe('monitorFingerprint · the monitor groups on the code', () => {
  const coded = withStack(frame('loadRow', `${ROOT}/src/rows.ts`, 10), 'X_ROW_FIXTURE');

  test('a classified code is one issue: [code], whatever its operation, source or frame', () => {
    const operations = ['GET /a', 'GET /b', 'POST /c', 'job:sync', 'mcp:tool'].map(
      (operation): ErrorReport => ({ ...coded, scope: { ...coded.scope, operation } }),
    );
    const job: ErrorReport = { ...coded, source: 'job' };
    const other = withStack(frame('saveRow', `${ROOT}/src/b.ts`, 99), 'X_ROW_FIXTURE');
    for (const report of [...operations, job, other]) {
      expect(monitorFingerprint(report)).toEqual(['X_ROW_FIXTURE']);
    }
  });

  test('X_INTERNAL adds the application frame: function and root-relative path, no line', () => {
    expect(monitorFingerprint(withStack(frame('loadRow', `${ROOT}/src/rows.ts`, 10)))).toEqual([
      'X_INTERNAL',
      'loadRow src/rows.ts',
    ]);
    expect(monitorFingerprint(withStack(frame('loadRow', `${ROOT}/src/rows.ts`, 11)))).toEqual(
      monitorFingerprint(withStack(frame('loadRow', `${ROOT}/src/rows.ts`, 10))),
    );
    expect(monitorFingerprint(withStack(frame('saveRow', `${ROOT}/src/rows.ts`, 10)))).not.toEqual(
      monitorFingerprint(withStack(frame('loadRow', `${ROOT}/src/rows.ts`, 10))),
    );
  });

  test('X_INTERNAL with no application frame is [code]', () => {
    expect(monitorFingerprint(withStack(undefined))).toEqual(['X_INTERNAL']);
  });

  test("X_CLIENT_ERROR groups on its operation (route pattern + island), never the bundle's frame", () => {
    const browser = withStack(
      'Error\n    at f (https://app.example/_x/chunk-ab12.js:1:4096)',
      'X_CLIENT_ERROR',
    );
    const island = (operation: string): ErrorReport => ({
      ...browser,
      scope: { ...browser.scope, operation },
    });
    expect(monitorFingerprint(island('/posts/:id#comments'))).toEqual([
      'X_CLIENT_ERROR',
      '/posts/:id#comments',
    ]);
    expect(monitorFingerprint(island('/posts/:id#likes'))).not.toEqual(
      monitorFingerprint(island('/posts/:id#comments')),
    );
  });

  test('a throwing getter anywhere on the report does not throw', () => {
    const report = Object.defineProperties(
      { ...withStack(undefined) },
      {
        code: {
          get(): never {
            throw hostile('code');
          },
        },
        stack: {
          get(): never {
            throw hostile('stack');
          },
        },
      },
    );
    expect(monitorFingerprint(report)).toEqual(['X_INTERNAL']);
  });
});

describe('a file at the app root is an application frame', () => {
  const atRoot = (file: string): ErrorReport =>
    withStack(`Error: boom\n    at boot (${ROOT}/${file}:3:7)`);

  test('server.ts and main.ts stay two groups, with the keys they had before the frames split', () => {
    expect(errorFingerprint(atRoot('server.ts'))).toBe('48ac653443a57f0d');
    expect(errorFingerprint(atRoot('main.ts'))).toBe('b897a0b297c4bdf4');
    expect(monitorFingerprint(atRoot('server.ts'))).toEqual(['X_INTERNAL', 'boot server.ts']);
    expect(monitorFingerprint(atRoot('main.ts'))).toEqual(['X_INTERNAL', 'boot main.ts']);
  });
});
