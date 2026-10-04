// The enforcement half of `scripts/not-implemented-copies.ts`: this file IS the build error. The
// gate's `unit` step runs every `scripts/**/*.test.ts`, so a package that grows its own
// X_NOT_IMPLEMENTED constructor fails `bun run verify`. The real tree is asserted non-vacuously.

import { describe, expect, setDefaultTimeout, test } from 'bun:test';
import { render } from './lib/log';
import { REPO_SCAN_TIMEOUT_MS, repoRoot } from './lib/run';
import type { SourceFile } from './not-implemented-copies';
import {
  notImplementedCopiesResult,
  OWNER_PREFIX,
  readSources,
  scanNotImplementedCopies,
} from './not-implemented-copies';

setDefaultTimeout(REPO_SCAN_TIMEOUT_MS);

const CORE: SourceFile = {
  at: `${OWNER_PREFIX}errors.ts`,
  text: "export class NotImplementedError extends UltimateError {\n  static readonly code = 'X_NOT_IMPLEMENTED';\n}\n",
};

const codes = (files: readonly SourceFile[]): readonly string[] =>
  scanNotImplementedCopies(files).findings.map((finding) => finding.code);

describe('a local constructor is refused in every spelling', () => {
  test('a factory with a code: key', () => {
    const text =
      "export const dbNotImplemented = (feature: string, fix: string) =>\n  new DbError({ code: 'X_NOT_IMPLEMENTED', cause: feature, fix });\n";
    expect(codes([{ at: 'packages/db/src/errors.ts', text }])).toEqual(['X_NOT_IMPLEMENTED_COPY']);
  });

  test('a class with a static code', () => {
    const text =
      "export class NotImplementedError extends UltimateError {\n  static readonly code = 'X_NOT_IMPLEMENTED' as const;\n}\n";
    expect(codes([{ at: 'packages/pwa/src/errors.ts', text }])).toEqual(['X_NOT_IMPLEMENTED_COPY']);
  });

  test('a code held in a module const, under any file name', () => {
    const text =
      "const STUB = 'X_NOT_IMPLEMENTED';\nexport const stub = (fix: string) => new UltimateError({ code: STUB, cause: 'x', fix });\n";
    expect(codes([{ at: 'packages/jobs/src/driver-redis.ts', text }])).toEqual([
      'X_NOT_IMPLEMENTED_COPY',
    ]);
  });

  test('a copy behind a regex inside a template placeholder is still seen', () => {
    // The shape `admin/src/errors.ts` hid its copy behind: a `/^\//` inside a `${}` throws the
    // mask off its place, so the resolving scanner alone read straight past the next class.
    const text =
      // biome-ignore lint/suspicious/noTemplateCurlyInString: the input is source text — a literal ${…} is the case under test
      "export const a = (p: string) => new E({ code: 'X_A', cause: 'c', fix: `add ['${p.replace(/^\\//, '')}:read']` });\n" +
      "export class B extends UltimateError {\n  constructor() {\n    super({ code: 'X_NOT_IMPLEMENTED', cause: 'c', fix: 'f' });\n  }\n}\n";
    expect(codes([{ at: 'packages/admin/src/errors.ts', text }])).toEqual([
      'X_NOT_IMPLEMENTED_COPY',
    ]);
  });

  test('the finding names the file and line, and the call to paste there', () => {
    const text =
      "\n\nexport const x = new E({ code: 'X_NOT_IMPLEMENTED', cause: 'c', fix: 'f' });\n";
    const [finding] = scanNotImplementedCopies([{ at: 'packages/seo/src/a.ts', text }]).findings;
    expect(finding?.cause).toStartWith('packages/seo/src/a.ts:3 ');
    expect(finding?.fix).toStartWith('new NotImplementedError({ cause, fix })');
    expect(finding?.fix).toContain('thrown in packages/seo/src/a.ts ');
  });
});

describe('what is not a constructor is not refused', () => {
  test('core, the owner, is exempt and counted', () => {
    const scan = scanNotImplementedCopies([CORE]);
    expect(scan.findings).toEqual([]);
    expect(scan.ownerSites).toBe(1);
  });

  test("a registry's borrowed list names the code and raises nothing", () => {
    const text =
      "export const JOB_ERROR_TITLES = {};\nexport const JOB_BORROWED_ERROR_CODES = ['X_NOT_IMPLEMENTED', 'X_ABORTED'] as const;\n";
    expect(codes([{ at: 'packages/jobs/src/errors.ts', text }])).toEqual([]);
  });

  test("throwing core's helper, or core's class, is the one way", () => {
    const text =
      "import { notImplemented, NotImplementedError } from '@ultimat3/core';\nexport const a = () => notImplemented('x', 'y');\nexport const b = () => new NotImplementedError({ cause: 'x', fix: 'y' });\n";
    expect(codes([{ at: 'packages/db/src/a.ts', text }])).toEqual([]);
  });

  test('a code in a comment or a status map is not a construction', () => {
    const text =
      "// was: new E({ code: 'X_NOT_IMPLEMENTED' })\nexport const STATUS = { X_NOT_IMPLEMENTED: 501 };\n";
    expect(codes([{ at: 'packages/http/src/map.ts', text }])).toEqual([]);
  });
});

describe('a blind scan cannot read clean', () => {
  test('no owner site anywhere is its own finding', () => {
    const result = notImplementedCopiesResult([{ at: 'packages/x/src/a.ts', text: '' }]);
    expect(result.ok).toBe(false);
    expect(result.findings?.map((finding) => finding.code)).toEqual([
      'X_NOT_IMPLEMENTED_COPY_UNSCANNED',
    ]);
  });

  test('the --json document carries the findings', () => {
    const text = "export const x = new E({ code: 'X_NOT_IMPLEMENTED', cause: 'c', fix: 'f' });\n";
    const result = notImplementedCopiesResult([CORE, { at: 'packages/db/src/a.ts', text }]);
    const document = JSON.parse(render(result, true)) as { findings: { code: string }[] };
    expect(document.findings.map((finding) => finding.code)).toEqual(['X_NOT_IMPLEMENTED_COPY']);
  });
});

describe('the real tree', () => {
  test('constructs X_NOT_IMPLEMENTED in @ultimat3/core only', async () => {
    const result = notImplementedCopiesResult(await readSources(repoRoot()));
    expect(result.findings).toEqual([]);
    expect((result.data as { ownerSites: number }).ownerSites).toBeGreaterThanOrEqual(1);
  });
});
