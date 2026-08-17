// The two rules that keep `docker/Dockerfile` producing an image that can start. The headline
// fixture is the Dockerfile AS IT SHIPPED — musl build base, glibc runtime, guard one stage too
// early — because a check that has never been shown to catch the bug it was written for is a check
// nobody can trust. Every case is a fixture string; the real Dockerfile is only ever read.

import { describe, expect, test } from 'bun:test';
import {
  argv0,
  checkImage,
  DOCKERFILE,
  imageGapFindingFor,
  imageGaps,
  libcOf,
  parseDockerfile,
} from './image-contract';
import { REPO_SCAN_TIMEOUT_MS, repoRoot } from './lib/run';

/** The shape of the real file, parameterised on the two things that were wrong. */
const dockerfile = (
  over: { build?: string; runtime?: string; guard?: 'build' | 'runtime' | 'none' } = {},
) => {
  const { build = 'oven/bun:1.3-slim', runtime = 'gcr.io/distroless/cc-debian13:nonroot' } = over;
  const guard = over.guard ?? 'runtime';
  return [
    '# syntax=docker/dockerfile:1',
    `FROM ${build} AS build`,
    'WORKDIR /src',
    'COPY . .',
    'RUN bun build --compile \\',
    '      --outfile /out/app \\',
    '      ./packages/cli/src/bin.ts',
    ...(guard === 'build' ? ['RUN ["/out/app", "--version"]'] : []),
    '',
    `FROM ${runtime} AS runtime`,
    'COPY --from=build /out/app /app/x',
    'USER nonroot:nonroot',
    ...(guard === 'runtime' ? ['RUN ["/app/x", "--version"]'] : []),
    'ENTRYPOINT ["/app/x"]',
    'CMD ["dev", "--once"]',
    '',
  ].join('\n');
};

const findings = (text: string) => checkImage(text).map(imageGapFindingFor);

describe('unit · the image that shipped dead on arrival', () => {
  test('both defects are caught, and neither needs docker to run', () => {
    const found = findings(dockerfile({ build: 'oven/bun:1.3-alpine', guard: 'build' }));

    expect(found.map((one) => one.code).sort()).toEqual([
      'X_IMAGE_GUARD_MISSING',
      'X_IMAGE_LIBC_MISMATCH',
    ]);
  });

  test('the libc finding names both sides and what the container does', () => {
    const found = findings(dockerfile({ build: 'oven/bun:1.3-alpine' }));

    expect(found).toHaveLength(1);
    expect(found[0]?.code).toBe('X_IMAGE_LIBC_MISMATCH');
    expect(found[0]?.cause).toContain('musl');
    expect(found[0]?.cause).toContain('glibc');
    expect(found[0]?.cause).toContain('no such file or directory');
    // The reason it was invisible: the build passed.
    expect(found[0]?.cause).toContain('build stays green');
    expect(found[0]?.at).toStartWith(`${DOCKERFILE}:`);
  });

  /**
   * The claim that was actually violated. A rule of the form "the Dockerfile contains a guard"
   * PASSES this input — the guard is right there, on the build stage — which is why "there is a
   * guard" and "the guard runs on what ships" are not the same rule and only the second is worth
   * having.
   */
  test('a guard in the build stage does not count as a guard', () => {
    const found = findings(dockerfile({ guard: 'build' }));

    expect(found).toHaveLength(1);
    expect(found[0]?.code).toBe('X_IMAGE_GUARD_MISSING');
    expect(found[0]?.cause).toContain('/app/x');
    expect(found[0]?.cause).toContain('not what ships');
    expect(found[0]?.fix).toContain('RUN ["/app/x", "--version"]');
    // …and the text does contain a `RUN [".../app --version"]`, one stage up.
    expect(dockerfile({ guard: 'build' })).toContain('--version');
  });

  test('no guard at all is the same finding', () => {
    expect(findings(dockerfile({ guard: 'none' })).map((one) => one.code)).toEqual([
      'X_IMAGE_GUARD_MISSING',
    ]);
  });

  test('the file as it stands today passes both rules', () => {
    expect(findings(dockerfile())).toEqual([]);
  });
});

describe('unit · what the rules refuse to guess', () => {
  test('an unrecognised base yields no finding — unknown is not broken', () => {
    // A checker that guessed here would fail on a correct Dockerfile, which is worse than none.
    expect(libcOf('scratch')).toBeUndefined();
    expect(libcOf('my-registry.internal/base:2026.1')).toBeUndefined();
    expect(findings(dockerfile({ build: 'my-registry.internal/base:2026.1' }))).toEqual([]);
  });

  test('the two families are read off the distribution, not off a version pin', () => {
    expect(libcOf('oven/bun:1.3-alpine')).toBe('musl');
    expect(libcOf('oven/bun:9.9-alpine')).toBe('musl');
    expect(libcOf('oven/bun:1.3-slim')).toBe('glibc');
    expect(libcOf('gcr.io/distroless/cc-debian13:nonroot')).toBe('glibc');
    // The generation is deliberately NOT compared: `oven/bun:1.3-slim` is trixie and says so
    // nowhere, so matching generations needs a table that fails on a correct file when bun rebases.
    expect(libcOf('gcr.io/distroless/cc-debian12')).toBe('glibc');
  });

  test('a stage with no ENTRYPOINT has nothing to guard', () => {
    const text = ['FROM oven/bun:1.3-slim AS build', 'RUN echo hi', ''].join('\n');
    expect(findings(text)).toEqual([]);
  });

  test('a COPY from an image rather than a stage is not a build stage', () => {
    const text = [
      'FROM gcr.io/distroless/cc-debian13 AS runtime',
      'COPY --from=alpine:3 /bin/busybox /app/x',
      'RUN ["/app/x", "--version"]',
      'ENTRYPOINT ["/app/x"]',
      '',
    ].join('\n');
    // `alpine:3` names no stage in this file, so there is no build stage to compare — and guessing
    // that an unresolved `--from` is an image whose libc must match would report a correct
    // multi-stage borrow as a defect.
    expect(findings(text)).toEqual([]);
  });
});

describe('unit · reading a Dockerfile', () => {
  test('a continued RUN is one instruction, not five unknown keywords', () => {
    const stages = parseDockerfile(dockerfile());
    const build = stages.find((one) => one.name === 'build');
    expect(build?.instructions.filter((one) => one.keyword === 'RUN')).toHaveLength(1);
    expect(build?.instructions.find((one) => one.keyword === 'RUN')?.value).toContain('bin.ts');
  });

  test('comments and blank lines are not instructions, and stages keep their order', () => {
    const stages = parseDockerfile(dockerfile());
    expect(stages.map((one) => one.name)).toEqual(['build', 'runtime']);
    expect(stages[0]?.instructions.some((one) => one.keyword.startsWith('#'))).toBe(false);
  });

  test('exec form and shell form both answer their program', () => {
    expect(argv0('["/app/x", "--version"]')).toBe('/app/x');
    expect(argv0('/app/x --version')).toBe('/app/x');
    // Shell form is accepted on purpose: a runtime that HAS a shell is not a defect, and demanding
    // exec form everywhere would report a correct Dockerfile. Distroless enforces it by failing.
    expect(argv0('[not json')).toBeUndefined();
  });

  test('a stage built FROM another stage resolves to the image underneath', () => {
    const text = [
      'FROM oven/bun:1.3-alpine AS base',
      'FROM base AS build',
      'RUN echo build',
      'FROM gcr.io/distroless/cc-debian13 AS runtime',
      'COPY --from=build /out/app /app/x',
      'RUN ["/app/x", "--version"]',
      'ENTRYPOINT ["/app/x"]',
      '',
    ].join('\n');
    expect(findings(text).map((one) => one.code)).toEqual(['X_IMAGE_LIBC_MISMATCH']);
  });
});

describe('unit · this repo', () => {
  test(
    'the shipped Dockerfile builds and ships one libc, and proves its entrypoint where it ships it',
    async () => {
      const root = repoRoot();
      const stages = parseDockerfile(await Bun.file(`${root}/${DOCKERFILE}`).text());
      // Vacuity guard: a parser that found no stages makes the assertion below meaningless.
      expect(stages.length).toBeGreaterThan(1);
      expect(await imageGaps(root)).toEqual([]);
    },
    REPO_SCAN_TIMEOUT_MS,
  );
});
